import assert from 'node:assert/strict'
import test from 'node:test'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { parseBearer } from '../server/auth/bearer.ts'
import { authenticateRequest, permissionInfoForClient, requireApiPermission, validateReviewAction, type AuthBoundaryError } from '../server/auth/middleware.ts'
import { bodyContainsAccessToken, readJsonBody } from '../server/http-json-body.ts'
import { IamDeniedError, IamProtocolError, IamUnauthorizedError, IamUnavailableError } from '../server/iam/errors.ts'

const claims = { active: true as const, userId: '9223372036854775807', tenantId: '0', clientId: 'crowdfunding' as const, scopes: ['openid'] }
const request = (headers: IncomingHttpHeaders): IncomingMessage => ({ headers, rawHeaders: [], method: 'GET', url: '/api/projects' } as unknown as IncomingMessage)

test('parses exactly one safe Bearer header and preserves token bytes', () => {
  assert.equal(parseBearer({ authorization: 'Bearer token-._~+/=' }), 'token-._~+/=')
  assert.throws(() => parseBearer({}), /唯一 Bearer/)
  assert.throws(() => parseBearer({ authorization: ['Bearer one', 'Bearer two'] } as unknown as IncomingHttpHeaders), /唯一 Bearer/)
  assert.throws(() => parseBearer({ authorization: 'Basic x' }), /Bearer/)
  assert.throws(() => parseBearer({ authorization: 'Bearer ' }), /Bearer/)
  assert.throws(() => parseBearer({ authorization: `Bearer ${'x'.repeat(513)}` }), /过长/)
  assert.throws(() => parseBearer({ authorization: 'Bearer one,two' }), /Bearer/)
  assert.throws(() => parseBearer({ authorization: 'Bearer one\r\ntwo' }), /Bearer/)
  assert.throws(() => parseBearer({ authorization: 'Bearer query-token', access_token: 'other' } as IncomingHttpHeaders), /唯一|凭证/)
  assert.throws(() => parseBearer({ authorization: ['Bearer one'] } as unknown as IncomingHttpHeaders), /唯一 Bearer/)
})

test('raw duplicate Authorization lines are rejected', () => {
  const headers = { authorization: 'Bearer one', rawHeaders: ['Authorization', 'Bearer one', 'authorization', 'Bearer two'] } as unknown as IncomingHttpHeaders
  assert.throws(() => parseBearer(headers), /唯一 Bearer/)
})

test('authentication checks token before exactly one route decision and returns frozen server context', async () => {
  const calls: string[] = []
  const iam = {
    checkToken: async (token: string) => { calls.push(`check:${token}`); return claims },
    decideApi: async (token: string, code: string, tenant: string) => { calls.push(`decide:${token}:${code}:${tenant}`); return true }
  }
  const context = await authenticateRequest(request({ authorization: 'Bearer exact-token', 'x-user-id': 'browser', 'x-user-role': 'admin' }), { iam })
  assert.deepEqual(context, { accessToken: 'exact-token', tenantId: '0', userId: claims.userId, clientId: 'crowdfunding', scopes: ['openid'] })
  assert.equal(Object.isFrozen(context), true)
  assert.equal(Object.isFrozen(context.scopes), true)
  assert.deepEqual(calls, ['check:exact-token', 'decide:exact-token:crowdfunding:project:query:0'])
})

