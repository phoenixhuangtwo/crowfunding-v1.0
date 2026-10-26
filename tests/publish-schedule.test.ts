import assert from 'node:assert/strict'
import test from 'node:test'
import { employeePaymentDeadline, validatePublishSchedule } from '../server/publish-schedule.ts'

const schedule = {
  subscriptionCutoffAt: '2030-06-01 12:00',
  paymentCutoffAt: '2030-06-01 18:00',
  plannedPaymentDate: '2030-06-02'
}
const before = Date.parse('2030-06-01T09:00:00+08:00')

test('publication requires ordered Shanghai cutoff dates', () => {
  assert.equal(validatePublishSchedule(schedule, before).paymentCutoff,
    Date.parse('2030-06-01T18:00:00+08:00'))
  assert.throws(() => validatePublishSchedule(schedule, Date.parse('2030-06-01T12:00:00+08:00')), /晚于当前/)
  assert.throws(() => validatePublishSchedule({ ...schedule, paymentCutoffAt: '2030-06-01 11:00' }, before), /缴款截止/)
  assert.throws(() => validatePublishSchedule({ ...schedule, plannedPaymentDate: '2030-06-01' }, before), /计划付款日/)
  assert.throws(() => validatePublishSchedule({ ...schedule, paymentCutoffAt: '2030-02-30 18:00' }, before), /格式无效/)
})

test('employee payment deadline is capped at the project payment cutoff', () => {
  assert.equal(employeePaymentDeadline('2030-06-01 09:00:00', schedule.paymentCutoffAt), '2030-06-01 18:00:00')
  assert.equal(employeePaymentDeadline('2030-06-01 00:00:00', schedule.paymentCutoffAt), '2030-06-01 12:00:00')
})
