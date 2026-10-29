export type DistributionPayoutProxyRequest = {
  id: string
  orderId: string
  projectId: string
  participantId: string
  reason: string
  accountDisabled: boolean
  offlineVerificationNote?: string
  proofAssetIds: string[]
  status: '待公司复核' | '已通过' | '已驳回'
  requestedBy: string
  requestedAt: string
  reviewedBy?: string
  reviewedAt?: string
  reviewReason?: string
}