test('permissionInfo is hydrated after decision and projected with menus and API/UI permissions', async () => {
  const calls: string[] = []
  const info = {
    user: { id: claims.userId, username: 'iam-user', nickname: 'IAM 用户', deptId: 'dept-1' },
    roleCodes: ['crowdfunding:operator'],
    permissions: ['crowdfunding:project:query'],
    apiPermissions: ['crowdfunding:project:query', 'crowdfunding:project:open'],
    uiPermissions: ['crowdfunding:project:open-button'],
    clientId: 'crowdfunding' as const,
    dataScope: { all: false, self: true, deptIds: ['dept-1'] },
    menus: [{ id: 'projects', name: '项目', path: '/projects', children: [{ id: 'mine', name: '我的项目', path: '/mine', children: [] }] }]
  }
  const iam = {
    checkToken: async () => { calls.push('check'); return claims },
    decideApi: async () => { calls.push('decide'); return true },
    permissionInfo: async () => { calls.push('permissionInfo'); return info }
  }
  const context = await authenticateRequest(request({ authorization: 'Bearer projected-token' }), { iam })
  assert.deepEqual(calls, ['check', 'decide', 'permissionInfo'])
  assert.deepEqual(permissionInfoForClient(context), {
    user: info.user,
    roles: info.roleCodes,
    roleCodes: info.roleCodes,
    permissions: info.permissions,
    apiPermissions: info.apiPermissions,
    uiPermissions: info.uiPermissions,
    menus: info.menus,
    dataScope: info.dataScope,
    clientId: 'crowdfunding',
    tenantId: '0'
  })
  assert.equal(Object.isFrozen(context.permissions), true)
  assert.equal(Object.isFrozen(context.apiPermissions), true)
  assert.equal(Object.isFrozen(context.uiPermissions), true)
  assert.equal(Object.isFrozen(context.menus), true)
  assert.equal(Object.isFrozen(context.menus?.[0]), true)
  assert.equal(Object.isFrozen(context.menus?.[0]?.children), true)
})

test('permission-info identity must match the checked token subject', async () => {
  const iam = {
    checkToken: async () => claims,
    decideApi: async () => true,
    permissionInfo: async () => ({
      user: { id: '9999', username: 'other', nickname: 'Other' },
      roleCodes: ['employee'], permissions: [], apiPermissions: [], uiPermissions: [],
      clientId: 'crowdfunding' as const, dataScope: { all: false, self: true, deptIds: [] }, menus: []
    })
  }
  await assert.rejects(authenticateRequest(request({ authorization: 'Bearer mismatched-token' }), { iam }),
    (error: AuthBoundaryError) => error.status === 503 && error.code === 'IAM_UNAVAILABLE')
})

test('check-token failure makes no decision and maps IAM failures without token leakage', async () => {
  for (const failure of [new IamUnauthorizedError(), new IamUnavailableError(), new IamProtocolError()]) {
    const calls: string[] = []
    const iam = {
      checkToken: async () => { calls.push('check'); throw failure },
      decideApi: async () => { calls.push('decide'); return true }
    }
    await assert.rejects(authenticateRequest(request({ authorization: 'Bearer secret-token' }), { iam }), (error: AuthBoundaryError) => {
      assert.equal(error.status, failure instanceof IamUnauthorizedError ? 401 : 503)
      assert.match(error.code, failure instanceof IamUnauthorizedError ? /AUTH_REQUIRED/ : /IAM_UNAVAILABLE/)
      assert.doesNotMatch(error.message, /secret-token/)
      return true
    })
    assert.deepEqual(calls, ['check'])
  }
})

test('authenticated tenant must match the configured disabled-tenant default', async () => {
  const iam = {
    checkToken: async () => ({ ...claims, tenantId: '42' }),
    decideApi: async () => true,
    config: { multiTenantEnabled: false, defaultTenantId: '0' }
  }
  await assert.rejects(authenticateRequest(request({ authorization: 'Bearer tenant-token' }), { iam }), (error: AuthBoundaryError) => error.code === 'AUTH_REQUIRED' && error.status === 401)
})

test('JSON body is buffered once and body access_token is rejected before IAM', async () => {
  const req = {
    headers: { 'content-length': '29', 'content-type': 'application/json' },
    body: undefined,
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"access_token":"body-token"}') }
  } as never
  const body = await readJsonBody(req)
  assert.equal(body.access_token, 'body-token')
  const calls: string[] = []
  await assert.rejects(authenticateRequest(req, { iam: { checkToken: async () => { calls.push('check'); return claims }, decideApi: async () => { calls.push('decide'); return true } } }), (error: AuthBoundaryError) => error.code === 'AUTH_REQUIRED')
  assert.deepEqual(calls, [])
  assert.deepEqual(await readJsonBody(req), body)
})

