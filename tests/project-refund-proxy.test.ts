import assert from 'node:assert/strict'
import test from 'node:test'
import { validateProjectRefundProxy } from '../server/finance/project-refund-proxy.ts'

const now = new Date('2026-10-26T12:00:00.000Z')
const input = { reason: '员工超过确认期限仍未回复', accountDisabled: false,
  paidAt: '2026-10-18T10:00:00.000Z', proofAssetIds: ['proof-1'], confirmDays: 7 }

test('退款代确认仅在超期且留有凭证时允许，公司线下记录不可缺失', () => {
  assert.equal(validateProjectRefundProxy(input, now).reason, input.reason)
  assert.throws(() => validateProjectRefundProxy({ ...input, paidAt: '2026-10-20T10:00:00.000Z' }, now), /未超过/)
  assert.throws(() => validateProjectRefundProxy({ ...input, proofAssetIds: [] }, now), /凭证缺失/)
  assert.throws(() => validateProjectRefundProxy({ ...input, accountDisabled: true }, now), /线下核实/)
})
