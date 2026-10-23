export type SettlementProfitInput = {
  customerReceiptsCents: number
  companyTopUpsCents: number
  procurementPaymentsCents: number
  confirmedCostsCents: number
}

/** A read-only preview. These values must be supplied from independently verified records. */
export function calculateSettlementProfit(input: SettlementProfitInput) {
  const fields = [
    input.customerReceiptsCents,
    input.companyTopUpsCents,
    input.procurementPaymentsCents,
    input.confirmedCostsCents
  ]
  if (fields.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError('四项金额必须明确填写为非负整数分')
  }
  const profit = BigInt(input.customerReceiptsCents) + BigInt(input.companyTopUpsCents)
    - BigInt(input.procurementPaymentsCents) - BigInt(input.confirmedCostsCents)
  if (profit > BigInt(Number.MAX_SAFE_INTEGER) || profit < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('试算结果超出安全金额范围')
  }
  return { ...input, profitCents: Number(profit), previewOnly: true as const }
}
