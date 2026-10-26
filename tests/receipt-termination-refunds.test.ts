import assert from 'node:assert/strict'
import test from 'node:test'
import { validateReceiptTerminationRefund } from '../server/finance/receipt-termination-refunds.ts'

const input = { id: 'RTR-1', projectId: 'P-1', receiptBatchId: 'RB-1', kind: '客户回款' as const,
  amountCents: 2500, transactionNo: 'refund-bank-001', paidAt: '2026-10-25T10:00:00.000Z',
  proofAssetIds: ['asset-1'], manualVerificationNote: '已核对客户实际退回流水', registeredBy: 'finance-1' }
const now = new Date('2026-10-26T10:00:00.000Z')

test('采购失败原回款退回须受原单可退余额与凭证限制', () => {
  assert.equal(validateReceiptTerminationRefund(input, 2500, now).status, '待公司确认')
  assert.throws(() => validateReceiptTerminationRefund({ ...input, amountCents: 2501 }, 2500, now), /可退余额/)
  assert.throws(() => validateReceiptTerminationRefund({ ...input, proofAssetIds: [] }, 2500, now), /凭证/)
  assert.throws(() => validateReceiptTerminationRefund({ ...input, paidAt: '2026-10-27T10:00:00.000Z' }, 2500, now), /退回时间/)
})
