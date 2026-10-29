export type ProcurementAmountDifference = {
  fingerprint: string
  fields: Array<'采购金额' | '销售金额'>
  publishedCostCents: number
  publishedSalesCents: number
  currentCostCents: number | null
  currentSalesCents: number | null
}

function cents(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function procurementAmountDifference(
  published: { costAmount?: number; salesAmount?: number },
  order: Record<string, unknown>
): ProcurementAmountDifference | null {
  const publishedCostCents = Math.round((published.costAmount ?? NaN) * 100)
  const publishedSalesCents = Math.round((published.salesAmount ?? NaN) * 100)
  if (!Number.isSafeInteger(publishedCostCents) || !Number.isSafeInteger(publishedSalesCents)) return null
  const currentCostCents = cents(order.totalCostPrice)
  const transactionCents = cents(order.totalTransactionPrice)
  const currentSalesCents = transactionCents && transactionCents > 0
    ? transactionCents : cents(order.totalSellingPrice)
  if (currentCostCents === null || currentSalesCents === null) return null
  const fields: ProcurementAmountDifference['fields'] = []
  if (currentCostCents !== publishedCostCents) fields.push('采购金额')
  if (currentSalesCents !== publishedSalesCents) fields.push('销售金额')
  if (fields.length === 0) return null
  return { fingerprint: JSON.stringify([currentCostCents, currentSalesCents]), fields,
    publishedCostCents, publishedSalesCents, currentCostCents, currentSalesCents }
}
