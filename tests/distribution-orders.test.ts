import assert from 'node:assert/strict'
import test from 'node:test'
import { makeDistributionOrder } from '../server/finance/distribution-orders.ts'

const input = { id: 'DIST-1', projectId: 'PRJ-1', generatedBy: 'finance-1',
  createdAt: '2026-10-26T08:00:00.000Z', sharePriceCents: 10000, totalShares: 3,
  positions: [{ participantId: 'employee-1', kind: 'employee' as const, shares: 2 },
    { participantId: 'company', kind: 'company' as const, shares: 1 }],
  receivableCents: 36000, customerReceiptsCents: 37000, companyTopUpsCents: 16000,
  companyReturnsCents: 16000, procurementPaymentsCents: 30000, confirmedCostsCents: 100 }

test('persisted distribution snapshot uses confirmed receipts and costs with company rounding residual', () => {
  const order = makeDistributionOrder(input)
  assert.equal(order.status, '待审批')
  assert.equal(order.profitCents, 5900)
  assert.equal(order.payoutTotalCents, 35900)
  assert.equal(order.lines.reduce((sum, line) => sum + line.payoutCents, 0), 35900)
  assert.equal(order.lines.find(line => line.kind === 'company')?.profitCents, 1967)
  assert.equal(order.companyRoundingResidualCents, 1)
  assert.throws(() => makeDistributionOrder({ ...input, customerReceiptsCents: 35000 }), /回款尚未足额/)
})
