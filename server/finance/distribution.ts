/** All monetary inputs and outputs are integer cents. No floating-point yuan arithmetic is used. */
import { calculateSettlementProfit } from './settlement-profit.ts'

export type FundingPosition = {
  participantId: string
  kind: 'employee' | 'company'
  shares: number
}

export type DistributionInput = {
  sharePriceCents: number
  totalShares: number
  positions: FundingPosition[]
  receivableCents: number
  customerReceiptsCents: number
  companyTopUpsCents: number
  companyReturnsCents: number
  procurementPaymentsCents: number
  confirmedCostsCents: number
}

export type DistributionLine = FundingPosition & {
  principalCents: number
  profitCents: number
  payoutCents: number
}

export type Distribution = {
  profitCents: number
  distributableCents: number
  undistributedDifferenceCents: number
  companyRoundingResidualCents: number
  lines: DistributionLine[]
}

function nonNegativeCents(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be non-negative integer cents`)
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`)
}

function safeSum(values: number[], name: string) {
  const sum = values.reduce((total, value) => total + value, 0)
  if (!Number.isSafeInteger(sum)) throw new RangeError(`${name} exceeds safe integer range`)
  return sum
}

function safeProduct(left: number, right: number, name: string) {
  const product = BigInt(left) * BigInt(right)
  if (product > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds safe integer range`)
  return Number(product)
}

function proportionalCents(amount: number, shares: number, totalShares: number) {
  return Number(BigInt(amount) * BigInt(shares) / BigInt(totalShares))
}

/** Preview only: approval, payment registration and ledger posting belong to separate workflows. */
export function calculateDistribution(input: DistributionInput): Distribution {
  positiveInteger(input.sharePriceCents, 'sharePriceCents')
  positiveInteger(input.totalShares, 'totalShares')
  for (const key of ['receivableCents', 'customerReceiptsCents', 'companyTopUpsCents', 'companyReturnsCents', 'procurementPaymentsCents', 'confirmedCostsCents'] as const) {
    nonNegativeCents(input[key], key)
  }
  if (!Array.isArray(input.positions) || input.positions.length === 0) throw new RangeError('positions are required')

  const participantIds = new Set<string>()
  let companyCount = 0
  for (const position of input.positions) {
    if (!position.participantId || participantIds.has(position.participantId)) throw new RangeError('participantId must be unique and non-empty')
    participantIds.add(position.participantId)
    if (position.kind !== 'employee' && position.kind !== 'company') throw new RangeError('invalid participant kind')
    if (position.kind === 'company') companyCount += 1
    if (!Number.isSafeInteger(position.shares) || position.shares < 0) throw new RangeError('shares must be a non-negative integer')
  }
  if (companyCount !== 1) throw new RangeError('exactly one company position is required')
  if (safeSum(input.positions.map(position => position.shares), 'shares') !== input.totalShares) {
    throw new RangeError('position shares must equal totalShares')
  }

  const principalCents = safeProduct(input.sharePriceCents, input.totalShares, 'principal')
  if (input.procurementPaymentsCents !== principalCents) {
    throw new RangeError('procurement payments must equal subscribed principal')
  }
  const preview = calculateSettlementProfit(input)
  const profitCents = preview.profitCents
  if (profitCents < 0) throw new RangeError('receipts are insufficient for a non-negative distribution')

  let employeeProfitCents = 0
  const lines = input.positions.map(position => {
    const principal = safeProduct(position.shares, input.sharePriceCents, 'participant principal')
    const profit = position.kind === 'employee'
      ? proportionalCents(profitCents, position.shares, input.totalShares)
      : 0
    if (position.kind === 'employee') employeeProfitCents += profit
    return { ...position, principalCents: principal, profitCents: profit, payoutCents: principal + profit }
  })
  const company = lines.find(line => line.kind === 'company')!
  const companyBaseProfitCents = proportionalCents(profitCents, company.shares, input.totalShares)
  company.profitCents = profitCents - employeeProfitCents
  company.payoutCents = company.principalCents + company.profitCents
  if (!lines.every(line => Number.isSafeInteger(line.payoutCents))) throw new RangeError('payout exceeds safe integer range')
  return {
    profitCents,
    distributableCents: preview.distributableCents,
    undistributedDifferenceCents: preview.undistributedDifferenceCents,
    companyRoundingResidualCents: company.profitCents - companyBaseProfitCents,
    lines
  }
}
