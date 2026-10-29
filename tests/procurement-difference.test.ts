import assert from 'node:assert/strict'
import test from 'node:test'
import { procurementAmountDifference } from '../server/procurement-difference.ts'

const published = { costAmount: 100, salesAmount: 120 }
const order = { totalCostPrice: 10000, totalTransactionPrice: 12000, totalSellingPrice: 12500 }

test('published procurement amounts compare in integer cents', () => {
  assert.equal(procurementAmountDifference(published, order), null)
  assert.deepEqual(procurementAmountDifference(published, { ...order, totalCostPrice: 10100 })?.fields,
    ['采购金额'])
  assert.deepEqual(procurementAmountDifference(published, { ...order, totalTransactionPrice: 0,
    totalSellingPrice: 12500 })?.fields, ['销售金额'])
})

test('invalid live cost is an observable difference and is not silently skipped', () => {
  const difference = procurementAmountDifference(published, { ...order, totalCostPrice: 0 })
  assert.equal(difference?.currentCostCents, 0)
  assert.deepEqual(difference?.fields, ['采购金额'])
})

test('missing or malformed upstream amounts do not masquerade as confirmed changes', () => {
  assert.equal(procurementAmountDifference(published, { ...order, totalCostPrice: undefined }), null)
  assert.equal(procurementAmountDifference(published, { ...order, totalTransactionPrice: undefined,
    totalSellingPrice: undefined }), null)
})
