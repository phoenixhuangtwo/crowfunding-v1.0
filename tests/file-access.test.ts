import assert from 'node:assert/strict'
import test from 'node:test'
import type { AppRepositories, EntityRepository } from '../server/persistence/repositories.ts'
import type { FileAsset, Subscription } from '../server/domain/models.ts'
import { authorizeAssetRead } from '../server/request-context.ts'

function repository<T extends { id: string }>(records: T[]): EntityRepository<T> {
  return {
    async list() { return records },
    async findOne() { return null },
    async getById(id) { return records.find(record => record.id === id) ?? null },
    async insert() {}, async replace() {}, async deleteById() { return false }, async count() { return records.length }
  }
}

function repos(subscription: Subscription): AppRepositories {
  return {
    projects: repository([]), subscriptions: repository([subscription]), rules: repository([]),
    receivingCodes: repository([]), auditLogs: repository([]), riskEvents: repository([]), fileAssets: repository([])
  }
}

const asset: FileAsset = {
  id: 'asset-1', provider: 'tencent-cos', bucket: 'private', region: 'ap-guangzhou', objectKey: 'crowfunding/payment-proof/asset-1.png',
  originalName: 'pay.png', extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'a'.repeat(64),
  purpose: 'payment-proof', ownerType: 'subscription', ownerId: 'SUB-1', status: 'ready', createdBy: 'employee01',
  createdAt: '2026-08-28', updatedAt: '2026-08-28'
}

test('employee reads only a payment asset owned by their subscription', async () => {
  const repositories = repos({
    id: 'SUB-1', projectId: 'PRJ-1', project: '项目', userId: 'employee01', amount: 100, pay: '待复核', profit: 0,
    action: '查看支付', idempotencyKey: 'idem', createdAt: '2026-08-28', paymentDeadlineAt: '2026-08-29'
  })
  await assert.doesNotReject(() => authorizeAssetRead({ userId: 'employee01', role: 'employee' }, asset, repositories))
  await assert.rejects(() => authorizeAssetRead({ userId: 'employee02', role: 'employee' }, asset, repositories), /无权访问/)
})

test('procurement payment proof is readable only by finance and company administrator', async () => {
  const proof = { ...asset, purpose: 'procurement-payment-proof' as const,
    ownerType: 'project' as const, ownerId: 'PRJ-1' }
  const repositories = repos({ id: 'SUB-1', projectId: 'PRJ-1', project: '项目', userId: 'employee01',
    amount: 100, pay: '已缴款', profit: 0, action: '查看支付', idempotencyKey: 'idem',
    createdAt: '2026-08-28', paymentDeadlineAt: '2026-08-29' })
  await assert.doesNotReject(() => authorizeAssetRead({ userId: 'finance01', role: 'finance' }, proof, repositories))
  await assert.doesNotReject(() => authorizeAssetRead({ userId: 'admin01', role: 'super_admin' }, proof, repositories))
  await assert.rejects(() => authorizeAssetRead({ userId: 'employee01', role: 'employee' }, proof, repositories), /无权访问/)
})
