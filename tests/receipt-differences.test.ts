import assert from 'node:assert/strict'
import test from 'node:test'
import { unresolvedReceiptDifference, validateReceiptDifference } from '../server/finance/receipt-differences.ts'

const now = new Date('2026-10-26T06:00:00.000Z')
const base = { id: 'DIFF-1', projectId: 'PRJ-1', amountCents: 400, destination: '退回客户' as const,
  reason: '客户重复付款，已线下退回', refundTransactionNo: 'BANK-RETURN-1', registeredBy: 'finance-1' }

test('excess receipts must have a recorded destination without exceeding the excess', () => {
  const first = validateReceiptDifference(base, 1000, [], now)
  assert.equal(first.amountCents, 400)
  assert.deepEqual(unresolvedReceiptDifference(1000, [first]), { handledCents: 400, unresolvedCents: 600 })
  const second = validateReceiptDifference({ ...base, id: 'DIFF-2', amountCents: 600,
    destination: '计入公司', refundTransactionNo: undefined, reason: '客户同意余额转为公司收入' }, 1000, [first], now)
  assert.equal(unresolvedReceiptDifference(1000, [first, second]).unresolvedCents, 0)
  assert.throws(() => validateReceiptDifference({ ...base, amountCents: 601 }, 1000, [first], now), /超过待处理差异/)
  assert.throws(() => validateReceiptDifference({ ...base, refundTransactionNo: undefined }, 1000, [], now), /退款流水号/)
  assert.throws(() => validateReceiptDifference({ ...base, destination: '计入公司' }, 1000, [], now), /不得填写退款流水号/)
})
