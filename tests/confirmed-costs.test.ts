import assert from 'node:assert/strict'
import test from 'node:test'
import { validateCostRegistration } from '../server/finance/confirmed-costs.ts'

const now = new Date('2026-10-26T08:00:00.000Z')
const input = { id: 'COST-1', projectId: 'PRJ-1', amountCents: 100,
  transactionNo: 'BANK-COST-1', paidAt: '2026-10-26T07:00:00.000Z',
  proofAssetIds: ['ASSET-1'], reason: '实际物流支出已核对', registeredBy: 'finance-1' }

test('other costs require a positive cent amount, unique proof IDs and a past payment time', () => {
  const cost = validateCostRegistration(input, now)
  assert.equal(cost.status, '待公司复核')
  assert.equal(cost.amountCents, 100)
  assert.throws(() => validateCostRegistration({ ...input, amountCents: 100.5 }, now), /整数分/)
  assert.throws(() => validateCostRegistration({ ...input, proofAssetIds: ['ASSET-1', 'ASSET-1'] }, now), /不同/)
  assert.throws(() => validateCostRegistration({ ...input, paidAt: '2026-10-26T09:00:00.000Z' }, now), /晚于当前/)
})
