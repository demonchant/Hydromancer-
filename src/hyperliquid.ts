export type Position = {
  coin: string
  size: number
  entryPrice: number | null
  markPrice: number | null
  value: number | null
  pnl: number | null
  leverage: number | null
  liquidationPrice: number | null
}

export type AccountSnapshot = {
  address: string
  accountValue: number
  maintenanceMargin: number
  withdrawable: number
  positions: Position[]
  receivedAt: number
}

export type MarkPriceQuote = { price: number; receivedAt: number }

const API = 'https://api.hyperliquid.xyz/info'
const WS = 'wss://api.hyperliquid.xyz/ws'

async function info<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const requestSignal = signal ?? AbortSignal.timeout(12000)
  const response = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: requestSignal,
  })
  if (!response.ok) throw new Error(`Hyperliquid returned ${response.status}. Try again shortly.`)
  return response.json() as Promise<T>
}

type RawPosition = {
  position?: {
    coin?: string
    szi?: string
    entryPx?: string | null
    positionValue?: string
    unrealizedPnl?: string
    leverage?: { value?: number }
    liquidationPx?: string | null
  }
}

type RawState = {
  marginSummary?: { accountValue?: string }
  crossMarginSummary?: { accountValue?: string }
  crossMaintenanceMarginUsed?: string
  withdrawable?: string
  assetPositions?: RawPosition[]
}

type RawPerpMetaAndContexts = [
  { universe?: Array<{ name?: string }> },
  Array<{ markPx?: string | number }>,
]

export async function fetchAccount(address: string, signal?: AbortSignal): Promise<AccountSnapshot> {
  const raw = await info<RawState>({ type: 'clearinghouseState', user: address }, signal)
  const margin = raw.crossMarginSummary ?? raw.marginSummary
  const accountValue = Number(margin?.accountValue)
  const maintenanceMargin = Number(raw.crossMaintenanceMarginUsed)
  const withdrawable = Number(raw.withdrawable)
  if (!Number.isFinite(accountValue) || !Number.isFinite(maintenanceMargin)) {
    throw new Error('Hyperliquid returned incomplete margin data for this address.')
  }
  const positions = (raw.assetPositions ?? []).flatMap(({ position }): Position[] => {
    if (!position?.coin) return []
    const size = Number(position.szi)
    if (!Number.isFinite(size) || size === 0) return []
    const n = (value: string | null | undefined) => {
      const parsed = Number(value)
      return value !== undefined && value !== null && value !== '' && Number.isFinite(parsed) ? parsed : null
    }
    const leverage = position.leverage?.value
    return [{
      coin: position.coin,
      size,
      entryPrice: n(position.entryPx),
      markPrice: null,
      value: n(position.positionValue),
      pnl: n(position.unrealizedPnl),
      leverage: leverage !== undefined && Number.isFinite(leverage) ? leverage : null,
      liquidationPrice: position.liquidationPx ? n(position.liquidationPx) : null,
    }]
  })
  return {
    address,
    accountValue,
    maintenanceMargin,
    withdrawable: Number.isFinite(withdrawable) ? withdrawable : 0,
    positions,
    receivedAt: Date.now(),
  }
}

export async function fetchMids(signal?: AbortSignal): Promise<Record<string, number>> {
  const raw = await info<Record<string, string>>({ type: 'allMids' }, signal)
  return Object.fromEntries(Object.entries(raw).flatMap(([coin, value]) => {
    const price = Number(value)
    return Number.isFinite(price) ? [[coin, price]] : []
  }))
}

export async function fetchMarkPrices(signal?: AbortSignal): Promise<Record<string, MarkPriceQuote>> {
  const [meta, contexts] = await info<RawPerpMetaAndContexts>({ type: 'metaAndAssetCtxs' }, signal)
  if (!Array.isArray(meta?.universe) || !Array.isArray(contexts)) {
    throw new Error('Hyperliquid returned an invalid mark price snapshot.')
  }
  const receivedAt = Date.now()
  const prices = Object.fromEntries(meta.universe.flatMap((asset, index) => {
    const coin = asset.name
    const price = Number(contexts[index]?.markPx)
    return coin && Number.isFinite(price) && price > 0 ? [[coin, { price, receivedAt } satisfies MarkPriceQuote]] : []
  }))
  if (!Object.keys(prices).length) throw new Error('Hyperliquid did not return any valid mark prices.')
  return prices
}

