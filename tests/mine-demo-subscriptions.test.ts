import assert from 'node:assert/strict'
import test from 'node:test'
import type { AppRepositories, EntityRepository } from '../server/persistence/repositories.ts'
import { QueryService } from '../server/services/query-service.ts'

function emptyRepository<T extends { id: string }>(): EntityRepository<T> {
  return {
    async list() { return [] },
    async findOne() { return null },
    async getById() { return null },
    async insert() {},
    async replace() {},
    async deleteById() { return false },
    async count() { return 0 }
  }
}

test('empty MongoDB state stays empty instead of loading payment demos', async () => {
  const repositories: AppRepositories = {
    projects: emptyRepository(),
    subscriptions: emptyRepository(),
    rules: emptyRepository(),
    receivingCodes: emptyRepository(),
    auditLogs: emptyRepository(),
    riskEvents: emptyRepository(),
    fileAssets: emptyRepository()
  }
  assert.deepEqual(await new QueryService(repositories).listSubscriptions(), [])
})
