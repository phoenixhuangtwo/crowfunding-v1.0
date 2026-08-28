import assert from 'node:assert/strict'
import test from 'node:test'
import type { FileAsset } from '../server/domain/models.ts'
import type { EntityRepository } from '../server/persistence/repositories.ts'
import { FileAssetService, objectKey } from '../server/storage/file-asset-service.ts'
import type { ObjectStorage, PutObjectInput } from '../server/storage/object-storage.ts'

class MemoryAssets implements EntityRepository<FileAsset> {
  records = new Map<string, FileAsset>()
  async list() { return [...this.records.values()] }
  async findOne() { return null }
  async getById(id: string) { return this.records.get(id) ?? null }
  async insert(document: FileAsset) { this.records.set(document.id, structuredClone(document)) }
  async replace(document: FileAsset) {
    if (!this.records.has(document.id)) throw new Error('missing')
    this.records.set(document.id, structuredClone(document))
  }
  async deleteById(id: string) { return this.records.delete(id) }
  async count() { return this.records.size }
}

class MemoryStorage implements ObjectStorage {
  objects = new Map<string, Buffer>()
  async putObject(input: PutObjectInput) { this.objects.set(input.key, Buffer.from(input.body)) }
  async headObject(key: string) { const body = this.objects.get(key); return body ? { sizeBytes: body.length } : null }
  getObjectStream() { throw new Error('not used') }
  async deleteObject(key: string) { this.objects.delete(key) }
  async checkHealth() { return 'up' as const }
}

function harness() {
  const assets = new MemoryAssets()
  const storage = new MemoryStorage()
  const mongo = { withTransaction: async <T>(work: (session: never) => Promise<T>) => work({} as never) }
  const service = new FileAssetService({
    assets,
    storage,
    mongo: mongo as never,
    config: { bucket: 'private-1250000000', region: 'ap-guangzhou', objectPrefix: 'crowfunding' },
    idFactory: () => 'asset-1',
    now: () => '2026-08-28 12:00:00'
  })
  return { assets, storage, service }
}

const upload = {
  bytes: Buffer.from('89504e470d0a1a0a', 'hex'),
  fileName: 'receipt.png',
  mimeType: 'image/png',
  extension: 'png',
  sha256: 'a'.repeat(64),
  purpose: 'settlement-invoice',
  ownerType: 'project',
  ownerId: 'PRJ-1',
  createdBy: 'finance01'
} as const

test('successful upload transitions pending to ready without returning bytes', async () => {
  const context = harness()
  const asset = await context.service.uploadUnbound(upload)
  assert.equal(asset.status, 'ready')
  assert.equal(context.storage.objects.size, 1)
  assert.equal('body' in asset, false)
  assert.equal('bytes' in asset, false)
})

test('business binding failure immediately compensates the exact uploaded object', async () => {
  const context = harness()
  await assert.rejects(() => context.service.uploadAndBind(upload, async () => { throw new Error('绑定失败') }), /绑定失败/)
  assert.equal(context.storage.objects.size, 0)
  assert.equal(context.assets.records.size, 0)
})

test('object keys reject traversal and encoded separators', () => {
  assert.equal(objectKey('crowfunding', 'payment-proof', 'asset-1', 'png'), 'crowfunding/payment-proof/asset-1.png')
  assert.throws(() => objectKey('../escape', 'payment-proof', 'asset-1', 'png'), /对象键参数不安全/)
  assert.throws(() => objectKey('crowfunding', 'payment-proof', 'asset%2f1', 'png'), /对象键参数不安全/)
})
