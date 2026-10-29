import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateSettlementProfit } from '../server/finance/settlement-profit.ts'

const base = {
  receivableCents: 30301,
  customerReceiptsCents: 30301,
  companyTopUpsCents: 600,
  companyReturnsCents: 600,
  procurementPaymentsCents: 30000,
  confirmedCostsCents: 150
}

test('read-only preview uses confirmed receipt, top-up, payment and cost amounts', () => {
  assert.deepEqual(calculateSettlementProfit(base), {
    ...base, netReceiptsCents: 30301, undistributedDifferenceCents: 0,
    distributableCents: 30301, profitCents: 151, previewOnly: true
  })
  assert.equal(calculateSettlementProfit({ ...base, customerReceiptsCents: 100 }).profitCents, -30050)
  assert.equal(calculateSettlementProfit({ ...base, customerReceiptsCents: 31000, companyReturnsCents: 0 }).undistributedDifferenceCents, 1299)
  assert.equal(calculateSettlementProfit({ ...base, customerReceiptsCents: 31000, companyReturnsCents: 0 }).profitCents, 151)
})

test('preview rejects missing, negative, fractional and unsafe amounts', () => {
  assert.throws(() => calculateSettlementProfit({ ...base, customerReceiptsCents: undefined as never }), /非负整数分/)
  assert.throws(() => calculateSettlementProfit({ ...base, companyTopUpsCents: -1 }), /非负整数分/)
  assert.throws(() => calculateSettlementProfit({ ...base, companyReturnsCents: 601 }), /补款返还/)
  assert.throws(() => calculateSettlementProfit({ ...base, confirmedCostsCents: 1.5 }), /非负整数分/)
  assert.throws(() => calculateSettlementProfit({
    ...base, customerReceiptsCents: Number.MAX_SAFE_INTEGER, companyTopUpsCents: Number.MAX_SAFE_INTEGER
  }), /安全金额范围/)
})
