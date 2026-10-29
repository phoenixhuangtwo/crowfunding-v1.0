type EstimateInput = {
  salesAmount?: number
  costAmount?: number
  totalShares?: number
  shares?: number
}

function yuanToCents(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null
  const cents = Math.round(value * 100)
  return Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) < 0.000001 ? cents : null
}

/** Estimate only. Actual distribution must use confirmed receipts and costs. */
export function estimateShareProfit(input: EstimateInput): number | null {
  const salesCents = yuanToCents(input.salesAmount)
  const costCents = yuanToCents(input.costAmount)
  const totalShares = input.totalShares
  const shares = input.shares
  if (salesCents === null || costCents === null || salesCents < costCents
    || !Number.isSafeInteger(totalShares) || !Number.isSafeInteger(shares)
    || totalShares === undefined || shares === undefined || totalShares <= 0 || shares < 0 || shares > totalShares) return null
  const profitCents = salesCents - costCents
  return Number(BigInt(profitCents) * BigInt(shares) / BigInt(totalShares)) / 100
}
