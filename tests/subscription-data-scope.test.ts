import assert from 'node:assert/strict'
import test from 'node:test'
import type { AppRepositories } from '../server/persistence/repositories.ts'
import type { FileAsset, Subscription } from '../server/domain/models.ts'
import { authorizeAssetRead } from '../server/request-context.ts'
import { QueryService } from '../server/services/query-service.ts'

const subscriptions = [
  { id: 'SUB-A', projectId: 'PRJ-1', userId: 'employee-a', pay: '未缴款' },
  { id: 'SUB-B', projectId: 'PRJ-1', userId: 'employee-b', pay: '未缴款' },
  { id: 'SUB-C', projectId: 'PRJ-1', userId: 'employee-c', pay: '已释放' }
] as Subscription[]

const repositories = {
  subscriptions: {
    async list(filter: { userId?: string } = {}) {
      return subscriptions.filter(item => !filter.userId || item.userId === filter.userId)
    },
    async findOne(filter: { userId: string; projectId: { $in: string[] }; pay: { $ne: string } }) {
      return subscriptions.find(item => item.userId === filter.userId
        && filter.projectId.$in.includes(item.projectId) && item.pay !== filter.pay.$ne) ?? null
    }
  },
  rules: {
    async list(filter: { receivingCodeId: string }) {
      return filter.receivingCodeId === 'RCV-1' ? [{ projectId: 'PRJ-1', receivingCodeId: 'RCV-1' }] : []
    }
  }
} as unknown as AppRepositories

const receivingCodeAsset = {
  id: 'ASSET-1', status: 'ready', purpose: 'receiving-code', ownerId: 'RCV-1'
} as FileAsset

test('employee subscription queries are restricted to that employee', async () => {
  const service = new QueryService(repositories)
  assert.deepEqual((await service.listSubscriptions({ userId: 'employee-a', role: 'employee' })).map(item => item.id), ['SUB-A'])
  assert.equal((await service.listSubscriptions({ userId: 'finance-1', role: 'finance' })).length, 3)
})

test('employee can open a receiving code only with an active linked subscription', async () => {
  await assert.doesNotReject(() => authorizeAssetRead({ userId: 'employee-a', role: 'employee' }, receivingCodeAsset, repositories))
  await assert.rejects(() => authorizeAssetRead({ userId: 'employee-other', role: 'employee' }, receivingCodeAsset, repositories), /无权访问/)
  await assert.rejects(() => authorizeAssetRead({ userId: 'employee-c', role: 'employee' }, receivingCodeAsset, repositories), /无权访问/)
})
