import type { FileAsset } from '../domain/models.ts'
import type { EntityRepository } from '../persistence/repositories.ts'
import type { ObjectStorage } from './object-storage.ts'

export type ReconcileInput = { dryRun: boolean; apply: boolean; assetId?: string }

type ReconcileDependencies = {
  assets: EntityRepository<FileAsset>
  storage: ObjectStorage
  referenceCount(assetId: string): Promise<number>
}

export async function reconcile(input: ReconcileInput, deps: ReconcileDependencies) {
  if (input.apply && !input.assetId) throw new Error('--apply 必须指定 --asset-id')
  const selected = input.assetId ? [await deps.assets.getById(input.assetId)].filter(Boolean) as FileAsset[] : await deps.assets.list()
  const report = await Promise.all(selected.map(async asset => ({
    assetId: asset.id,
    status: asset.status,
    purpose: asset.purpose,
    ownerType: asset.ownerType,
    ownerId: asset.ownerId,
    referenceCount: await deps.referenceCount(asset.id),
    objectExists: Boolean(await deps.storage.headObject(asset.objectKey))
  })))

  if (!input.apply) return { mutated: 0, report }
  const target = report[0]
  const asset = selected[0]
  if (!target || !asset || target.referenceCount !== 0 || !['failed', 'pending_delete', 'ready'].includes(target.status)) {
    throw new Error('资产仍被引用或状态不允许人工处理')
  }
  if (target.objectExists) await deps.storage.deleteObject(asset.objectKey)
  await deps.assets.deleteById(asset.id)
  return { mutated: 1, report }
}
