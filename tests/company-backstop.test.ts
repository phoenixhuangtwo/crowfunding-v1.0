import assert from 'node:assert/strict'
import test from 'node:test'
import { planCompanyBackstop } from '../server/company-backstop.ts'

const candidate = {
  status: '未满额', sharePrice: 100, remainingAmount: 200,
  subscriptionCutoffAt: '2026-10-22 18:00', employeePaymentDeadlines: ['2026-10-23 06:00'], companyTakeover: true
}

test('plans only whole remaining shares after the payment cutoff', () => {
  assert.equal(planCompanyBackstop(candidate, new Date('2026-10-23T05:59:59')), null)
  assert.deepEqual(planCompanyBackstop(candidate, new Date('2026-10-23T06:00:00')), { shares: 2, amount: 200 })
  assert.equal(planCompanyBackstop({ ...candidate, remainingAmount: 0 }, new Date('2026-10-23T06:00:00')), null)
})

test('does not backstop disabled or closed projects and rejects fractional remainders', () => {
  const at = new Date('2026-10-23T06:00:00')
  assert.equal(planCompanyBackstop({ ...candidate, companyTakeover: false }, at), null)
  assert.equal(planCompanyBackstop({ ...candidate, status: '已中断' }, at), null)
  assert.throws(() => planCompanyBackstop({ ...candidate, remainingAmount: 150 }, at), /完整份数/)
  assert.throws(() => planCompanyBackstop({ ...candidate, sharePrice: 100.001 }, at), /金额无效/)
  assert.throws(() => planCompanyBackstop({ ...candidate, subscriptionCutoffAt: 'invalid' }, at), /截止时间/)
})

test('waits for the project payment cutoff and completion of payment reviews', () => {
  const at = new Date('2026-10-23T06:00:00')
  assert.equal(planCompanyBackstop({ ...candidate, paymentCutoffAt: '2026-10-23 18:00' }, at), null)
  assert.equal(planCompanyBackstop({ ...candidate, unresolvedReviewCount: 1 }, at), null)
  assert.deepEqual(planCompanyBackstop({ ...candidate, paymentCutoffAt: '2026-10-23 05:00', unresolvedReviewCount: 0 }, at), { shares: 2, amount: 200 })
  assert.throws(() => planCompanyBackstop({ ...candidate, unresolvedReviewCount: -1 }, at), /待复核笔数/)
})
