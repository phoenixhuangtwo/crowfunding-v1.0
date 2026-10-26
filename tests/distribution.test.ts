import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateDistribution, type DistributionInput } from '../server/finance/distribution.ts'

const base: DistributionInput = {
  sharePriceCents: 10000,
  totalShares: 3,
  positions: [
    { participantId: 'employee-a', kind: 'employee', shares: 1 },
    { participantId: 'employee-b', kind: 'employee', shares: 1 },
    { participantId: 'company', kind: 'company', shares: 1 }
  ],
  receivableCents: 30301,
  customerReceiptsCents: 30301,
  companyTopUpsCents: 0,
  companyReturnsCents: 0,
  procurementPaymentsCents: 30000,
  confirmedCostsCents: 0
}

test('allocates principal and profit by shares, with fractional-cent residual to company', () => {
  const result = calculateDistribution(base)
  assert.equal(result.profitCents, 301)
  assert.equal(result.companyRoundingResidualCents, 1)
  assert.deepEqual(result.lines.map(line => [line.principalCents, line.profitCents, line.payoutCents]), [
    [10000, 100, 10100], [10000, 100, 10100], [10000, 101, 10101]
  ])
  assert.equal(result.lines.reduce((sum, line) => sum + line.payoutCents, 0), 30301)
})

test('includes confirmed top-ups and costs in the agreed profit formula', () => {
  const result = calculateDistribution({ ...base, receivableCents: 30600, customerReceiptsCents: 30000, companyTopUpsCents: 600, confirmedCostsCents: 150 })
  assert.equal(result.profitCents, 450)
  assert.deepEqual(result.lines.map(line => line.profitCents), [150, 150, 150])
})

test('rejects mismatched shares, procurement funding, losses and non-cent money', () => {
  assert.throws(() => calculateDistribution({ ...base, totalShares: 4 }), /shares must equal/)
  assert.throws(() => calculateDistribution({ ...base, procurementPaymentsCents: 29999 }), /procurement payments/)
  assert.throws(() => calculateDistribution({ ...base, customerReceiptsCents: 29999 }), /insufficient/)
  assert.throws(() => calculateDistribution({ ...base, customerReceiptsCents: 30300.5 }), /integer cents/)
  assert.throws(() => calculateDistribution({ ...base, positions: [base.positions[0], base.positions[0], base.positions[2]] }), /unique/)
  assert.throws(() => calculateDistribution({ ...base, sharePriceCents: Number.MAX_SAFE_INTEGER }), /safe integer range/)
})

test('assigns the fractional-cent remainder to company even when its subscribed shares are zero', () => {
  const result = calculateDistribution({
    ...base,
    positions: [
      { participantId: 'employee-a', kind: 'employee', shares: 1 },
      { participantId: 'employee-b', kind: 'employee', shares: 2 },
      { participantId: 'company', kind: 'company', shares: 0 }
    ],
    customerReceiptsCents: 30001,
    receivableCents: 30001
  })
  assert.deepEqual(result.lines.map(line => line.profitCents), [0, 0, 1])
  assert.equal(result.companyRoundingResidualCents, 1)
})

test('excludes excess receipts and company top-up returns from distributable profit', () => {
  const excess = calculateDistribution({ ...base, customerReceiptsCents: 31000 })
  assert.equal(excess.undistributedDifferenceCents, 699)
  assert.equal(excess.profitCents, 301)
  const returned = calculateDistribution({ ...base, customerReceiptsCents: 30301, companyTopUpsCents: 600, companyReturnsCents: 600 })
  assert.equal(returned.profitCents, 301)
  assert.equal(returned.distributableCents, 30301)
})
