import { describe, expect, it } from 'vitest'
import type { Position } from './hyperliquid'
import { nearestLiquidationDistance } from './risk'

function position(coin: string, size: number, liquidationPrice: number | null): Position {
  return { coin, size, entryPrice: 0, markPrice: null, value: 0, pnl: 0, leverage: null, liquidationPrice }
}

describe('nearest liquidation distance', () => {
  it('uses the distance from a live mark to a long liquidation level', () => {
    expect(nearestLiquidationDistance([position('BTC', 1, 90)], { BTC: 100 })).toMatchObject({ coin: 'BTC', gap: 10, side: 'Long' })
  })

  it('uses the distance from a live mark to a short liquidation level', () => {
    expect(nearestLiquidationDistance([position('ETH', -1, 110)], { ETH: 100 })).toMatchObject({ coin: 'ETH', gap: 10, side: 'Short' })
  })

  it('returns the closest position and preserves a crossed level as a negative distance', () => {
    expect(nearestLiquidationDistance([position('BTC', 1, 110), position('ETH', -1, 120)], { BTC: 100, ETH: 100 })).toMatchObject({ coin: 'BTC', gap: -10 })
  })

  it('does not invent a distance when live inputs are missing', () => {
    expect(nearestLiquidationDistance([position('BTC', 1, null)], { BTC: 100 })).toBeNull()
    expect(nearestLiquidationDistance([position('BTC', 1, 90)], {})).toBeNull()
    expect(nearestLiquidationDistance([], {})).toBeNull()
  })
})
