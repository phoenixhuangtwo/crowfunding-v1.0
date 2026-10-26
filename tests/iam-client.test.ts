import assert from 'node:assert/strict'
import test from 'node:test'
import JSONBig from 'json-bigint'
import type { IamConfig } from '../server/iam/config.ts'
import { IamClient } from '../server/iam/client.ts'
import {
  IamDeniedError,
  IamProtocolError,
  IamUnauthorizedError,
  IamUnavailableError
} from '../server/iam/errors.ts'

const config: IamConfig = {
  baseUrl: new URL('https://iam.example.test/'),
  clientId: 'crowdfunding',
  clientSecret: 'top-secret',
  redirectUri: new URL('https://crowdfunding.example.test/api/auth/callback'),
  scopes: ['openid', 'profile'],
  connectTimeoutMs: 40,
  readTimeoutMs: 40,
  refreshCookieSecure: true,
  allowedOrigin: 'https://crowdfunding.example.test',
  multiTenantEnabled: false,
  defaultTenantId: '0'
}

type CapturedRequest = {
  url: URL
  method: string
  headers: Headers
  body: string
  signal?: AbortSignal | null
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const fixtureJson = JSONBig({ strict: true, useNativeBigInt: true })

function success(data: unknown): Response {
  return new Response(fixtureJson.stringify({ code: 0, message: 'success', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function queuedFetch(responses: readonly Response[]): {
  fetch: FetchLike
  requests: CapturedRequest[]
} {
  const requests: CapturedRequest[] = []
  let index = 0
  return {
    requests,
    fetch: async (input, init = {}) => {
      requests.push({
        url: new URL(typeof input === 'string' || input instanceof URL ? input : input.url),
        method: init.method ?? 'GET',
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? init.body : '',
        signal: init.signal
      })
      const response = responses[index]
      index += 1
      if (!response) throw new Error('test response queue exhausted')
      return response
    }
  }
}

function form(request: CapturedRequest): URLSearchParams {
  return new URLSearchParams(request.body)
}

test('all IAM operations use the source-defined paths, methods, credentials and payloads', async () => {
  const transport = queuedFetch([
    success({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      token_type: 'Bearer',
      expires_in: 3600,
      client_id: 'crowdfunding',
      scopes: ['openid', 'profile'],
      tenant_id: 0
    }),
    success({
      access_token: 'access-refreshed',
      refresh_token: 'refresh-rotated',
      token_type: 'Bearer',
      expires_in: 3500,
      client_id: 'crowdfunding',
      scopes: ['openid', 'profile'],
      tenant_id: 0
    }),
    success(true),
    success({
      active: true,
      user_id: 9223372036854775807n,
      tenant_id: 0,
      client_id: 'crowdfunding',
      scopes: ['openid', 'profile']
    }),
    success({ subjectValid: true, allowed: true }),
    success({
      user: {
        id: 9223372036854775807n,
        username: 'crowdfunding-user',
        nickname: '众筹用户',
        avatar: null,
        deptId: 9007199254740993n
      },
      roles: ['employee'],
      permissions: ['crowdfunding:access'],
      apiPermissions: ['crowdfunding:project:query'],
      uiPermissions: ['crowdfunding:project:view'],
      clientId: 'crowdfunding',
      dataScope: { all: false, self: true, deptIds: [9007199254740993n] },
      menus: [{
        id: 9007199254740995n,
        parentId: 0,
        name: '项目',
        icon: 'Folder',
        path: '/projects',
        component: 'ProjectsPage',
        componentName: 'Projects',
        type: 1,
        sort: 10,
        visible: 0,
        keepAlive: true,
        alwaysShow: false,
        permission: 'crowdfunding:project:view',
        children: []
      }]
    }),
    success({ all: false, self: true, deptIds: [9007199254740993n] })
  ])
  const client = new IamClient(config, { fetch: transport.fetch })

  assert.deepEqual(await client.exchangeCode({
    code: 'one-time-code',
    state: 'oauth-state',
    verifier: 'pkce-verifier'
  }), {
    accessToken: 'access-new',
    refreshToken: 'refresh-new',
    tokenType: 'Bearer',
    expiresIn: 3600,
    clientId: 'crowdfunding',
    scopes: ['openid', 'profile'],
    tenantId: '0'
  })
  assert.deepEqual(await client.refresh('refresh-old'), {
    accessToken: 'access-refreshed',
    refreshToken: 'refresh-rotated',
    tokenType: 'Bearer',
    expiresIn: 3500,
    clientId: 'crowdfunding',
    scopes: ['openid', 'profile'],
    tenantId: '0'
  })
  assert.equal(await client.revoke('access-revoke'), true)
  assert.deepEqual(await client.checkToken('access-check'), {
    active: true,
    userId: '9223372036854775807',
    tenantId: '0',
    clientId: 'crowdfunding',
    scopes: ['openid', 'profile']
  })
  assert.equal(await client.decideApi('access-decide', 'crowdfunding:access', '0'), true)
  assert.deepEqual(await client.permissionInfo('access-info'), {
    user: {
      id: '9223372036854775807',
      username: 'crowdfunding-user',
      nickname: '众筹用户',
      deptId: '9007199254740993'
    },
    roleCodes: ['employee'],
    permissions: ['crowdfunding:access'],
    apiPermissions: ['crowdfunding:project:query'],
    uiPermissions: ['crowdfunding:project:view'],
    clientId: 'crowdfunding',
    dataScope: {
      all: false,
      self: true,
      deptIds: ['9007199254740993']
    },
    menus: [{
      id: '9007199254740995',
      parentId: '0',
      name: '项目',
      icon: 'Folder',
      path: '/projects',
      component: 'ProjectsPage',
      componentName: 'Projects',
      type: 1,
      sort: 10,
      visible: 0,
      keepAlive: true,
      alwaysShow: false,
      permission: 'crowdfunding:project:view',
      children: []
    }]
  })
  assert.deepEqual(await client.dataScope('9223372036854775807', '0'), {
    all: false,
    self: true,
    deptIds: ['9007199254740993']
  })

  assert.deepEqual(transport.requests.map(request => [request.method, request.url.pathname]), [
    ['POST', '/api/oauth2/token'],
    ['POST', '/api/oauth2/token'],
    ['POST', '/api/oauth2/revoke'],
    ['POST', '/api/oauth2/check-token'],
    ['POST', '/api/oauth2/permission/decision'],
    ['GET', '/api/auth/permission-info'],
    ['POST', '/rpc-api/system/permission/data-scope']
  ])

  const expectedBasic = 'Basic Y3Jvd2RmdW5kaW5nOnRvcC1zZWNyZXQ='
  for (const index of [0, 1, 2, 3, 4, 6]) {
    assert.equal(transport.requests[index].headers.get('authorization'), expectedBasic)
    assert.equal(transport.requests[index].headers.get('tenant-id'), null)
  }
  assert.equal(transport.requests[5].headers.get('authorization'), 'Bearer access-info')
  assert.equal(transport.requests[5].headers.get('tenant-id'), null)

  assert.deepEqual(Object.fromEntries(form(transport.requests[0])), {
    grant_type: 'authorization_code',
    code: 'one-time-code',
    redirect_uri: 'https://crowdfunding.example.test/api/auth/callback',
    state: 'oauth-state',
    code_verifier: 'pkce-verifier'
  })
  assert.deepEqual(Object.fromEntries(form(transport.requests[1])), {
    grant_type: 'refresh_token',
    refresh_token: 'refresh-old'
  })
  assert.deepEqual(Object.fromEntries(form(transport.requests[2])), { token: 'access-revoke' })
  assert.deepEqual(Object.fromEntries(form(transport.requests[3])), { token: 'access-check' })
  assert.deepEqual(Object.fromEntries(form(transport.requests[4])), {
    access_token: 'access-decide',
    api_code: 'crowdfunding:access'
  })
  assert.equal(transport.requests[6].body, '{"userId":9223372036854775807,"clientId":"crowdfunding"}')
})

test('permissionInfo preserves empty optional strings while keeping null or missing optionals absent', async () => {
  const transport = queuedFetch([
    success({
      user: {
        id: 1,
        username: 'user-one',
        nickname: '用户一',
        avatar: '',
        deptId: null
      },
      roles: [],
      permissions: [],
      apiPermissions: [],
      uiPermissions: [],
      clientId: 'crowdfunding',
      dataScope: { all: true, self: false, deptIds: [] },
      menus: [{
        id: 2,
        parentId: null,
        name: '空值菜单',
        icon: '',
        path: '',
        component: '',
        componentName: '',
        permission: '',
        children: [{
          id: 3,
          name: '可选字段缺失',
          icon: null,
          path: null,
          children: []
        }]
      }]
    })
  ])

  assert.deepEqual(await new IamClient(config, { fetch: transport.fetch }).permissionInfo('access-info'), {
    user: {
      id: '1',
      username: 'user-one',
      nickname: '用户一',
      avatar: ''
    },
    roleCodes: [],
    permissions: [],
    apiPermissions: [],
    uiPermissions: [],
    clientId: 'crowdfunding',
    dataScope: { all: true, self: false, deptIds: [] },
    menus: [{
      id: '2',
      name: '空值菜单',
      icon: '',
      path: '',
      component: '',
      componentName: '',
      permission: '',
      children: [{ id: '3', name: '可选字段缺失', children: [] }]
    }]
  })
})

test('permissionInfo still rejects empty required strings', async () => {
  const transport = queuedFetch([
    success({
      user: { id: 1, username: '', nickname: '用户一' },
      roles: [],
      permissions: [],
      apiPermissions: [],
      uiPermissions: [],
      clientId: 'crowdfunding',
      dataScope: { all: false, self: true, deptIds: [] },
      menus: []
    })
  ])

  await assert.rejects(
    () => new IamClient(config, { fetch: transport.fetch }).permissionInfo('access-info'),
    IamProtocolError
  )
})

test('enabled multi-tenancy accepts the token tenant and forwards exact normalized tenant headers', async () => {
  const enabledConfig = {
    ...config,
    multiTenantEnabled: true,
    defaultTenantId: '42'
  }
  const transport = queuedFetch([
    success({
      active: true,
      user_id: 9007199254740993n,
      tenant_id: 9223372036854775807n,
      client_id: 'crowdfunding',
      scopes: ['openid']
    }),
    success({ subjectValid: true, allowed: true }),
    success({ all: true, self: false, deptIds: [] })
  ])
  const client = new IamClient(enabledConfig, { fetch: transport.fetch })

  const claims = await client.checkToken('enabled-token')
  assert.equal(claims.tenantId, '9223372036854775807')
  await client.decideApi('enabled-token', 'crowdfunding:access', claims.tenantId)
  await client.dataScope(claims.userId, claims.tenantId)

  assert.equal(transport.requests[0].headers.get('tenant-id'), null)
  assert.equal(transport.requests[1].headers.get('tenant-id'), '9223372036854775807')
  assert.equal(transport.requests[2].headers.get('tenant-id'), '9223372036854775807')
})

test('checkToken rejects inactive, wrong-client and wrong-tenant claims as unauthorized', async () => {
  for (const data of [
    { active: false, user_id: 1, tenant_id: 0, client_id: 'crowdfunding', scopes: [] },
    { active: true, user_id: 1, tenant_id: 0, client_id: 'other-client', scopes: [] },
    { active: true, user_id: 1, tenant_id: 7, client_id: 'crowdfunding', scopes: [] }
  ]) {
    const transport = queuedFetch([success(data)])
    const client = new IamClient(config, { fetch: transport.fetch })
    await assert.rejects(() => client.checkToken('opaque-token'), IamUnauthorizedError)
  }
})

test('strict success envelopes reject empty, malformed, wrong-code, missing-data and wrong-shape responses', async () => {
  const cases = [
    new Response('', { status: 200 }),
    new Response('{"code":', { status: 200 }),
    new Response('{"code":7,"data":{}}', { status: 200 }),
    new Response('{"code":0}', { status: 200 }),
    success({ active: true, user_id: 'not-an-id', tenant_id: 0, client_id: 'crowdfunding', scopes: [] })
  ]

  for (const response of cases) {
    const transport = queuedFetch([response])
    const client = new IamClient(config, { fetch: transport.fetch })
    await assert.rejects(() => client.checkToken('opaque-token'), IamProtocolError)
  }
})

test('an explicit denied decision is distinguishable from transport and token failures', async () => {
  const denied = queuedFetch([success({ subjectValid: true, allowed: false })])
  await assert.rejects(
    () => new IamClient(config, { fetch: denied.fetch }).decideApi('access-token', 'crowdfunding:access', '0'),
    IamDeniedError
  )

  for (const status of [400, 401, 403]) {
    const transport = queuedFetch([new Response('{"code":401}', { status })])
    await assert.rejects(
      () => new IamClient(config, { fetch: transport.fetch }).checkToken('access-token'),
      IamUnauthorizedError
    )
  }
})

test('an impossible decision state is a protocol failure rather than an ordinary denial', async () => {
  const impossible = queuedFetch([success({ subjectValid: false, allowed: true })])
  await assert.rejects(
    () => new IamClient(config, { fetch: impossible.fetch }).decideApi('access-token', 'crowdfunding:access', '0'),
    IamProtocolError
  )
})

test('network failures, connection timeout, read timeout and 5xx are unavailable', async () => {
  const networkClient = new IamClient(config, {
    fetch: async () => { throw new Error('socket failed with access-token') }
  })
  await assert.rejects(() => networkClient.checkToken('access-token'), IamUnavailableError)

  const serverError = queuedFetch([new Response('{"code":503}', { status: 503 })])
  await assert.rejects(
    () => new IamClient(config, { fetch: serverError.fetch }).checkToken('access-token'),
    IamUnavailableError
  )

  const timeoutConfig = { ...config, connectTimeoutMs: 5, readTimeoutMs: 5 }
  const connectClient = new IamClient(timeoutConfig, {
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('connect aborted')), { once: true })
    })
  })
  await assert.rejects(() => connectClient.checkToken('access-token'), IamUnavailableError)

  const readClient = new IamClient(timeoutConfig, {
    fetch: async (_input, init) => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('read aborted')), { once: true })
      })
    }) as Response
  })
  await assert.rejects(() => readClient.checkToken('access-token'), IamUnavailableError)
})

