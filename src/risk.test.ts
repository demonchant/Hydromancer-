import { describe, expect, it } from 'vitest'
import type { Position } from './hyperliquid'
import { evaluateAlertTransition, freshMarkPrices, nearestLiquidationDistance, positionLiquidationDistance } from './risk'

function position(coin: string, size: number, liquidationPrice: number | null): Position {
  return { coin, size, entryPrice: 0, markPrice: null, value: 0, pnl: 0, leverage: null, liquidationPrice }
}

describe('liquidation distance assessment', () => {
  it('calculates a long position distance using the live mark', () => {
    expect(nearestLiquidationDistance([position('BTC', 1, 90)], { BTC: 100 })).toEqual({
      status: 'available', distance: { coin: 'BTC', gap: 10, side: 'Long', mark: 100, liquidation: 90 },
    })
  })

  it('calculates a short position distance using the live mark', () => {
    expect(nearestLiquidationDistance([position('ETH', -1, 110)], { ETH: 100 })).toMatchObject({
      status: 'available', distance: { coin: 'ETH', gap: 10, side: 'Short' },
    })
  })

  it('selects the nearest position from multiple complete positions', () => {
    expect(nearestLiquidationDistance([
      position('BTC', 1, 90), position('ETH', -1, 105), position('SOL', 1, 80),
    ], { BTC: 100, ETH: 100, SOL: 100 })).toMatchObject({ status: 'available', distance: { coin: 'ETH', gap: 5 } })
  })

  it('preserves negative distance when the mark crosses liquidation', () => {
    expect(positionLiquidationDistance(position('BTC', 1, 110), 100)?.gap).toBe(-10)
    expect(positionLiquidationDistance(position('ETH', -1, 90), 100)?.gap).toBe(-10)
  })

  it('returns zero distance at the reported liquidation price', () => {
    expect(positionLiquidationDistance(position('BTC', 1, 100), 100)?.gap).toBe(0)
    expect(positionLiquidationDistance(position('ETH', -1, 100), 100)?.gap).toBe(0)
  })

  it('reports an explicit unavailable state for no open positions', () => {
    expect(nearestLiquidationDistance([], {})).toEqual({ status: 'unavailable', reason: 'no_positions', unavailableCoins: [] })
  })

  it.each([
    ['missing mark', position('BTC', 1, 90), undefined],
    ['missing liquidation', position('BTC', 1, null), 100],
    ['zero mark', position('BTC', 1, 90), 0],
    ['negative mark', position('BTC', 1, 90), -1],
    ['infinite mark', position('BTC', 1, 90), Number.POSITIVE_INFINITY],
    ['NaN mark', position('BTC', 1, 90), Number.NaN],
  ])('marks %s unavailable', (_case, pos, mark) => {
    expect(positionLiquidationDistance(pos, mark)).toBeNull()
    const assessment = nearestLiquidationDistance([pos], mark === undefined ? {} : { [pos.coin]: mark })
    expect(assessment.status).toBe('unavailable')
  })

  it('does not rank complete positions when another open position is incomplete', () => {
    expect(nearestLiquidationDistance([
      position('BTC', 1, 90), position('ETH', -1, null),
    ], { BTC: 100, ETH: 100 })).toEqual({ status: 'unavailable', reason: 'incomplete_positions', unavailableCoins: ['ETH'] })
  })

  it.each([
    ['zero liquidation', position('BTC', 1, 0), 100],
    ['negative liquidation', position('BTC', 1, -1), 100],
    ['infinite liquidation', position('BTC', 1, Number.POSITIVE_INFINITY), 100],
    ['NaN liquidation', position('BTC', 1, Number.NaN), 100],
    ['zero size', position('BTC', 0, 90), 100],
    ['infinite size', position('BTC', Number.POSITIVE_INFINITY, 90), 100],
    ['malformed runtime mark', position('BTC', 1, 90), '100' as unknown as number],
  ])('rejects %s without coercing it into a distance', (_case, pos, mark) => {
    expect(positionLiquidationDistance(pos, mark)).toBeNull()
  })

  it('excludes stale and future mark observations while keeping a fresh quote', () => {
    const marks = freshMarkPrices({
      BTC: { price: 100, receivedAt: 70000 },
      ETH: { price: 100, receivedAt: 69999 },
      SOL: { price: 100, receivedAt: 100001 },
    }, 100000)
    expect(marks).toEqual({ BTC: 100 })
    expect(nearestLiquidationDistance([position('ETH', 1, 90)], marks)).toMatchObject({ status: 'unavailable', reason: 'incomplete_positions' })
    expect(nearestLiquidationDistance([position('BTC', 1, 90)], marks).status).toBe('available')
  })
})

describe('warning and recovery lifecycle', () => {
  it('creates a single warning on crossing and does not repeat it while warning', () => {
    const warning = evaluateAlertTransition(false, 8, 8)
    expect(warning).toEqual({ kind: 'warning', inWarning: true })
    expect(evaluateAlertTransition(warning.inWarning, 4, 8)).toEqual({ kind: null, inWarning: true })
  })

  it('recovers only above the threshold plus the existing two point buffer', () => {
    expect(evaluateAlertTransition(true, 10, 8)).toEqual({ kind: null, inWarning: true })
    expect(evaluateAlertTransition(true, 10.01, 8)).toEqual({ kind: 'recovery', inWarning: false })
  })

  it('allows a new warning after a completed recovery', () => {
    const recovered = evaluateAlertTransition(true, 11, 8)
    expect(recovered.kind).toBe('recovery')
    expect(evaluateAlertTransition(recovered.inWarning, 8, 8)).toEqual({ kind: 'warning', inWarning: true })
  })

  it('does not change alert state or emit an event for missing or stale risk data', () => {
    expect(evaluateAlertTransition(true, null, 8)).toEqual({ kind: null, inWarning: true })
    expect(evaluateAlertTransition(false, Number.NaN, 8)).toEqual({ kind: null, inWarning: false })
  })
})
