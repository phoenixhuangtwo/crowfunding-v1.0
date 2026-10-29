import assert from 'node:assert/strict'
import test from 'node:test'
import type { Db } from 'mongodb'
import { collectionName, ensureSchema, indexDefinitions, transactionCapabilityError } from '../server/persistence/schema.ts'

test('production collection names are exact and test names use the approved prefix', () => {
  assert.equal(collectionName('projects', ''), 'projects')
  assert.equal(collectionName('file_assets', '__test_run_'), '__test_run_file_assets')
})

test('subscription idempotency ignores empty keys but remains unique for real keys', () => {
  const index = indexDefinitions.subscriptions.find(item => item.name === 'uniq_subscriptions_idempotency_key')
  assert.deepEqual(index?.partialFilterExpression, { idempotencyKey: { $gt: '' } })
  assert.equal(index?.unique, true)
})

test('receiving-code creation request IDs remain unique when users submit repeatedly', () => {
  const index = indexDefinitions.receiving_codes.find(item => item.name === 'uniq_receiving_codes_create_request_id')
  assert.deepEqual(index?.partialFilterExpression, { createRequestId: { $gt: '' } })
  assert.equal(index?.unique, true)
})

test('transactions require a replica set or mongos deployment', () => {
  assert.match(transactionCapabilityError({ isWritablePrimary: true }), /事务/)
  assert.equal(transactionCapabilityError({ setName: 'rs0', isWritablePrimary: true }), null)
  assert.equal(transactionCapabilityError({ msg: 'isdbgrid', isWritablePrimary: true }), null)
})

test('schema contains no TTL indexes or automatic cleanup policy', () => {
  for (const definitions of Object.values(indexDefinitions)) {
    for (const definition of definitions) assert.equal('expireAfterSeconds' in definition, false)
  }
})

test('schema creation omits partialFilterExpression from indexes that do not define one', async () => {
  const calls: Array<{ name: string; options: Record<string, unknown> }> = []
  const db = {
    listCollections: () => ({ toArray: async () => [] }),
    createCollection: async () => undefined,
    collection: (name: string) => ({
      createIndex: async (_key: Record<string, number>, options: Record<string, unknown>) => {
        calls.push({ name, options })
      }
    })
  } as unknown as Db

  await ensureSchema(db)

  const ordinaryIndex = calls.find(call => call.options.name === 'uniq_projects_id')
  assert.ok(ordinaryIndex)
  assert.equal('partialFilterExpression' in ordinaryIndex.options, false)

  const nonUniqueIndex = calls.find(call => call.options.name === 'idx_projects_status')
  assert.ok(nonUniqueIndex)
  assert.equal('unique' in nonUniqueIndex.options, false)

  const partialIndex = calls.find(call => call.options.name === 'uniq_subscriptions_idempotency_key')
  assert.deepEqual(partialIndex?.options.partialFilterExpression, { idempotencyKey: { $gt: '' } })
})
