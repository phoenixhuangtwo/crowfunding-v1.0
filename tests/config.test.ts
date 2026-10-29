import assert from 'node:assert/strict'
import test from 'node:test'
import { loadAppConfig } from '../server/config.ts'

const valid = {
  MONGODB_URI: 'mongodb://example.invalid:27017/?replicaSet=rs0',
  MONGODB_DB: 'crowfunding',
  COS_SECRET_ID: 'configured-secret-id',
  COS_SECRET_KEY: 'configured-secret-key',
  COS_BUCKET: 'private-bucket-1250000000',
  COS_REGION: 'ap-guangzhou',
  COS_OBJECT_PREFIX: 'crowfunding'
}

test('configuration requires the exact crowfunding database', () => {
  assert.equal(loadAppConfig(valid).mongodb.database, 'crowfunding')
  assert.throws(() => loadAppConfig({ ...valid, MONGODB_DB: 'crowdfunding' }), /MONGODB_DB 必须为 crowfunding/)
})

test('configuration reports missing names without exposing values', () => {
  assert.throws(() => loadAppConfig({ ...valid, COS_SECRET_KEY: '' }), error => {
    assert.match(String(error), /COS_SECRET_KEY/)
    assert.doesNotMatch(String(error), /configured-secret/)
    return true
  })
})

test('collection prefixes are limited to isolated tests', () => {
  assert.throws(() => loadAppConfig({ ...valid, MONGODB_COLLECTION_PREFIX: '__test_run_' }), /仅测试环境/)
  assert.equal(loadAppConfig({ ...valid, NODE_ENV: 'test', MONGODB_COLLECTION_PREFIX: '__test_run_' }).mongodb.collectionPrefix, '__test_run_')
  assert.throws(
    () => loadAppConfig({ ...valid, NODE_ENV: 'test', MONGODB_COLLECTION_PREFIX: 'projects_' }),
    /不是安全测试前缀/
  )
})
