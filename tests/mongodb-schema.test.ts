import assert from 'node:assert/strict'
import test from 'node:test'
import { collectionName, indexDefinitions, transactionCapabilityError } from '../server/persistence/schema.ts'

test('production collection names are exact and test names use the approved prefix', () => {
  assert.equal(collectionName('projects', ''), 'projects')
  assert.equal(collectionName('file_assets', '__test_run_'), '__test_run_file_assets')
})

test('subscription idempotency ignores empty keys but remains unique for real keys', () => {
  const index = indexDefinitions.subscriptions.find(item => item.name === 'uniq_subscriptions_idempotency_key')
  assert.deepEqual(index?.partialFilterExpression, { idempotencyKey: { $gt: '' } })
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
