import assert from 'node:assert/strict'
import test from 'node:test'
import { validateSupplierRefund } from '../server/finance/procurement-failure.ts'

const input = { id: 'SREF-1', projectId: 'P-1', amountCents: 3000, transactionNo: 'supplier-001',
  refundedAt: '2026-10-25T10:00:00.000Z', proofAssetIds: ['proof-1'],
  manualVerificationNote: '财务已核验实际到账', registeredBy: 'finance-1' }
const now = new Date('2026-10-26T10:00:00.000Z')

test('供应商退款按采购付款余额逐次限制，凭证和流水必须完整', () => {
  assert.equal(validateSupplierRefund(input, 10000, 5000, now).amountCents, 3000)
  assert.throws(() => validateSupplierRefund({ ...input, amountCents: 5001 }, 10000, 5000, now), /采购付款余额/)
  assert.throws(() => validateSupplierRefund({ ...input, proofAssetIds: ['proof-1', 'proof-1'] }, 10000, 0, now), /不同的图片/)
  assert.throws(() => validateSupplierRefund({ ...input, refundedAt: '2026-10-27T10:00:00.000Z' }, 10000, 0, now), /退款时间/)
})
