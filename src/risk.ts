import type { Position } from './hyperliquid'

export type LiquidationDistance = {
  coin: string
  gap: number
  mark: number
  liquidation: number
  side: 'Long' | 'Short'
}

export function nearestLiquidationDistance(
  positions: Position[],
  mids: Record<string, number>,
): LiquidationDistance | null {
  const distances = positions.flatMap((position): LiquidationDistance[] => {
    const mark = mids[position.coin]
    const liquidation = position.liquidationPrice
    if (!mark || liquidation === null || mark <= 0 || liquidation <= 0) return []
    const gap = position.size > 0
      ? ((mark - liquidation) / mark) * 100
      : ((liquidation - mark) / mark) * 100
    return Number.isFinite(gap)
      ? [{ coin: position.coin, gap, mark, liquidation, side: position.size > 0 ? 'Long' : 'Short' }]
      : []
  })
  distances.sort((a, b) => a.gap - b.gap)
  return distances[0] ?? null
}
