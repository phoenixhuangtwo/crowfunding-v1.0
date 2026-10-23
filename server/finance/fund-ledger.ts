import type { ClientSession, Db } from 'mongodb'

export type ContributionLedgerEntry = {
  id: string
  sourceKey: string
  type: 'employee_contribution'
  projectId: string
  subscriptionId: string
  participantId: string
  shares: number
  amountCents: number
  transactionNo: string
  transactionKey: string
  proofAssetIds: string[]
  reviewedBy: string
  createdAt: string
}

/** This repository deliberately exposes insertion only; corrections must be separate reversal entries. */
export function createFundLedger(db: Db, prefix = '') {
  const collection = db.collection<ContributionLedgerEntry>(`${prefix}fund_ledger`)
  return {
    append(entry: ContributionLedgerEntry, session: ClientSession) {
      return collection.insertOne(entry, { session })
    }
  }
}