export function connectMids(
  onMids: (mids: Record<string, number>) => void,
  onStatus: (status: 'connecting' | 'live' | 'reconnecting') => void,
): () => void {
  let socket: WebSocket | undefined
  let stopped = false
  let retry = 0
  let timer: number | undefined
  let lastOpenedAt = 0
  const start = () => {
    if (stopped) return
    onStatus(retry === 0 ? 'connecting' : 'reconnecting')
    lastOpenedAt = 0
    socket = new WebSocket(WS)
    socket.onopen = () => {
      lastOpenedAt = Date.now()
      onStatus('live')
      socket?.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }))
    }
    socket.onmessage = (event) => {
      try {
        const packet = JSON.parse(String(event.data)) as { channel?: string; data?: { mids?: Record<string, string> } }
        if (packet.channel !== 'allMids' || !packet.data?.mids) return
        onMids(Object.fromEntries(Object.entries(packet.data.mids).flatMap(([coin, value]) => {
          const price = Number(value)
          return Number.isFinite(price) ? [[coin, price]] : []
        })))
      } catch { /* Ignore malformed frames and keep the connection visible. */ }
    }
    socket.onerror = () => socket?.close()
    socket.onclose = () => {
      if (stopped) return
      if (lastOpenedAt && Date.now() - lastOpenedAt >= 30000) retry = 0
      const delay = Math.min(1000 * 2 ** Math.min(retry, 5), 30000)
      retry += 1
      onStatus('reconnecting')
      timer = window.setTimeout(start, delay)
    }
  }
  start()
  return () => {
    stopped = true
    if (timer) window.clearTimeout(timer)
    socket?.close()
  }
}

export function connectMarkPrices(
  onPrice: (coin: string, quote: MarkPriceQuote) => void,
  onStatus: (status: 'connecting' | 'live' | 'reconnecting') => void,
): { setCoins: (coins: string[]) => void; stop: () => void } {
  let socket: WebSocket | undefined
  let stopped = false
  let retry = 0
  let timer: number | undefined
  let lastOpenedAt = 0
  let desired = new Set<string>()
  let subscribed = new Set<string>()

  const send = (method: 'subscribe' | 'unsubscribe', coin: string) => {
    socket?.send(JSON.stringify({ method, subscription: { type: 'activeAssetCtx', coin } }))
  }
  const start = () => {
    if (stopped || !desired.size) return
    onStatus(retry === 0 ? 'connecting' : 'reconnecting')
    lastOpenedAt = 0
    const connection = new WebSocket(WS)
    socket = connection
    connection.onopen = () => {
      if (socket !== connection || stopped) return
      lastOpenedAt = Date.now()
      onStatus('live')
      subscribed.clear()
      for (const coin of desired) {
        send('subscribe', coin)
        subscribed.add(coin)
      }
    }
    connection.onmessage = (event) => {
      if (socket !== connection || stopped) return
      try {
        const packet = JSON.parse(String(event.data)) as {
          channel?: string
          data?: { coin?: string; ctx?: { markPx?: string | number } }
        }
        const coin = packet.data?.coin
        const price = Number(packet.data?.ctx?.markPx)
        if (packet.channel === 'activeAssetCtx' && coin && desired.has(coin) && Number.isFinite(price) && price > 0) {
          onPrice(coin, { price, receivedAt: Date.now() })
        }
      } catch { /* Ignore malformed frames and keep the feed status visible. */ }
    }
    connection.onerror = () => connection.close()
    connection.onclose = () => {
      if (socket !== connection || stopped) return
      socket = undefined
      subscribed.clear()
      if (lastOpenedAt && Date.now() - lastOpenedAt >= 30000) retry = 0
      const delay = Math.min(1000 * 2 ** Math.min(retry, 5), 30000)
      retry += 1
      onStatus('reconnecting')
      timer = window.setTimeout(start, delay)
    }
  }
  const setCoins = (coins: string[]) => {
    const next = new Set(coins.filter(Boolean))
    if (next.size === desired.size && [...next].every((coin) => desired.has(coin))) return
    desired = next
    if (!desired.size) {
      if (timer) window.clearTimeout(timer)
      const previous = socket
      socket = undefined
      previous?.close()
      subscribed.clear()
      onStatus('connecting')
      return
    }
    if (socket?.readyState === WebSocket.OPEN) {
      for (const coin of subscribed) if (!desired.has(coin)) { send('unsubscribe', coin); subscribed.delete(coin) }
      for (const coin of desired) if (!subscribed.has(coin)) { send('subscribe', coin); subscribed.add(coin) }
    } else if (!socket || socket.readyState === WebSocket.CLOSED) {
      if (timer) window.clearTimeout(timer)
      start()
    }
  }
  const stop = () => {
    stopped = true
    if (timer) window.clearTimeout(timer)
    socket?.close()
    subscribed.clear()
  }
  return { setCoins, stop }
}

export function validAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address.trim())
}
