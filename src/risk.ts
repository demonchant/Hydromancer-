import type { Position } from './hyperliquid'

export type LiquidationDistance = {
  coin: string
  gap: number
  mark: number
  liquidation: number
  side: 'Long' | 'Short'
}

export function positionLiquidationDistance(
  position: Position,
  markPrice: number | undefined,
): LiquidationDistance | null {
  const liquidation = position.liquidationPrice
  if (!markPrice || liquidation === null || markPrice <= 0 || liquidation <= 0 || !Number.isFinite(markPrice)) return null
  const gap = position.size > 0
    ? ((markPrice - liquidation) / markPrice) * 100
    : ((liquidation - markPrice) / markPrice) * 100
  return Number.isFinite(gap)
    ? { coin: position.coin, gap, mark: markPrice, liquidation, side: position.size > 0 ? 'Long' : 'Short' }
    : null
}

export function nearestLiquidationDistance(
  positions: Position[],
  markPrices: Record<string, number>,
): LiquidationDistance | null {
  const distances = positions.flatMap((position): LiquidationDistance[] => {
    const distance = positionLiquidationDistance(position, markPrices[position.coin])
    return distance ? [distance] : []
  })
  distances.sort((a, b) => a.gap - b.gap)
  return distances[0] ?? null
}