test('each response body is read once and completed calls leave no timeout behind', async () => {
  let reads = 0
  let signal: AbortSignal | null | undefined
  const client = new IamClient({ ...config, connectTimeoutMs: 10, readTimeoutMs: 10 }, {
    fetch: async (_input, init) => {
      signal = init?.signal
      return {
        ok: true,
        status: 200,
        text: async () => {
          reads += 1
          return '{"code":0,"data":{"active":true,"user_id":1,"tenant_id":0,"client_id":"crowdfunding","scopes":[]}}'
        }
      } as Response
    }
  })

  await client.checkToken('access-token')
  await new Promise(resolve => setTimeout(resolve, 25))

  assert.equal(reads, 1)
  assert.equal(signal?.aborted, false)
})

test('errors never disclose credentials, OAuth material or token values', async () => {
  const secrets = [
    'top-secret',
    'Basic Y3Jvd2RmdW5kaW5nOnRvcC1zZWNyZXQ=',
    'one-time-code',
    'pkce-verifier',
    'access-sensitive',
    'refresh-sensitive'
  ]
  const client = new IamClient(config, {
    fetch: async () => { throw new Error(secrets.join('|')) }
  })
  const calls = [
    () => client.exchangeCode({ code: 'one-time-code', state: 'oauth-state', verifier: 'pkce-verifier' }),
    () => client.refresh('refresh-sensitive'),
    () => client.checkToken('access-sensitive')
  ]

  for (const call of calls) {
    await assert.rejects(call, error => {
      const diagnostic = error instanceof Error ? `${error.name}\n${error.message}\n${error.stack ?? ''}` : String(error)
      for (const secret of secrets) assert.doesNotMatch(diagnostic, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      return error instanceof IamUnavailableError
    })
  }
})

test('all seven public methods make fresh transport requests and never reuse cached responses', async () => {
  const calls = new Map<string, number>()
  const client = new IamClient(config, {
    fetch: async (input, init) => {
      const path = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname
      const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
      const operation = path === '/api/oauth2/token'
        ? body.get('grant_type') ?? 'unknown-token-grant'
        : path
      const sequence = (calls.get(operation) ?? 0) + 1
      calls.set(operation, sequence)
      if (operation === 'authorization_code' || operation === 'refresh_token') {
        return success({
          access_token: `${operation}-access-${sequence}`,
          refresh_token: `${operation}-refresh-${sequence}`,
          token_type: 'Bearer',
          expires_in: 3600,
          client_id: 'crowdfunding',
          scopes: ['openid'],
          tenant_id: 0
        })
      }
      if (path.endsWith('/revoke')) return success(sequence === 1)
      if (path.endsWith('/check-token')) {
        return success({ active: true, user_id: sequence, tenant_id: 0, client_id: 'crowdfunding', scopes: [] })
      }
      if (path.endsWith('/permission/decision')) {
        return success({ subjectValid: true, allowed: sequence === 1 })
      }
      if (path.endsWith('/permission-info')) {
        return success({
          user: { id: sequence, username: `user-${sequence}`, nickname: `User ${sequence}` },
          roles: [],
          permissions: [],
          apiPermissions: [],
          uiPermissions: [],
          clientId: 'crowdfunding',
          dataScope: { all: false, self: true, deptIds: [sequence] },
          menus: []
        })
      }
      if (path.endsWith('/permission/data-scope')) {
        return success({ all: false, self: true, deptIds: [sequence] })
      }
      throw new Error('unexpected IAM path')
    }
  })

  const exchangeInput = { code: 'same-code', state: 'same-state', verifier: 'same-verifier' }
  assert.deepEqual([
    (await client.exchangeCode(exchangeInput)).accessToken,
    (await client.exchangeCode(exchangeInput)).accessToken
  ], ['authorization_code-access-1', 'authorization_code-access-2'])
  assert.deepEqual([
    (await client.refresh('same-refresh')).accessToken,
    (await client.refresh('same-refresh')).accessToken
  ], ['refresh_token-access-1', 'refresh_token-access-2'])
  assert.deepEqual([
    await client.revoke('same-revoke'),
    await client.revoke('same-revoke')
  ], [true, false])
  assert.deepEqual([
    (await client.checkToken('same-check')).userId,
    (await client.checkToken('same-check')).userId
  ], ['1', '2'])
  assert.equal(await client.decideApi('same-decision', 'crowdfunding:access', '0'), true)
  await assert.rejects(
    () => client.decideApi('same-decision', 'crowdfunding:access', '0'),
    IamDeniedError
  )
  assert.deepEqual([
    (await client.permissionInfo('same-info')).user.id,
    (await client.permissionInfo('same-info')).user.id
  ], ['1', '2'])
  assert.deepEqual([
    (await client.dataScope('1', '0')).deptIds,
    (await client.dataScope('1', '0')).deptIds
  ], [['1'], ['2']])

  assert.deepEqual(Object.fromEntries(calls), {
    authorization_code: 2,
    refresh_token: 2,
    '/api/oauth2/revoke': 2,
    '/api/oauth2/check-token': 2,
    '/api/oauth2/permission/decision': 2,
    '/api/auth/permission-info': 2,
    '/rpc-api/system/permission/data-scope': 2
  })
})
