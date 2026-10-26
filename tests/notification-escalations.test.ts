import assert from 'node:assert/strict'
import test from 'node:test'
import { planEscalationNotifications } from '../server/notification-escalations.ts'
import type { DistributionOrder } from '../server/finance/distribution-orders.ts'

test('receipt warning waits for the published days and a positive gap', () => {
  const at = new Date('2026-10-26T12:00:00.000Z')
  const project = { id: 'PRJ-1', status: '回款中', salesAmount: 100,
    purchasePaidAt: '2026-10-01T00:00:00.000Z',
    ruleParametersSnapshot: { receiptWarningDays: 20, issueHandlingHours: 72 } }
  const base = { projects: [project], orders: [], receipts: [], at }
  assert.equal(planEscalationNotifications(base).filter(item => item.type === '回款超期预警').length, 1)
  assert.equal(planEscalationNotifications({ ...base, projects: [{ ...project,
    ruleParametersSnapshot: { ...project.ruleParametersSnapshot, receiptWarningDays: 30 } }] }).length, 0)
  assert.equal(planEscalationNotifications({ ...base, receipts: [{ id: 'R-1', kind: '客户回款',
    transactionNo: 'BANK-1', bookedAt: '', totalCents: 10000,
    lines: [{ projectId: 'PRJ-1', amountCents: 10000 }], proofAssetIds: [],
    registeredBy: '1003', status: '已通过' }] }).length, 0)
})

test('unresolved payout issue escalates after the project snapshot hours', () => {
  const at = new Date('2026-10-26T12:00:00.000Z')
  const project = { id: 'PRJ-2', status: '分配中', salesAmount: 100,
    ruleParametersSnapshot: { receiptWarningDays: 30, issueHandlingHours: 48 } }
  const order = { id: 'DIST-2', projectId: project.id, status: '有异议',
    lines: [{ participantId: '1001', status: '有异议', issueAt: '2026-10-24T11:00:00.000Z' }] } as DistributionOrder
  const base = { projects: [project], orders: [order], receipts: [], at }
  assert.equal(planEscalationNotifications(base).filter(item => item.type === '异议超时升级').length, 1)
  assert.equal(planEscalationNotifications({ ...base, projects: [{ ...project,
    ruleParametersSnapshot: { ...project.ruleParametersSnapshot, issueHandlingHours: 72 } }] }).length, 0)
  const resolved = { ...order, lines: [{ ...order.lines[0], status: '待员工确认' }] } as DistributionOrder
  assert.equal(planEscalationNotifications({ ...base, orders: [resolved] }).length, 0)
})
