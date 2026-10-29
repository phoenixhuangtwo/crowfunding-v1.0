import assert from 'node:assert/strict'
import test from 'node:test'
import type { Filter } from 'mongodb'
import type { AuditLog, FileAsset, ReceivingCode } from '../server/domain/models.ts'
import type { EntityRepository } from '../server/persistence/repositories.ts'
import { createReceivingCodeOnce } from '../server/services/receiving-code-creation.ts'
import { FileAssetService } from '../server/storage/file-asset-service.ts'
import type { ObjectStorage, PutObjectInput } from '../server/storage/object-storage.ts'

class MemoryRepository<T extends { id: string }> implements EntityRepository<T> {
  records = new Map<string, T>()
  async list() { return [...this.records.values()].map(record => structuredClone(record)) }
  async findOne(filter: Filter<T>) {
    return [...this.records.values()].find(record => Object.entries(filter).every(([key, value]) => record[key as keyof T] === value)) ?? null
  }
  async getById(id: string) { return this.records.get(id) ?? null }
  async insert(document: T) { this.records.set(document.id, structuredClone(document)) }
  async replace(document: T) { this.records.set(document.id, structuredClone(document)) }
  async sync(documents: T[]) { for (const document of documents) this.records.set(document.id, structuredClone(document)) }
  async deleteById(id: string) { return this.records.delete(id) }
  async count() { return this.records.size }
}

class MemoryStorage implements ObjectStorage {
  objects = new Map<string, Buffer>()
  failUpload = false
  async putObject(input: PutObjectInput) {
    if (this.failUpload) throw new Error('COS unavailable')
    this.objects.set(input.key, Buffer.from(input.body))
  }
  async headObject(key: string) { const body = this.objects.get(key); return body ? { sizeBytes: body.length } : null }
  getObjectStream() { throw new Error('not used') }
  async deleteObject(key: string) { this.objects.delete(key) }
  async checkHealth() { return 'up' as const }
}

function harness() {
  const receivingCodes = new MemoryRepository<ReceivingCode>()
  const auditLogs = new MemoryRepository<AuditLog>()
  const assets = new MemoryRepository<FileAsset>()
  const storage = new MemoryStorage()
  const mongo = { withTransaction: async <T>(work: (session: never) => Promise<T>) => work({} as never) }
  const files = new FileAssetService({
    assets,
    storage,
    mongo: mongo as never,
    config: { bucket: 'private-1250000000', region: 'ap-guangzhou', objectPrefix: 'crowfunding' },
    idFactory: () => 'asset-1',
    now: () => '2026-08-28T09:00:00.000Z'
  })
  return { receivingCodes, auditLogs, assets, storage, mongo, files }
}

const image = {
  bytes: Buffer.from('89504e470d0a1a0a', 'hex'),
  fileName: '收款码.png',
  mimeType: 'image/png',
  extension: 'png',
  sizeBytes: 8,
  sha256: 'a'.repeat(64)
} as const

const input = {
  createRequestId: 'request-1',
  subject: '广州福尚云科技有限公司',
  accountNote: '财务专用',
  codeName: '支付宝收款码',
  operator: 'admin01 · 管理员',
  role: 'admin' as const,
  image
}

test('repeating one receiving-code creation request returns one record and one COS object', async () => {
  const context = harness()
  const dependencies = {
    ...context,
    idFactory: () => 'RCV-1',
    auditIdFactory: () => 'AUD-1',
    now: () => '2026-08-28 17:00:00'
  }

  const first = await createReceivingCodeOnce(input, dependencies)
  const repeated = await createReceivingCodeOnce(input, dependencies)

  assert.equal(first.created, true)
  assert.equal(repeated.created, false)
  assert.equal(repeated.record.id, first.record.id)
  assert.equal(context.receivingCodes.records.size, 1)
  assert.equal(context.auditLogs.records.size, 1)
  assert.equal([...context.auditLogs.records.values()][0]?.role, 'admin')
  assert.equal(context.storage.objects.size, 1)
  assert.equal(first.record.imageAssetId, 'asset-1')
})

test('failed COS upload leaves no receiving-code record or audit entry', async () => {
  const context = harness()
  context.storage.failUpload = true

  await assert.rejects(() => createReceivingCodeOnce(input, {
    ...context,
    idFactory: () => 'RCV-1',
    auditIdFactory: () => 'AUD-1',
    now: () => '2026-08-28 17:00:00'
  }), /COS unavailable/)

  assert.equal(context.receivingCodes.records.size, 0)
  assert.equal(context.auditLogs.records.size, 0)
  assert.equal(context.storage.objects.size, 0)
  assert.equal(context.assets.records.size, 0)
})
