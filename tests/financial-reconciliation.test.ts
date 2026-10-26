import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileProjectFinancials } from '../server/finance/financial-reconciliation.ts'

const base = { purchaseCents: 30000, approvedEmployeeCents: 20000,
  confirmedCompanyCents: 10000, procurementPaymentCents: 30000,
  receivableCents: 36000, distributableReceiptsCents: 36000,
  unresolvedReceiptDifferenceCents: 0, confirmedCostsCents: 100,
  confirmedCostLedgerCents: 100, orderStatus: '可结单',
  orderPayoutTotalCents: 35900, orderLinesCents: 35900,
  payoutLedgerCents: 35900, unprocessedExceptionCents: 0 }

test('close readiness needs matching funding, receipts, cost ledger, distribution and payouts', () => {
  assert.equal(reconcileProjectFinancials(base).closeReady, true)
  assert.equal(reconcileProjectFinancials({ ...base, payoutLedgerCents: 35899 }).payoutDifferenceCents, -1)
  assert.equal(reconcileProjectFinancials({ ...base, payoutLedgerCents: 35899 }).closeReady, false)
  assert.equal(reconcileProjectFinancials({ ...base, unprocessedExceptionCents: 1 }).closeReady, false)
  assert.equal(reconcileProjectFinancials({ ...base, unresolvedReceiptDifferenceCents: 1 }).closeReady, false)
  assert.equal(reconcileProjectFinancials({ ...base, orderStatus: '有异议' }).closeReady, false)
})
