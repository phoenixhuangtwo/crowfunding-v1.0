export type FinancialReconciliationInput = {
  purchaseCents: number
  approvedEmployeeCents: number
  confirmedCompanyCents: number
  procurementPaymentCents: number
  receivableCents: number
  distributableReceiptsCents: number
  unresolvedReceiptDifferenceCents: number
  confirmedCostsCents: number
  confirmedCostLedgerCents: number
  orderStatus?: string
  orderPayoutTotalCents?: number
  orderLinesCents?: number
  payoutLedgerCents: number
  unprocessedExceptionCents: number
}

export function reconcileProjectFinancials(input: FinancialReconciliationInput) {
  for (const [name, value] of Object.entries(input)) {
    if (name === 'orderStatus' || value === undefined) continue
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new RangeError(`${name}须为非负整数分`)
  }
  const fundingDifferenceCents = input.approvedEmployeeCents + input.confirmedCompanyCents - input.purchaseCents
  const purchaseDifferenceCents = input.procurementPaymentCents - input.purchaseCents
  const receiptGapCents = Math.max(0, input.receivableCents - input.distributableReceiptsCents)
  const costLedgerDifferenceCents = input.confirmedCostLedgerCents - input.confirmedCostsCents
  const expectedPayoutCents = input.receivableCents - input.confirmedCostsCents
  const distributionDifferenceCents = (input.orderPayoutTotalCents ?? 0) - expectedPayoutCents
  const lineDifferenceCents = (input.orderLinesCents ?? 0) - (input.orderPayoutTotalCents ?? 0)
  const payoutDifferenceCents = input.payoutLedgerCents - (input.orderPayoutTotalCents ?? 0)
  const ready = input.orderStatus === '可结单' && input.orderPayoutTotalCents !== undefined
    && fundingDifferenceCents === 0 && purchaseDifferenceCents === 0 && receiptGapCents === 0
    && input.unresolvedReceiptDifferenceCents === 0 && costLedgerDifferenceCents === 0
    && distributionDifferenceCents === 0 && lineDifferenceCents === 0 && payoutDifferenceCents === 0
    && input.unprocessedExceptionCents === 0
  return { ...input, fundingDifferenceCents, purchaseDifferenceCents, receiptGapCents,
    costLedgerDifferenceCents, expectedPayoutCents, distributionDifferenceCents,
    lineDifferenceCents, payoutDifferenceCents, closeReady: ready }
}
