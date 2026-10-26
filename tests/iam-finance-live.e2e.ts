import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IamClient } from '../server/iam/client.ts'
import { loadIamConfig } from '../server/iam/config.ts'

const directory = join(homedir(), '.config', 'crowdfunding')
const account = JSON.parse(readFileSync(join(directory, 'iam-v11-finance-test-account.json'), 'utf8')) as {
  username: string; password: string
}
const secret = readFileSync(join(directory, 'iam-client-secret'), 'utf8').trim()
const config = loadIamConfig({ ...process.env, IAM_BASE_URL: 'http://system.localhost:8080',
  IAM_WEB_URL: 'http://system.localhost:5173', IAM_CLIENT_ID: 'crowdfunding', IAM_CLIENT_SECRET: secret,
  IAM_REDIRECT_URI: 'http://127.0.0.1:5174/oauth/callback', APP_ALLOWED_ORIGIN: 'http://127.0.0.1:5174' })
const iam = new IamClient(config)
let accessToken: string | undefined
let refreshToken: string | undefined
try {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(24).toString('base64url')
  const login = await fetch(`${config.baseUrl.origin}/api/auth/oauth-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: account.username, password: account.password,
      clientId: config.clientId, redirectUri: config.redirectUri.href, responseType: 'code',
      scope: 'openid profile', codeChallenge: challenge, codeChallengeMethod: 'S256' })
  })
  assert.equal(login.status, 200, '真实 IAM 财务账号登录成功')
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie?.startsWith('IAM_OAUTH_LOGIN='))
  const approval = await fetch(`${config.baseUrl.origin}/api/oauth2/authorize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ clientId: config.clientId, redirectUri: config.redirectUri.href,
      responseType: 'code', scope: 'openid profile', state, approved: true,
      approvedScopes: ['openid', 'profile'], codeChallenge: challenge, codeChallengeMethod: 'S256' })
  })
  assert.equal(approval.status, 200)
  const code = (await approval.json() as { data?: { code?: string } }).data?.code
  assert.ok(code)
  const pair = await iam.exchangeCode({ code, state, verifier })
  accessToken = pair.accessToken
  refreshToken = pair.refreshToken
  const claims = await iam.checkToken(accessToken)
  const info = await iam.permissionInfo(accessToken)
  assert.equal(info.user.username, account.username)
  assert.ok(info.roleCodes.includes('crowdfunding_finance'))
  assert.ok(info.apiPermissions.includes('crowdfunding:procurement-payment:register'))
  assert.ok(info.apiPermissions.includes('crowdfunding:procurement-payment:proof-upload'))
  assert.ok(info.uiPermissions.includes('crowdfunding:procurement-payment:register'))
  assert.ok(info.menus.some(menu => menu.componentName === 'procurementPayment'
    || menu.children?.some(child => child.componentName === 'procurementPayment')))
  for (const permission of ['crowdfunding:receipt:query', 'crowdfunding:receipt:register',
    'crowdfunding:receipt:proof-upload', 'crowdfunding:receipt:review',
    'crowdfunding:receipt:difference-register']) {
    assert.ok(info.apiPermissions.includes(permission), `${permission} 已授予财务`)
    assert.equal(await iam.decideApi(accessToken, permission, claims.tenantId), true)
  }
  assert.ok(info.uiPermissions.includes('crowdfunding:receipt:query'))
  assert.ok(info.menus.some(menu => menu.componentName === 'customerReceipts'
    || menu.children?.some(child => child.componentName === 'customerReceipts')))
  assert.equal(await iam.decideApi(accessToken, 'crowdfunding:procurement-payment:register', claims.tenantId), true)
  assert.equal(await iam.decideApi(accessToken, 'crowdfunding:procurement-payment:proof-upload', claims.tenantId), true)
  process.stdout.write('真实 IAM 财务授权联调通过\n')
} finally {
  if (accessToken) await iam.revoke(accessToken).catch(() => undefined)
  if (refreshToken) await iam.revoke(refreshToken).catch(() => undefined)
}
