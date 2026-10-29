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

test('preserves every cent across 1000 deterministic multi-participant distributions', () => {
  let seed = 20261027
  const next = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % limit
  }
  for (let caseNo = 0; caseNo < 1000; caseNo += 1) {
    const totalShares = 1 + next(50)
    const sharePriceCents = 1 + next(100000)
    const profitCents = next(100000)
    const confirmedCostsCents = next(10000)
    const principalCents = totalShares * sharePriceCents
    const positions: DistributionInput['positions'] = Array.from({ length: 4 }, (_, index) => ({
      participantId: `employee-${index}`, kind: 'employee', shares: 0
    }))
    positions.push({ participantId: 'company', kind: 'company', shares: 0 })
    for (let share = 0; share < totalShares; share += 1) positions[next(positions.length)].shares += 1
    const result = calculateDistribution({ sharePriceCents, totalShares, positions,
      receivableCents: principalCents + profitCents + confirmedCostsCents,
      customerReceiptsCents: principalCents + profitCents + confirmedCostsCents,
      companyTopUpsCents: 0, companyReturnsCents: 0,
      procurementPaymentsCents: principalCents, confirmedCostsCents })
    assert.equal(result.profitCents, profitCents)
    assert.equal(result.lines.reduce((sum, line) => sum + line.principalCents, 0), principalCents)
    assert.equal(result.lines.reduce((sum, line) => sum + line.profitCents, 0), profitCents)
    assert.equal(result.lines.reduce((sum, line) => sum + line.payoutCents, 0), principalCents + profitCents)
    for (const line of result.lines) {
      assert.equal(line.principalCents, line.shares * sharePriceCents)
      if (line.kind === 'employee') {
        assert.equal(line.profitCents, Number(BigInt(profitCents) * BigInt(line.shares) / BigInt(totalShares)))
      }
    }
    assert.ok(result.companyRoundingResidualCents >= 0)
    assert.ok(result.companyRoundingResidualCents < positions.length)
  }
})