test('review action validator rejects empty, unknown, duplicate, and multiple action forms before IAM', () => {
  assert.equal(validateReviewAction({ result: 'approve' }), 'crowdfunding:payment-review:approve')
  for (const body of [{}, { result: '' }, { result: 'approve,reject' }, { result: 'approve', action: 'reject' }, { result: ['approve'] }]) {
    assert.throws(() => validateReviewAction(body), /复核动作无效/)
  }
})

test('strict JSON rejects duplicate action keys and multipart scanner detects access_token fields', async () => {
  const duplicate = {
    headers: { 'content-length': '31' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"result":"approve","result":"reject"}') }
  } as never
  await assert.rejects(readJsonBody(duplicate), /合法的 JSON 对象/)
  const boundary = '----smoke-boundary'
  const multipart = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="access_token"\r\n\r\nbody-token\r\n--${boundary}--\r\n`)
  assert.equal(bodyContainsAccessToken(multipart, `multipart/form-data; boundary=${boundary}`), true)
})

test('multipart pre-scan rejects nested credential JSON in an otherwise ordinary field', () => {
  const boundary = '----nested-boundary'
  const multipart = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="operator"\r\n\r\n{"nested":{"access\\u005ftoken":"body-token"}}\r\n--${boundary}--\r\n`)
  assert.equal(bodyContainsAccessToken(multipart, `multipart/form-data; boundary=${boundary}`), true)
})

test('multipart pre-scan accepts RFC token-form disposition parameters and skips token-form files', () => {
  const boundary = '----token-form-boundary'
  const multipart = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name=operator\r\n\r\nhello\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name=image; filename=receipt.png\r\nContent-Type: image/png\r\n\r\n`),
    Buffer.from([0, 255, 1, 2, 3, 4]),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ])
  assert.equal(bodyContainsAccessToken(multipart, `multipart/form-data; boundary=${boundary}`), false)
  const unknownParameter = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name=operator; extension=ignored\r\n\r\nhello\r\n--${boundary}--\r\n`)
  assert.equal(bodyContainsAccessToken(unknownParameter, `multipart/form-data; boundary=${boundary}`), true)
  const missingName = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; filename=receipt.png\r\n\r\nhello\r\n--${boundary}--\r\n`)
  assert.equal(bodyContainsAccessToken(missingName, `multipart/form-data; boundary=${boundary}`), true)
})

test('multipart pre-scan rejects control characters in quoted disposition parameters', () => {
  const boundary = '----control-boundary'
  const control = String.fromCharCode(1)
  const field = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="operator${control}"\r\n\r\nhello\r\n--${boundary}--\r\n`, 'latin1')
  assert.equal(bodyContainsAccessToken(field, `multipart/form-data; boundary=${boundary}`), true)
  const file = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="receipt${control}.png"\r\nContent-Type: image/png\r\n\r\n`, 'latin1'),
    Buffer.from([0, 255, 1]),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1')
  ])
  assert.equal(bodyContainsAccessToken(file, `multipart/form-data; boundary=${boundary}`), true)
})

test('decision outcomes map to 403 and 503, and action gate is fresh', async () => {
  const calls: string[] = []
  const context = Object.freeze({ accessToken: 't', tenantId: '0', userId: '1', clientId: 'crowdfunding' as const, scopes: Object.freeze(['openid']) })
  const iam = { decideApi: async (...args: [string, string, string]) => { calls.push(args.join(':')); return true } }
  await requireApiPermission(context, 'crowdfunding:payment-review:approve', { iam })
  await requireApiPermission(context, 'crowdfunding:payment-review:approve', { iam })
  assert.equal(calls.length, 2)
  await assert.rejects(requireApiPermission(context, 'crowdfunding:payment-review:reject', { iam: { decideApi: async () => { throw new IamDeniedError() } } }), (error: AuthBoundaryError) => error.code === 'PERMISSION_DENIED')
  await assert.rejects(requireApiPermission(context, 'crowdfunding:payment-review:reject', { iam: { decideApi: async () => { throw new IamUnavailableError() } } }), (error: AuthBoundaryError) => error.code === 'IAM_UNAVAILABLE')
})
