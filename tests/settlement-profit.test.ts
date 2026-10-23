import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateSettlementProfit } from '../server/finance/settlement-profit.ts'

const base = {
  customerReceiptsCents: 30301,
  companyTopUpsCents: 600,
  procurementPaymentsCents: 30000,
  confirmedCostsCents: 150
}

test('read-only preview uses confirmed receipt, top-up, payment and cost amounts', () => {
  assert.deepEqual(calculateSettlementProfit(base), { ...base, profitCents: 751, previewOnly: true })
  assert.equal(calculateSettlementProfit({ ...base, customerReceiptsCents: 100 }).profitCents, -29450)
})

test('preview rejects missing, negative, fractional and unsafe amounts', () => {
  assert.throws(() => calculateSettlementProfit({ ...base, customerReceiptsCents: undefined as never }), /非负整数分/)
  assert.throws(() => calculateSettlementProfit({ ...base, companyTopUpsCents: -1 }), /非负整数分/)
  assert.throws(() => calculateSettlementProfit({ ...base, confirmedCostsCents: 1.5 }), /非负整数分/)
  assert.throws(() => calculateSettlementProfit({
    ...base, customerReceiptsCents: Number.MAX_SAFE_INTEGER, companyTopUpsCents: Number.MAX_SAFE_INTEGER
  }), /安全金额范围/)
})
