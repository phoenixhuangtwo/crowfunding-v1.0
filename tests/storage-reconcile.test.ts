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

test('ready unbound settlement invoices stay protected until their OCR proof window has elapsed', async () => {
  const createdAt = Date.parse('2026-10-23T00:00:00.000Z')
  const invoice: FileAsset = {
    ...asset('invoice-1'), purpose: 'settlement-invoice', ownerType: 'project', ownerId: 'PRJ-1',
    status: 'ready', createdAt: new Date(createdAt).toISOString()
  }
  let deleted = false
  const deps = {
    assets: {
      async list() { return [invoice] }, async findOne() { return null }, async getById() { return deleted ? null : invoice },
      async insert() {}, async replace() {}, async deleteById() { deleted = true; return true }, async count() { return deleted ? 0 : 1 }
    } as EntityRepository<FileAsset>,
    storage: {
      async headObject() { return { sizeBytes: 8 } }, async deleteObject() {}, async putObject() {},
      getObjectStream() { throw new Error('unused') }, async checkHealth() { return 'up' as const }
    },
    referenceCount: async () => 0,
    now: () => createdAt + 14 * 60 * 1000
  }
  assert.equal((await reconcile({ dryRun: true, apply: false, assetId: invoice.id }, deps)).report[0].proofWindowElapsed, false)
  await assert.rejects(() => reconcile({ dryRun: false, apply: true, assetId: invoice.id }, deps), /状态不允许/)
  assert.equal(deleted, false)
  deps.now = () => createdAt + 15 * 60 * 1000
  assert.equal((await reconcile({ dryRun: true, apply: false, assetId: invoice.id }, deps)).report[0].proofWindowElapsed, true)
  assert.equal((await reconcile({ dryRun: false, apply: true, assetId: invoice.id }, deps)).mutated, 1)
  assert.equal(deleted, true)
})

test('reconciliation rechecks business references before deleting one asset', async () => {
  const invoice = { ...asset('invoice-2'), purpose: 'settlement-invoice' as const, status: 'ready' as const,
    ownerType: 'project' as const, ownerId: 'PRJ-2', createdAt: '2026-10-23T00:00:00.000Z' }
  let checks = 0
  let deleted = false
  const deps = {
    assets: {
      async list() { return [invoice] }, async findOne() { return null }, async getById() { return invoice },
      async insert() {}, async replace() {}, async deleteById() { deleted = true; return true }, async count() { return 1 }
    } as EntityRepository<FileAsset>,
    storage: {
      async headObject() { return { sizeBytes: 8 } }, async deleteObject() { deleted = true }, async putObject() {},
      getObjectStream() { throw new Error('unused') }, async checkHealth() { return 'up' as const }
    },
    referenceCount: async () => { checks += 1; return checks === 1 ? 0 : 1 },
    now: () => Date.parse('2026-10-23T00:16:00.000Z')
  }
  await assert.rejects(() => reconcile({ dryRun: false, apply: true, assetId: invoice.id }, deps), /已被业务记录引用/)
  assert.equal(deleted, false)
})
