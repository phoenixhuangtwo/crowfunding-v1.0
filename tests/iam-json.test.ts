import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeIamId, parseIamJson } from '../server/iam/json.ts'

test('parseIamJson preserves IAM Long IDs exactly through normalization', () => {
  const envelope = parseIamJson('{"code":0,"data":{"user_id":9223372036854775807,"tenant_id":0,"deptIds":[9007199254740993]}}') as {
    data: { user_id: unknown; tenant_id: unknown; deptIds: unknown[] }
  }

  assert.equal(normalizeIamId(envelope.data.user_id), '9223372036854775807')
  assert.equal(normalizeIamId(envelope.data.tenant_id, { allowZero: true }), '0')
  assert.equal(normalizeIamId(envelope.data.deptIds[0]), '9007199254740993')
})

test('normalizeIamId accepts canonical positive decimal strings and safe integer numbers only', () => {
  assert.equal(normalizeIamId('42'), '42')
  assert.equal(normalizeIamId(42), '42')
  assert.equal(normalizeIamId('00042'), '42')
  assert.equal(normalizeIamId(0, { allowZero: true }), '0')

  for (const value of ['', ' ', '-1', '1.5', '1e3', '+1', '0', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeIamId(value), /IAM ID/)
  }
})

test('normalizeIamId never rescues a non-safe Number after precision is lost', () => {
  assert.throws(() => normalizeIamId(9223372036854775807), /安全整数/)
})

test('normalizeIamId rejects negative zero even when zero is otherwise allowed', () => {
  assert.throws(() => normalizeIamId(-0, { allowZero: true }), /IAM ID/)
})

test('parseIamJson rejects exponent and fraction tokens before they can masquerade as IDs', () => {
  assert.throws(() => parseIamJson('{"id":1e3}'), SyntaxError)
  assert.throws(() => parseIamJson('{"id":1.0}'), SyntaxError)
})

test('parseIamJson rejects malformed JSON instead of silently coercing it', () => {
  assert.throws(() => parseIamJson('{"data":'), SyntaxError)
})
