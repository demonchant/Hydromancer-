export type Position = {
  coin: string
  size: number
  entryPrice: number
  markPrice: number | null
  value: number
  pnl: number
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
      return Number.isFinite(parsed) ? parsed : 0
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

export function connectMids(
  onMids: (mids: Record<string, number>) => void,
  onStatus: (status: 'connecting' | 'live' | 'reconnecting') => void,
): () => void {
  let socket: WebSocket | undefined
  let stopped = false
  let retry = 0
  let timer: number | undefined
  const start = () => {
    if (stopped) return
    onStatus(retry === 0 ? 'connecting' : 'reconnecting')
    socket = new WebSocket(WS)
    socket.onopen = () => {
      retry = 0
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
      retry += 1
      onStatus('reconnecting')
      timer = window.setTimeout(start, Math.min(1000 * 2 ** Math.min(retry, 5), 30000))
    }
  }
  start()
  return () => {
    stopped = true
    if (timer) window.clearTimeout(timer)
    socket?.close()
  }
}

export function validAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address.trim())
}
