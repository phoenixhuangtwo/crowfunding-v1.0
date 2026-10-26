import assert from 'node:assert/strict'
import test from 'node:test'
import type { IncomingMessage } from 'node:http'
import { requestContext, setAuthenticatedContext } from '../server/request-context.ts'
import type { IamRequestContext } from '../server/iam/types.ts'

const base: IamRequestContext = {
  accessToken: 'test-token', tenantId: '0', userId: '1001', clientId: 'crowdfunding',
  scopes: ['openid'], dataScope: { all: false, self: true, deptIds: [] }
}

function request(roles: readonly string[]) {
  const req = {} as IncomingMessage
  setAuthenticatedContext(req, { ...base, roleCodes: roles })
  return req
}

test('IAM role is required and conflicting duties are rejected', () => {
  assert.deepEqual(requestContext(request(['employee'])), { userId: '1001', role: 'employee' })
  assert.deepEqual(requestContext(request(['finance'])), { userId: '1001', role: 'finance' })
  assert.deepEqual(requestContext(request(['crowdfunding_employee'])), { userId: '1001', role: 'employee' })
  assert.deepEqual(requestContext(request(['crowdfunding_admin'])), { userId: '1001', role: 'admin' })
  assert.deepEqual(requestContext(request(['crowdfunding_finance'])), { userId: '1001', role: 'finance' })
  assert.deepEqual(requestContext(request(['crowdfunding_super_admin'])), { userId: '1001', role: 'super_admin' })
  assert.throws(() => requestContext(request([])), /IAM 角色缺失或存在职责冲突/)
  assert.throws(() => requestContext(request(['finance', 'admin'])), /IAM 角色缺失或存在职责冲突/)
})
