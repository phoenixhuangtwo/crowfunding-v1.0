import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateShareProfit } from '../src/estimated-share-profit.ts'

test('estimates employee profit by shares against all shares including company shares', () => {
  assert.equal(estimateShareProfit({ salesAmount: 303.01, costAmount: 300, totalShares: 3, shares: 1 }), 1)
  assert.equal(estimateShareProfit({ salesAmount: 303.01, costAmount: 300, totalShares: 3, shares: 2 }), 2)
  assert.equal(estimateShareProfit({ salesAmount: 300, costAmount: 300, totalShares: 3, shares: 1 }), 0)
})

test('does not invent a profit when procurement data or loss policy is missing', () => {
  assert.equal(estimateShareProfit({ salesAmount: undefined, costAmount: 300, totalShares: 3, shares: 1 }), null)
  assert.equal(estimateShareProfit({ salesAmount: 200, costAmount: 300, totalShares: 3, shares: 1 }), null)
  assert.equal(estimateShareProfit({ salesAmount: 303.01, costAmount: 300, totalShares: 3, shares: 4 }), null)
  assert.equal(estimateShareProfit({ salesAmount: 303.001, costAmount: 300, totalShares: 3, shares: 1 }), null)
})
