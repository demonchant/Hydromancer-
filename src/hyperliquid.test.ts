import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectMarkPrices, fetchAccount, fetchMarkPrices, fetchMids } from './hyperliquid'

const originalFetch = globalThis.fetch
afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = originalFetch
})

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('Hyperliquid HTTP integration parsing', () => {
  it('parses account margin and active long and short positions from a controlled response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({
      crossMarginSummary: { accountValue: '1200' },
      crossMaintenanceMarginUsed: '75',
      withdrawable: '1000',
      assetPositions: [
        { position: { coin: 'BTC', szi: '0.2', entryPx: '95000', positionValue: '19000', unrealizedPnl: '200', leverage: { value: 3 }, liquidationPx: '80000' } },
        { position: { coin: 'ETH', szi: '-1', entryPx: '3000', positionValue: '3000', unrealizedPnl: '-20', leverage: { value: 2 }, liquidationPx: '3500' } },
      ],
    })) as typeof fetch
    const account = await fetchAccount(`0x${'a'.repeat(40)}`)
    expect(account.positions).toHaveLength(2)
    expect(account.positions[0]).toMatchObject({ coin: 'BTC', size: 0.2, liquidationPrice: 80000, markPrice: null })
    expect(account.positions[1]).toMatchObject({ coin: 'ETH', size: -1, liquidationPrice: 3500 })
    expect(account.receivedAt).toBeTypeOf('number')
  })

  it('accepts an empty position list and rejects a missing or malformed position list', async () => {
    const response = { marginSummary: { accountValue: '0' }, crossMaintenanceMarginUsed: '0', withdrawable: '0' }
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockResponse({ ...response, assetPositions: [] })) as typeof fetch
    await expect(fetchAccount(`0x${'b'.repeat(40)}`)).resolves.toMatchObject({ positions: [] })
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(response)) as typeof fetch
    await expect(fetchAccount(`0x${'b'.repeat(40)}`)).rejects.toThrow('invalid position list')
  })

  it('rejects malformed active position sizes instead of silently dropping them', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({
      marginSummary: { accountValue: '100' }, crossMaintenanceMarginUsed: '5',
      assetPositions: [{ position: { coin: 'BTC', szi: 'not-a-size', liquidationPx: '90' } }],
    })) as typeof fetch
    await expect(fetchAccount(`0x${'c'.repeat(40)}`)).rejects.toThrow('invalid size for BTC')
  })

  it('rejects incomplete account margin and HTTP errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ assetPositions: [] })) as typeof fetch
    await expect(fetchAccount(`0x${'d'.repeat(40)}`)).rejects.toThrow('incomplete margin data')
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({}, 503)) as typeof fetch
    await expect(fetchMids()).rejects.toThrow('returned 503')
  })

  it('parses valid mark contexts and omits invalid, zero, and missing prices', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse([
      { universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }, { name: 'XRP' }] },
      [{ markPx: '100' }, { markPx: 'bad' }, { markPx: '0' }],
    ])) as typeof fetch
    const marks = await fetchMarkPrices()
    expect(marks.BTC.price).toBe(100)
    expect(marks.BTC.receivedAt).toBeTypeOf('number')
    expect(marks).not.toHaveProperty('ETH')
    expect(marks).not.toHaveProperty('SOL')
    expect(marks).not.toHaveProperty('XRP')
  })

  it('rejects malformed or wholly invalid market context responses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockResponse({})) as typeof fetch
    await expect(fetchMarkPrices()).rejects.toThrow('invalid mark price snapshot')
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockResponse([{ universe: [{ name: 'BTC' }] }, [{ markPx: 'NaN' }]])) as typeof fetch
    await expect(fetchMarkPrices()).rejects.toThrow('did not return any valid mark prices')
  })

  it('propagates an aborted request without converting it into market data', async () => {
    const controller = new AbortController()
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')) as typeof fetch
    await expect(fetchMids(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('Hyperliquid mark WebSocket integration', () => {
  class MockSocket {
    static OPEN = 1
    static CLOSED = 3
    readyState = 0
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    sent: string[] = []
    send(value: string) { this.sent.push(value) }
    open() { this.readyState = MockSocket.OPEN; this.onopen?.() }
    message(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }) }
    close() { this.readyState = MockSocket.CLOSED; this.onclose?.() }
  }

  it('ignores malformed frames and reconnects and resubscribes after a disconnect', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    vi.stubGlobal('WebSocket', MockSocket)
    const sockets: MockSocket[] = []
    const status = vi.fn()
    const received = vi.fn()
    vi.stubGlobal('WebSocket', class extends MockSocket {
      constructor() { super(); sockets.push(this) }
    })
    const feed = connectMarkPrices(received, status)
    feed.setCoins(['BTC'])
    sockets[0].open()
    expect(sockets[0].sent).toHaveLength(1)
    sockets[0].message({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: 'bad' } } })
    sockets[0].message({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: '100' } } })
    expect(received).toHaveBeenCalledWith('BTC', expect.objectContaining({ price: 100 }))
    sockets[0].close()
    expect(status).toHaveBeenLastCalledWith('reconnecting')
    vi.advanceTimersByTime(1000)
    sockets[1].open()
    expect(sockets[1].sent).toHaveLength(1)
    expect(status).toHaveBeenLastCalledWith('live')
    feed.stop()
    vi.unstubAllGlobals()
  })
})
