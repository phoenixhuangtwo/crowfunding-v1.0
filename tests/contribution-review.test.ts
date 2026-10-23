import assert from 'node:assert/strict'
import test from 'node:test'
import { validateContributionReview } from '../server/finance/contribution-review.ts'

const base = {
  expectedAmount: 100,
  actualPaidAmount: 100,
  transactionNo: 'BANK-20261022-001',
  proofs: [{ assetId: 'asset-1', recognizedAmount: 100, status: '已识别' as const }]
}

test('financial review requires matching subscription, bank and OCR amounts', () => {
  assert.deepEqual(validateContributionReview(base), {
    amountCents: 10000, transactionNo: 'BANK-20261022-001', proofAssetIds: ['asset-1']
  })
  assert.throws(() => validateContributionReview({ ...base, actualPaidAmount: 99 }), /实际到账金额必须与认购金额一致/)
  assert.throws(() => validateContributionReview({ ...base, proofs: [{ ...base.proofs[0], recognizedAmount: 99 }] }), /凭证识别金额与实际到账金额不一致/)
  assert.throws(() => validateContributionReview({ ...base, proofs: [{ ...base.proofs[0], assetId: '' }] }), /缺少已识别/)
  assert.throws(() => validateContributionReview({ ...base, transactionNo: ' ' }), /交易流水号/)
})
