import assert from 'node:assert/strict'
import test from 'node:test'
import type { FileAsset } from '../server/domain/models.ts'
import type { EntityRepository } from '../server/persistence/repositories.ts'
import { reconcile } from '../server/storage/reconcile.ts'

function asset(id: string): FileAsset {
  return {
    id, provider: 'tencent-cos', bucket: 'private', region: 'ap-guangzhou', objectKey: `crowfunding/payment-proof/${id}.png`,
    originalName: `${id}.png`, extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'a'.repeat(64),
    purpose: 'payment-proof', ownerType: 'subscription', ownerId: `SUB-${id}`, status: 'failed', createdBy: 'system',
    createdAt: '2026-08-28', updatedAt: '2026-08-28'
  }
}

test('reconciliation is dry-run unless one exact asset ID is supplied', async () => {
  const records = new Map([['asset-1', asset('asset-1')], ['asset-2', asset('asset-2')]])
  const assets: EntityRepository<FileAsset> = {
    async list() { return [...records.values()] }, async findOne() { return null }, async getById(id) { return records.get(id) ?? null },
    async insert() {}, async replace() {}, async deleteById(id) { return records.delete(id) }, async count() { return records.size }
  }
  const deps = {
    assets,
    referenceCount: async () => 0,
    storage: {
      async headObject() { return { sizeBytes: 8 } },
      async deleteObject() {},
      async putObject() {}, getObjectStream() { throw new Error('unused') }, async checkHealth() { return 'up' as const }
    }
  }
  assert.equal((await reconcile({ dryRun: true, apply: false }, deps)).mutated, 0)
  await assert.rejects(() => reconcile({ dryRun: false, apply: true }, deps), /必须指定 --asset-id/)
  assert.equal((await reconcile({ dryRun: false, apply: true, assetId: 'asset-1' }, deps)).mutated, 1)
  assert.equal(records.has('asset-2'), true)
})
