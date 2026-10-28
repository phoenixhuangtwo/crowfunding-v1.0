import assert from 'node:assert/strict'
import test from 'node:test'
import { readJsonBody, bodyContainsAccessToken } from '../server/http-json-body.ts'
import { parseIamJson } from '../server/iam/json.ts'

function request(raw: string) {
  return { async *[Symbol.asyncIterator]() { yield Buffer.from(raw) } }
}

test('business requests accept decimal payment amounts and preserve large integer identifiers', async () => {
  const result = await readJsonBody(request('{"result":"pass","actualPaidAmount":0.10,"transactionNo":"TX-1","id":9223372036854775807}'))
  assert.equal(result.actualPaidAmount, 0.1)
  assert.equal(result.id, 9223372036854775807n)
  assert.equal((await readJsonBody(request('{"actualPaidAmount":29.90}'))).actualPaidAmount, 29.9)
  assert.throws(() => parseIamJson('{"userId":0.1}'))
})

test('decimal business bodies retain duplicate-key and token placement protections', async () => {
  await assert.rejects(readJsonBody(request('{"actualPaidAmount":0.1,"actualPaidAmount":1}')))
  assert.equal(bodyContainsAccessToken(Buffer.from('{"actualPaidAmount":0.1,"nested":{"access_token":"not-allowed"}}')), true)
  assert.equal(bodyContainsAccessToken(Buffer.from('{"actualPaidAmount":0.1}')), false)
  await assert.rejects(readJsonBody(request('[0.1]')))
})
