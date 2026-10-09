export type RiskPosition = {
  coin: string
  size: number
  liquidationPrice: number | null
}

export type RiskMarkPriceQuote = { price: number; receivedAt: number }

export type LiquidationDistance = {
  coin: string
  gap: number
  mark: number
  liquidation: number
  side: 'Long' | 'Short'
}

export type RiskAssessment =
  | { status: 'available'; distance: LiquidationDistance }
  | { status: 'unavailable'; reason: 'no_positions' | 'incomplete_positions'; unavailableCoins: string[] }

export type AlertTransition = { kind: 'warning' | 'recovery'; inWarning: boolean } | { kind: null; inWarning: boolean }

export function freshMarkPrices(quotes: Record<string, RiskMarkPriceQuote>, now: number, maxAgeMs = 30000): Record<string, number> {
  return Object.fromEntries(Object.entries(quotes).flatMap(([coin, quote]) => {
    const age = now - quote.receivedAt
    return Number.isFinite(quote.price) && quote.price > 0 && Number.isFinite(age) && age >= 0 && age <= maxAgeMs
      ? [[coin, quote.price]]
      : []
  }))
}

export function evaluateAlertTransition(inWarning: boolean, gap: number | null, threshold: number): AlertTransition {
  if (gap === null || !Number.isFinite(gap) || !Number.isFinite(threshold)) return { kind: null, inWarning }
  if (!inWarning && gap <= threshold) return { kind: 'warning', inWarning: true }
  if (inWarning && gap > threshold + 2) return { kind: 'recovery', inWarning: false }
  return { kind: null, inWarning }
}

export function positionLiquidationDistance(
  position: RiskPosition,
  markPrice: number | undefined,
): LiquidationDistance | null {
  const { size, liquidationPrice: liquidation } = position
  if (typeof size !== 'number' || !Number.isFinite(size) || size === 0) return null
  if (typeof markPrice !== 'number' || !Number.isFinite(markPrice) || markPrice <= 0) return null
  if (typeof liquidation !== 'number' || !Number.isFinite(liquidation) || liquidation <= 0) return null
  const gap = size > 0
    ? ((markPrice - liquidation) / markPrice) * 100
    : ((liquidation - markPrice) / markPrice) * 100
  return Number.isFinite(gap)
    ? { coin: position.coin, gap, mark: markPrice, liquidation, side: size > 0 ? 'Long' : 'Short' }
    : null
}

export function nearestLiquidationDistance(
  positions: RiskPosition[],
  markPrices: Record<string, number | undefined>,
): RiskAssessment {
  if (positions.length === 0) return { status: 'unavailable', reason: 'no_positions', unavailableCoins: [] }

  const distances: LiquidationDistance[] = []
  const unavailableCoins: string[] = []
  for (const position of positions) {
    const distance = positionLiquidationDistance(position, markPrices[position.coin])
    if (distance) distances.push(distance)
    else unavailableCoins.push(position.coin || 'Unknown position')
  }
  if (unavailableCoins.length > 0) {
    return { status: 'unavailable', reason: 'incomplete_positions', unavailableCoins }
  }
  distances.sort((a, b) => a.gap - b.gap)
  const distance = distances[0]
  return distance
    ? { status: 'available', distance }
    : { status: 'unavailable', reason: 'incomplete_positions', unavailableCoins: ['Unknown position'] }
}
