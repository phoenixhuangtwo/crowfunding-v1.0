import assert from 'node:assert/strict'
import test from 'node:test'
import { AgreementError, validateAgreement } from '../server/agreements.ts'

test('agreement title and body follow V1.1 limits without discarding original meaning', () => {
  const result = validateAgreement('  员工免责协议  ', `  ${'员工独立承担税费。'.repeat(7)}  `)
  assert.equal(result.title, '员工免责协议')
  assert.equal(result.body, '员工独立承担税费。'.repeat(7))
  assert.throws(() => validateAgreement('', 'x'.repeat(50)), (error: unknown) => error instanceof AgreementError && error.code === 'AGREEMENT_TITLE_REQUIRED')
  assert.throws(() => validateAgreement('有效标题', 'x'.repeat(49)), (error: unknown) => error instanceof AgreementError && error.code === 'AGREEMENT_BODY_INVALID')
  assert.throws(() => validateAgreement('有效标题', 'x'.repeat(5001)), (error: unknown) => error instanceof AgreementError && error.code === 'AGREEMENT_BODY_INVALID')
})
