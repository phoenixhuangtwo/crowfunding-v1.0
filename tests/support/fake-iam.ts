import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

const clientId = 'crowdfunding'
const clientSecret = 'smoke-only-client-secret'
const basicAuthorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`
const otherClientId = 'other-client'
const otherClientAuthorization = `Basic ${Buffer.from(`${otherClientId}:smoke-only-other-client-secret`, 'utf8').toString('base64')}`

const allApiPermissions = [
  'crowdfunding:access', 'crowdfunding:project:query', 'crowdfunding:subscription:query',
  'crowdfunding:payment-proof:query', 'crowdfunding:rule:query', 'crowdfunding:receiving-code:query',
  'crowdfunding:payment-review:query', 'crowdfunding:settlement:query', 'crowdfunding:takeover:query',
  'crowdfunding:audit:query', 'crowdfunding:risk:query', 'crowdfunding:procurement:sync',
  'crowdfunding:project:open', 'crowdfunding:project:terminate', 'crowdfunding:project:interrupt',
  'crowdfunding:procurement-payment:register', 'crowdfunding:procurement-payment:proof-upload',
  'crowdfunding:receipt:query', 'crowdfunding:receipt:register',
  'crowdfunding:receipt:proof-upload', 'crowdfunding:receipt:review',
  'crowdfunding:receipt:difference-register',
  'crowdfunding:distribution:query', 'crowdfunding:distribution:generate',
  'crowdfunding:distribution:approve', 'crowdfunding:distribution:reject', 'crowdfunding:distribution:void',
  'crowdfunding:distribution:close',
  'crowdfunding:cost:query', 'crowdfunding:cost:register',
  'crowdfunding:cost:proof-upload', 'crowdfunding:cost:review',
  'crowdfunding:payout:my-query', 'crowdfunding:payout:register',
  'crowdfunding:payout:proof-upload', 'crowdfunding:payout:confirm',
  'crowdfunding:payout:issue-reply',
  'crowdfunding:financial-reconciliation:query',
  'crowdfunding:exception-fund:query', 'crowdfunding:exception-fund:register',
  'crowdfunding:exception-fund:proof-upload',
  'crowdfunding:exception-fund:refund', 'crowdfunding:exception-fund:refund-proof-upload',
  'crowdfunding:exception-fund:refund-confirm', 'crowdfunding:exception-fund:my-refunds',
  'crowdfunding:exception-fund:transfer', 'crowdfunding:exception-fund:transfer-review',
  'crowdfunding:exception-fund:assign-project',
  'crowdfunding:project:close', 'crowdfunding:project:reopen', 'crowdfunding:project:finish-close',
  'crowdfunding:procurement-failure:request', 'crowdfunding:procurement-failure:query',
  'crowdfunding:procurement-failure:review', 'crowdfunding:procurement-failure:finish',
  'crowdfunding:supplier-refund:query', 'crowdfunding:supplier-refund:proof-upload',
  'crowdfunding:supplier-refund:register',
  'crowdfunding:receipt-termination-refund:query', 'crowdfunding:receipt-termination-refund:proof-upload',
  'crowdfunding:receipt-termination-refund:register', 'crowdfunding:receipt-termination-refund:review',
  'crowdfunding:project-refund:query', 'crowdfunding:project-refund:my-query',
  'crowdfunding:project-refund:proof-upload', 'crowdfunding:project-refund:register',
  'crowdfunding:project-refund:confirm',
  'crowdfunding:project-refund-proxy:query', 'crowdfunding:project-refund-proxy:request',
  'crowdfunding:project-refund-proxy:review',
  'crowdfunding:distribution-payout-proxy:query', 'crowdfunding:distribution-payout-proxy:request',
  'crowdfunding:distribution-payout-proxy:review',
  'crowdfunding:rule-parameters:query', 'crowdfunding:rule-parameters:update',
  'crowdfunding:notification:query', 'crowdfunding:notification:read',
  'crowdfunding:subscription:create', 'crowdfunding:subscription:confirm-receipt',
  'crowdfunding:payment-proof:upload', 'crowdfunding:payment-proof:delete', 'crowdfunding:payment-proof:ocr',
  'crowdfunding:rule:create', 'crowdfunding:rule:update', 'crowdfunding:rule:change-status',
  'crowdfunding:rule:delete', 'crowdfunding:receiving-code:create', 'crowdfunding:receiving-code:update-image',
  'crowdfunding:receiving-code:disable', 'crowdfunding:payment-review:approve',
  'crowdfunding:payment-review:reject', 'crowdfunding:payment-review:partial',
  'crowdfunding:settlement:calculate', 'crowdfunding:settlement:confirm',
  'crowdfunding:settlement:upload-invoice', 'crowdfunding:takeover:force'
] as const

type DataScope = { all: boolean; self: boolean; deptIds: readonly number[] }
type ActiveFixture = {
  token: string
  userId: number
  username: string
  nickname: string
  deptId: number
  roles: readonly string[]
  apiPermissions: readonly string[]
  dataScope: DataScope
  clientId?: string
}

const fixtures: readonly ActiveFixture[] = [
  {
    token: 'smoke-access-token', userId: 1099, username: 'smoke_operator', nickname: 'Smoke Operator', deptId: 900,
    roles: ['smoke_operator'], apiPermissions: allApiPermissions, dataScope: { all: true, self: true, deptIds: [] }
  },
  {
    token: 'smoke-employee-token', userId: 1001, username: 'employee01', nickname: '员工甲', deptId: 100,
    roles: ['crowdfunding_employee'], apiPermissions: ['crowdfunding:access', 'crowdfunding:project:query', 'crowdfunding:subscription:query', 'crowdfunding:subscription:create', 'crowdfunding:payment-proof:ocr', 'crowdfunding:payout:my-query', 'crowdfunding:payout:confirm', 'crowdfunding:exception-fund:my-refunds', 'crowdfunding:exception-fund:refund-confirm', 'crowdfunding:project-refund:my-query', 'crowdfunding:project-refund:confirm', 'crowdfunding:notification:query', 'crowdfunding:notification:read'],
    dataScope: { all: false, self: true, deptIds: [] }
  },
  {
    token: 'smoke-admin-token', userId: 1002, username: 'admin01', nickname: '部门管理员', deptId: 200,
    roles: ['crowdfunding_admin'], apiPermissions: ['crowdfunding:access', 'crowdfunding:project:query', 'crowdfunding:rule:query', 'crowdfunding:subscription:query', 'crowdfunding:receiving-code:query', 'crowdfunding:takeover:query', 'crowdfunding:procurement-failure:request', 'crowdfunding:procurement-failure:query'],
    dataScope: { all: false, self: false, deptIds: [200] }
  },
  {
    token: 'smoke-admin-full-token', userId: 1002, username: 'admin01', nickname: '全范围项目管理员', deptId: 200,
    roles: ['crowdfunding_admin'], apiPermissions: allApiPermissions,
    dataScope: { all: true, self: false, deptIds: [] }
  },
  {
    token: 'smoke-admin-outside-scope-token', userId: 1007, username: 'admin-outside', nickname: '范围外管理员', deptId: 200,
    roles: ['crowdfunding_admin'], apiPermissions: ['crowdfunding:access', 'crowdfunding:project:query'],
    dataScope: { all: false, self: false, deptIds: [201] }
  },
  {
    token: 'smoke-finance-token', userId: 1003, username: 'finance01', nickname: '财务', deptId: 200,
    roles: ['crowdfunding_finance'], apiPermissions: ['crowdfunding:access', 'crowdfunding:project:query', 'crowdfunding:payment-review:query', 'crowdfunding:settlement:query', 'crowdfunding:settlement:upload-invoice', 'crowdfunding:procurement-payment:register', 'crowdfunding:procurement-payment:proof-upload', 'crowdfunding:receipt:query', 'crowdfunding:receipt:register', 'crowdfunding:receipt:proof-upload', 'crowdfunding:receipt:difference-register', 'crowdfunding:receipt:review', 'crowdfunding:distribution:query', 'crowdfunding:distribution:generate', 'crowdfunding:distribution:approve', 'crowdfunding:distribution:reject', 'crowdfunding:distribution:void', 'crowdfunding:distribution:close', 'crowdfunding:cost:query', 'crowdfunding:cost:register', 'crowdfunding:cost:proof-upload', 'crowdfunding:payout:register', 'crowdfunding:payout:proof-upload', 'crowdfunding:payout:issue-reply', 'crowdfunding:financial-reconciliation:query', 'crowdfunding:exception-fund:query', 'crowdfunding:exception-fund:register', 'crowdfunding:exception-fund:proof-upload', 'crowdfunding:exception-fund:refund', 'crowdfunding:exception-fund:refund-proof-upload', 'crowdfunding:exception-fund:transfer', 'crowdfunding:exception-fund:assign-project', 'crowdfunding:project:finish-close', 'crowdfunding:project-refund:query', 'crowdfunding:project-refund:proof-upload', 'crowdfunding:project-refund:register', 'crowdfunding:procurement-failure:finish', 'crowdfunding:supplier-refund:query', 'crowdfunding:supplier-refund:proof-upload', 'crowdfunding:supplier-refund:register', 'crowdfunding:receipt-termination-refund:query', 'crowdfunding:receipt-termination-refund:proof-upload', 'crowdfunding:receipt-termination-refund:register', 'crowdfunding:project-refund-proxy:query', 'crowdfunding:project-refund-proxy:request', 'crowdfunding:distribution-payout-proxy:query', 'crowdfunding:distribution-payout-proxy:request', 'crowdfunding:notification:query', 'crowdfunding:notification:read'],
    dataScope: { all: true, self: false, deptIds: [] }
  },
  {
    token: 'smoke-second-finance-token', userId: 1008, username: 'finance02', nickname: '复核财务', deptId: 200,
    roles: ['crowdfunding_finance'], apiPermissions: allApiPermissions,
    dataScope: { all: true, self: false, deptIds: [] }
  },
  {
    token: 'smoke-super-admin-token', userId: 1004, username: 'superadmin01', nickname: '超级管理员', deptId: 900,
    roles: ['crowdfunding_super_admin'], apiPermissions: ['crowdfunding:access', 'crowdfunding:project:query', 'crowdfunding:project:open', 'crowdfunding:takeover:query', 'crowdfunding:takeover:force', 'crowdfunding:audit:query', 'crowdfunding:risk:query', 'crowdfunding:receipt:query', 'crowdfunding:receipt:review', 'crowdfunding:distribution:query', 'crowdfunding:cost:query', 'crowdfunding:cost:review', 'crowdfunding:financial-reconciliation:query', 'crowdfunding:exception-fund:query', 'crowdfunding:exception-fund:refund-confirm', 'crowdfunding:exception-fund:transfer-review', 'crowdfunding:project-refund:query', 'crowdfunding:procurement-failure:query', 'crowdfunding:procurement-failure:review', 'crowdfunding:supplier-refund:query', 'crowdfunding:receipt-termination-refund:query', 'crowdfunding:receipt-termination-refund:review', 'crowdfunding:project-refund-proxy:query', 'crowdfunding:project-refund-proxy:review', 'crowdfunding:distribution-payout-proxy:query', 'crowdfunding:distribution-payout-proxy:review', 'crowdfunding:rule-parameters:query', 'crowdfunding:rule-parameters:update', 'crowdfunding:notification:query', 'crowdfunding:notification:read'],
    dataScope: { all: true, self: false, deptIds: [] }
  },
  {
    token: 'smoke-no-access-token', userId: 1005, username: 'noaccess01', nickname: '无权用户', deptId: 100,
    roles: [], apiPermissions: [], dataScope: { all: false, self: false, deptIds: [] }
  },
  {
    token: 'smoke-other-client-token', userId: 1006, username: 'otherclient01', nickname: '其他客户端用户', deptId: 100,
    roles: ['employee'], apiPermissions: ['crowdfunding:project:query'], dataScope: { all: false, self: true, deptIds: [] }, clientId: 'other-client'
  },
  {
    token: 'smoke-issued-access-token', userId: 1001, username: 'employee01', nickname: '员工甲', deptId: 100,
    roles: ['employee'], apiPermissions: ['crowdfunding:access'], dataScope: { all: false, self: true, deptIds: [] }
  },
  {
    token: 'smoke-refreshed-access-token', userId: 1001, username: 'employee01', nickname: '员工甲', deptId: 100,
    roles: ['employee'], apiPermissions: ['crowdfunding:access'], dataScope: { all: false, self: true, deptIds: [] }
  }
]

const activeByToken = new Map(fixtures.map(fixture => [fixture.token, fixture]))
const activeByUserId = new Map(fixtures.filter(fixture => fixture.clientId === undefined).map(fixture => [String(fixture.userId), fixture]))
const disabledTokens = new Set(['smoke-disabled-user-token'])

export type FakeIamCall = {
  method: string
  path: string
  authorization?: string
  tenantId?: string
  contentType?: string
  body: string
}

export type FakeIam = { server: Server; url: string; calls: FakeIamCall[] }

function envelope(data: unknown) {
  return { code: 0, message: 'success', description: null, data, timestamp: '2026-09-01T09:00:00' }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function reject(res: ServerResponse, status: number, message: string) {
  sendJson(res, status, { code: status, message, description: message, data: null, timestamp: '2026-09-01T09:00:00' })
}

function requireMethod(req: IncomingMessage, res: ServerResponse, method: string) {
  if (req.method === method) return true
  reject(res, 405, 'method not allowed')
  return false
}

function authenticatedClient(req: IncomingMessage, res: ServerResponse) {
  if (req.headers.authorization === basicAuthorization) return clientId
  if (req.headers.authorization === otherClientAuthorization) return otherClientId
  reject(res, 401, 'invalid client credentials')
  return null
}

function parseForm(req: IncomingMessage, res: ServerResponse, body: string, expectedKeys: readonly string[]) {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    reject(res, 400, 'form content type required')
    return null
  }
  const form = new URLSearchParams(body)
  const keys = [...form.keys()]
  if (keys.length !== expectedKeys.length || expectedKeys.some(key => form.getAll(key).length !== 1) || keys.some(key => !expectedKeys.includes(key))) {
    reject(res, 400, 'invalid form fields')
    return null
  }
  return form
}

function activeFixtureForToken(token: string | null, revokedTokens: ReadonlySet<string>, res: ServerResponse) {
  if (!token || disabledTokens.has(token) || revokedTokens.has(token)) {
    reject(res, 401, 'authentication is required')
    return null
  }
  const fixture = activeByToken.get(token)
  if (!fixture) {
    reject(res, 401, 'authentication is required')
    return null
  }
  return fixture
}

function tokenClient(fixture: ActiveFixture) {
  return fixture.clientId ?? clientId
}

function tokenView(token: string, ownerClientId = clientId) {
  return {
    accessToken: token,
    access_token: token,
    refreshToken: 'smoke-issued-refresh-token',
    refresh_token: 'smoke-issued-refresh-token',
    token_type: 'Bearer',
    expiresTime: '2026-09-01T10:00:00',
    expires_in: 3600,
    exp: 1788256800,
    clientId: ownerClientId,
    client_id: ownerClientId,
    scopes: ['openid', 'profile'],
    scope: 'openid profile',
    tenantId: 0,
    tenant_id: 0
  }
}

function permissionInfo(fixture: ActiveFixture) {
  return {
    user: { id: fixture.userId, username: fixture.username, nickname: fixture.nickname, avatar: null, deptId: fixture.deptId },
    roles: [...fixture.roles],
    permissions: [...fixture.apiPermissions],
    uiPermissions: [],
    apiPermissions: [...fixture.apiPermissions],
    clientId: tokenClient(fixture),
    dataScope: { ...fixture.dataScope, deptIds: [...fixture.dataScope.deptIds] },
    menus: []
  }
}

function bearer(req: IncomingMessage) {
  const match = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9._~+\/-]+)$/)
  return match?.[1] ?? null
}

function isOutage(path: string, req: IncomingMessage, body: string) {
  if (bearer(req) === 'smoke-iam-outage-token') return true
  if (path === '/rpc-api/system/permission/data-scope') return false
  const form = new URLSearchParams(body)
  return ['token', 'access_token', 'refresh_token'].some(key => form.get(key) === 'smoke-iam-outage-token')
}

export async function startFakeIam(): Promise<FakeIam> {
  const calls: FakeIamCall[] = []
  const revokedTokens = new Set<string>()
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    calls.push({
      method: req.method ?? 'GET', path, authorization: req.headers.authorization,
      tenantId: typeof req.headers['tenant-id'] === 'string' ? req.headers['tenant-id'] : undefined,
      contentType: req.headers['content-type'], body
    })

    if (isOutage(path, req, body)) {
      reject(res, 503, 'IAM unavailable')
      return
    }

    if (path === '/api/oauth2/token') {
      if (!requireMethod(req, res, 'POST')) return
      const callerClientId = authenticatedClient(req, res)
      if (!callerClientId) return
      if (callerClientId !== clientId) { reject(res, 400, 'invalid authorization grant'); return }
      const candidate = new URLSearchParams(body)
      const grantType = candidate.get('grant_type')
      const expectedKeys = grantType === 'authorization_code'
        ? ['grant_type', 'code', 'redirect_uri', 'state', 'code_verifier']
        : ['grant_type', 'refresh_token']
      const form = parseForm(req, res, body, expectedKeys)
      if (!form) return
      if (grantType === 'authorization_code') {
        if (form.get('code') !== 'smoke-authorization-code' || !form.get('redirect_uri') || form.get('state') !== 'smoke-oauth-state' || form.get('code_verifier') !== 'smoke-code-verifier') {
          reject(res, 400, 'invalid authorization code grant')
          return
        }
        sendJson(res, 200, envelope(tokenView('smoke-issued-access-token')))
        return
      }
      if (grantType === 'refresh_token' && ['smoke-refresh-token', 'smoke-issued-refresh-token'].includes(form.get('refresh_token') ?? '')) {
        sendJson(res, 200, envelope(tokenView('smoke-refreshed-access-token')))
        return
      }
      reject(res, 400, 'unsupported or invalid grant')
      return
    }

    if (path === '/api/oauth2/revoke') {
      if (!requireMethod(req, res, 'POST')) return
      const callerClientId = authenticatedClient(req, res)
      if (!callerClientId) return
      const form = parseForm(req, res, body, ['token'])
      if (!form) return
      const token = form.get('token')
      const fixture = token ? activeByToken.get(token) : undefined
      const removed = Boolean(token && fixture && tokenClient(fixture) === callerClientId && !revokedTokens.has(token))
      if (removed) revokedTokens.add(token!)
      sendJson(res, 200, envelope(removed))
      return
    }

    if (path === '/api/oauth2/check-token') {
      if (!requireMethod(req, res, 'POST')) return
      const callerClientId = authenticatedClient(req, res)
      if (!callerClientId) return
      const form = parseForm(req, res, body, ['token'])
      if (!form) return
      const fixture = activeFixtureForToken(form.get('token'), revokedTokens, res)
      if (!fixture) return
      if (tokenClient(fixture) !== callerClientId) { reject(res, 403, 'token belongs to another client'); return }
      sendJson(res, 200, envelope({
        ...tokenView(fixture.token, tokenClient(fixture)), active: true,
        userId: fixture.userId, user_id: fixture.userId, user_type: 2
      }))
      return
    }

    if (path === '/api/oauth2/permission/decision') {
      if (!requireMethod(req, res, 'POST')) return
      if (!authenticatedClient(req, res)) return
      const candidate = new URLSearchParams(body)
      const expectedKeys = candidate.has('user_client_id')
        ? ['access_token', 'api_code', 'user_client_id']
        : ['access_token', 'api_code']
      const form = parseForm(req, res, body, expectedKeys)
      if (!form) return
      const fixture = activeFixtureForToken(form.get('access_token'), revokedTokens, res)
      if (!fixture) return
      const claimedUserClientId = form.get('user_client_id')?.trim()
      if (claimedUserClientId && claimedUserClientId !== tokenClient(fixture)) { reject(res, 403, 'token client mismatch'); return }
      const apiCode = form.get('api_code') ?? ''
      if (!allApiPermissions.includes(apiCode as typeof allApiPermissions[number])) {
        reject(res, 400, 'unknown api code')
        return
      }
      sendJson(res, 200, envelope({ subjectValid: true, allowed: fixture.apiPermissions.includes(apiCode) }))
      return
    }

    if (path === '/api/auth/permission-info') {
      if (!requireMethod(req, res, 'GET')) return
      const fixture = activeFixtureForToken(bearer(req), revokedTokens, res)
      if (!fixture) return
      sendJson(res, 200, envelope(permissionInfo(fixture)))
      return
    }

    if (path === '/rpc-api/system/permission/data-scope') {
      if (!requireMethod(req, res, 'POST') || !authenticatedClient(req, res)) return
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        reject(res, 400, 'json content type required')
        return
      }
      let request: unknown
      try { request = JSON.parse(body) } catch { reject(res, 400, 'invalid json'); return }
      if (!request || typeof request !== 'object' || Array.isArray(request)) { reject(res, 400, 'invalid request'); return }
      const fields = Object.keys(request)
      const value = request as Record<string, unknown>
      if (fields.length !== 2 || value.clientId !== clientId || !['number', 'string'].includes(typeof value.userId)) {
        reject(res, 400, 'invalid data scope request')
        return
      }
      const fixture = activeByUserId.get(String(value.userId))
      if (!fixture) { reject(res, 403, 'subject invalid'); return }
      sendJson(res, 200, envelope({ ...fixture.dataScope, deptIds: [...fixture.dataScope.deptIds] }))
      return
    }

    reject(res, 404, 'not found')
  })
  await new Promise<void>((resolve, rejectStart) => {
    server.once('error', rejectStart)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to start fake IAM')
  return { server, url: `http://127.0.0.1:${address.port}/`, calls }
}

export async function stopFakeIam(fake: FakeIam): Promise<void> {
  await new Promise<void>((resolve, rejectStop) => fake.server.close(error => error ? rejectStop(error) : resolve()))
}
