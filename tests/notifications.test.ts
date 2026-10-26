import assert from 'node:assert/strict'
import test from 'node:test'
import { paymentReminderDue, subscriptionNotification } from '../server/notifications.ts'

test('payment reminder uses the published lead time and only pending subscriptions', () => {
  const at = new Date('2026-10-26T08:00:00.000Z')
  const item = { paymentDeadlineAt: '2026-10-26 18:00', paymentReminderHours: 4, pay: '未缴款' }
  assert.equal(paymentReminderDue(item, at), true)
  assert.equal(paymentReminderDue({ ...item, paymentReminderHours: 1 }, at), false)
  assert.equal(paymentReminderDue({ ...item, pay: '待复核' }, at), false)
  assert.equal(paymentReminderDue(item, new Date('2026-10-26T10:00:01.000Z')), false)
})

test('subscription notification has a stable per-recipient id for retry deduplication', () => {
  const subscription = { id: 'SUB-1', projectId: 'PRJ-1', userId: '1001', paymentDeadlineAt: '2026-10-26 18:00' }
  assert.equal(subscriptionNotification(subscription, '缴款即将截止', '2026-10-26T08:00:00Z')?.id,
    subscriptionNotification(subscription, '缴款即将截止', '2026-10-26T09:00:00Z')?.id)
  assert.equal(subscriptionNotification({ ...subscription, userId: undefined }, '认购成功', '2026-10-26T08:00:00Z'), null)
})
