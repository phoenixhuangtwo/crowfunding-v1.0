import type { FileAsset } from '../domain/models.ts'
import type { EntityRepository } from '../persistence/repositories.ts'
import type { ObjectStorage } from './object-storage.ts'
import { DEFAULT_OCR_PROOF_TTL_MS } from '../ocr-proof.ts'

export type ReconcileInput = { dryRun: boolean; apply: boolean; assetId?: string }

type ReconcileDependencies = {
  assets: EntityRepository<FileAsset>
  storage: ObjectStorage
  referenceCount(assetId: string): Promise<number>
  now?: () => number
}

const invoiceCleanupSafetyMs = 5 * 60 * 1000

function settlementInvoiceReadyForCleanup(asset: FileAsset, now: number) {
  if (['procurement-payment-proof', 'customer-receipt-proof', 'confirmed-cost-proof', 'distribution-payout-proof', 'exception-fund-proof', 'exception-refund-proof', 'subscription-refund-proof', 'supplier-refund-proof', 'receipt-termination-refund-proof'].includes(asset.purpose) && asset.status === 'ready') {
    const createdAt = Date.parse(asset.createdAt)
    return Number.isFinite(createdAt) && now - createdAt >= 24 * 60 * 60 * 1000
  }
  if (asset.purpose !== 'settlement-invoice' || asset.status !== 'ready') return true
  const createdAt = Date.parse(asset.createdAt)
  return Number.isFinite(createdAt) && now - createdAt >= DEFAULT_OCR_PROOF_TTL_MS + invoiceCleanupSafetyMs
}

export async function reconcile(input: ReconcileInput, deps: ReconcileDependencies) {
  if (input.apply && !input.assetId) throw new Error('--apply 必须指定 --asset-id')
  const now = deps.now?.() ?? Date.now()
  const selected = input.assetId ? [await deps.assets.getById(input.assetId)].filter(Boolean) as FileAsset[] : await deps.assets.list()
  const report = await Promise.all(selected.map(async asset => ({
    assetId: asset.id,
    status: asset.status,
    purpose: asset.purpose,
    ownerType: asset.ownerType,
    ownerId: asset.ownerId,
    createdAt: asset.createdAt,
    proofWindowElapsed: settlementInvoiceReadyForCleanup(asset, now),
    referenceCount: await deps.referenceCount(asset.id),
    objectExists: Boolean(await deps.storage.headObject(asset.objectKey))
  })))

  if (!input.apply) return { mutated: 0, report }
  const target = report[0]
  const asset = selected[0]
  if (!target || !asset || target.referenceCount !== 0 || !target.proofWindowElapsed
    || !['failed', 'pending_delete', 'ready'].includes(target.status)) {
    throw new Error('资产仍被引用或状态不允许人工处理')
  }
  if (await deps.referenceCount(asset.id) !== 0) throw new Error('资产已被业务记录引用，停止清理')
  if (target.objectExists) await deps.storage.deleteObject(asset.objectKey)
  await deps.assets.deleteById(asset.id)
  return { mutated: 1, report }
}
