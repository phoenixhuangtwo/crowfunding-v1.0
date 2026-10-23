import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateShareSubscription, prepareShareRule } from '../server/share-subscription.ts'

test('share rule derives company and employee amounts from procurement cost', () => {
  assert.deepEqual(prepareShareRule(300, 100, 1, 2), {
    sharePrice: 100,
    totalShares: 3,
    companyFrontShares: 1,
    maxSharesPerEmployee: 2,
    companyFixedAmount: 100,
    totalAmount: 200
  })
  assert.equal(calculateShareSubscription(100, 1, 200, 1, 2), 100)
})

test('share rule rejects fractional shares and incompatible cost', () => {
  assert.throws(() => prepareShareRule(301, 100, 0, 2), /整除/)
  assert.throws(() => prepareShareRule(300, 100, 3, 1), /公司前置份数/)
  assert.throws(() => prepareShareRule(300, 100, 0, 4), /员工个人上限/)
  assert.throws(() => calculateShareSubscription(100, 1.5, 200, 0, 2), /正整数/)
  assert.throws(() => calculateShareSubscription(100, 2, 200, 1, 2), /个人上限/)
  assert.throws(() => calculateShareSubscription(100, 2, 100, 0, 2), /剩余/)
})
