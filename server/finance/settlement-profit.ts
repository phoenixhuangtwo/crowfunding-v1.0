export type SettlementProfitInput = {
  receivableCents: number
  customerReceiptsCents: number
  companyTopUpsCents: number
  companyReturnsCents: number
  procurementPaymentsCents: number
  confirmedCostsCents: number
}

/** A read-only preview. These values must be supplied from independently verified records. */
export function calculateSettlementProfit(input: SettlementProfitInput) {
  const fields = [
    input.receivableCents,
    input.customerReceiptsCents,
    input.companyTopUpsCents,
    input.companyReturnsCents,
    input.procurementPaymentsCents,
    input.confirmedCostsCents
  ]
  if (fields.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError('所有金额必须明确填写为非负整数分')
  }
  if (input.receivableCents === 0) throw new RangeError('应收金额必须大于 0')
  if (input.companyReturnsCents > input.companyTopUpsCents) throw new RangeError('补款返还不能超过公司补款')
  const netReceipts = BigInt(input.customerReceiptsCents) + BigInt(input.companyTopUpsCents) - BigInt(input.companyReturnsCents)
  const undistributedDifference = netReceipts > BigInt(input.receivableCents) ? netReceipts - BigInt(input.receivableCents) : 0n
  const distributable = netReceipts - undistributedDifference
  const profit = distributable - BigInt(input.procurementPaymentsCents) - BigInt(input.confirmedCostsCents)
  if (profit > BigInt(Number.MAX_SAFE_INTEGER) || profit < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('试算结果超出安全金额范围')
  }
  if (netReceipts > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('回款合计超出安全金额范围')
  return {
    ...input,
    netReceiptsCents: Number(netReceipts),
    undistributedDifferenceCents: Number(undistributedDifference),
    distributableCents: Number(distributable),
    profitCents: Number(profit), previewOnly: true as const
  }
}
