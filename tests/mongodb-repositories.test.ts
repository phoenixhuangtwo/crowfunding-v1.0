import assert from 'node:assert/strict'
import test from 'node:test'
import type { Db } from 'mongodb'
import { createRepositories, entitiesDiffer, type AppRepositories, type EntityRepository } from '../server/persistence/repositories.ts'
import { QueryService, presentReceivingCode } from '../server/services/query-service.ts'

function emptyRepository<T extends { id: string }>(): EntityRepository<T> {
  return {
    async list() { return [] },
    async findOne() { return null },
    async getById() { return null },
    async insert() {},
    async replace() {},
    async sync() {},
    async deleteById() { return false },
    async count() { return 0 }
  }
}

function emptyRepositories(): AppRepositories {
  return {
    projects: emptyRepository(),
    subscriptions: emptyRepository(),
    rules: emptyRepository(),
    receivingCodes: emptyRepository(),
    auditLogs: emptyRepository(),
    riskEvents: emptyRepository(),
    fileAssets: emptyRepository()
  }
}

test('empty repositories stay empty instead of loading demo records', async () => {
  const queries = new QueryService(emptyRepositories())
  assert.deepEqual(await queries.listProjects(), [])
  assert.deepEqual(await queries.listSubscriptions(), [])
  assert.deepEqual(await queries.state(), {
    projects: [], subscriptions: [], rules: [], receivingCodes: [], auditLogs: [], riskEvents: []
  })
})

test('receiving-code file URLs are derived from internal asset IDs only', () => {
  const presented = presentReceivingCode({
    id: 'RCV-1',
    subject: '测试主体',
    accountNote: '测试账户',
    codeName: '测试收款码',
    status: '启用',
    updatedBy: 'finance01',
    updatedAt: '2026-08-28 12:00:00',
    imageAssetId: 'asset-1'
  })
  assert.equal(presented.imageUrl, '/api/files/asset-1/content')
  assert.equal(presented.imageAssetId, 'asset-1')
})

test('unchanged MongoDB documents are not selected for replacement', () => {
  assert.equal(entitiesDiffer({ id: 'PRJ-1', status: '未开放' }, { id: 'PRJ-1', status: '未开放' }), false)
  assert.equal(entitiesDiffer({ id: 'PRJ-1', status: '未开放' }, { id: 'PRJ-1', status: '已满额' }), true)
})

test('repository sync writes missing and changed documents in one bulk operation', async () => {
  const bulkCalls: Array<Array<Record<string, unknown>>> = []
  const collection = {
    find: () => ({
      toArray: async () => [
        { _id: 'mongo-1', id: 'PRJ-SAME', status: '未开放' },
        { _id: 'mongo-2', id: 'PRJ-CHANGED', status: '未开放' }
      ]
    }),
    bulkWrite: async (operations: Array<Record<string, unknown>>) => {
      bulkCalls.push(operations)
    }
  }
  const db = { collection: () => collection } as unknown as Db
  const repository = createRepositories(db).projects as EntityRepository<{ id: string; status: string }> & {
    sync?: (documents: Array<{ id: string; status: string }>) => Promise<void>
  }
  assert.equal(typeof repository.sync, 'function')

  await repository.sync!([
    { id: 'PRJ-SAME', status: '未开放' },
    { id: 'PRJ-CHANGED', status: '已满额' },
    { id: 'PRJ-NEW', status: '未开放' }
  ])

  assert.equal(bulkCalls.length, 1)
  assert.equal(bulkCalls[0]?.length, 2)
  assert.deepEqual(bulkCalls[0]?.map(operation => {
    const replaceOne = operation.replaceOne as { filter: { id: string }; upsert: boolean }
    return { id: replaceOne.filter.id, upsert: replaceOne.upsert }
  }), [
    { id: 'PRJ-CHANGED', upsert: true },
    { id: 'PRJ-NEW', upsert: true }
  ])
})
