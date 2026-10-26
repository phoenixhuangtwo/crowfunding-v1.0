import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MongoClient } from 'mongodb'
import { IamClient } from '../server/iam/client.ts'
import { loadIamConfig } from '../server/iam/config.ts'
import { businessCollections } from '../server/persistence/schema.ts'

if (!process.env.MONGODB_URI || process.env.MONGODB_DB !== 'crowfunding') {
  throw new Error('需要本地测试 MongoDB 配置')
}
const credentialDirectory = join(homedir(), '.config', 'crowdfunding')
const account = JSON.parse(readFileSync(process.env.IAM_TEST_ACCOUNT_FILE ?? join(credentialDirectory, 'iam-v11-test-account.json'), 'utf8')) as { username: string; password: string }
const clientSecret = readFileSync(process.env.IAM_CLIENT_SECRET_FILE ?? join(credentialDirectory, 'iam-client-secret'), 'utf8').trim()
const config = loadIamConfig({
  ...process.env, IAM_BASE_URL: 'http://system.localhost:8080', IAM_WEB_URL: 'http://system.localhost:5173', IAM_CLIENT_ID: 'crowdfunding',
  IAM_CLIENT_SECRET: clientSecret, IAM_REDIRECT_URI: 'http://127.0.0.1:5174/oauth/callback',
  APP_ALLOWED_ORIGIN: 'http://127.0.0.1:5174'
})
const iam = new IamClient(config)
const prefix = `__test_iam_live_${randomBytes(6).toString('hex')}_`
const client = new MongoClient(process.env.MONGODB_URI)
const names = [...businessCollections, 'agreement_versions', 'agreement_confirmations'].map(name => `${prefix}${name}`)
let child: ReturnType<typeof spawn> | undefined
let accessToken: string | undefined
let refreshToken: string | undefined

async function freePort() {
  const listener = createServer()
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('测试端口不可用')
  await new Promise<void>(resolve => listener.close(() => resolve()))
  return address.port
}

try {
  await client.connect()
  const db = client.db('crowfunding')
  await db.collection(`${prefix}agreement_versions`).insertOne({
    id: 'AGREEMENT-LIVE-TEST', version: 1, title: '真实 IAM 联调协议',
    body: '员工独立承担税费，分配金额为税前金额；客户退货和坏账由公司承担，采购失败缺口由公司承担；预估收益不构成承诺。',
    effectiveAt: new Date().toISOString(), createdBy: 'integration-test'
  })
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-IAM-LIVE-TEST', title: '真实 IAM 隔离项目', source: 'integration-test',
    status: '未满额', statusType: 'primary', progress: 0, remain: 300, deadline: '2099-12-31 23:59',
    total: 300, costAmount: 300, salesAmount: 360, profitAmount: 60,
    companyFixedAmount: 0, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 0, subscribed: 0, people: 0
  })
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, API_PORT: String(port), NODE_ENV: 'test', MONGODB_COLLECTION_PREFIX: prefix,
      IAM_BASE_URL: config.baseUrl.href, IAM_WEB_URL: config.webUrl.href, IAM_CLIENT_ID: config.clientId, IAM_CLIENT_SECRET: clientSecret,
      IAM_REDIRECT_URI: config.redirectUri.href, APP_ALLOWED_ORIGIN: config.allowedOrigin
    },
    stdio: 'ignore'
  })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break
    try { ready = (await fetch(`${base}/api/health`)).ok; if (ready) break } catch { /* startup */ }
    await delay(100)
  }
  assert.ok(ready, '隔离众筹 API 已启动')

  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(24).toString('base64url')
  const login = await fetch(`${config.baseUrl.origin}/api/auth/oauth-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: account.username, password: account.password, clientId: config.clientId,
      redirectUri: config.redirectUri.href, responseType: 'code', scope: 'openid profile',
      codeChallenge: challenge, codeChallengeMethod: 'S256'
    })
  })
  assert.equal(login.status, 200, '真实 IAM 登录成功')
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie?.startsWith('IAM_OAUTH_LOGIN='), 'IAM 返回授权登录 Cookie')
  const approval = await fetch(`${config.baseUrl.origin}/api/oauth2/authorize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      clientId: config.clientId, redirectUri: config.redirectUri.href, responseType: 'code',
      scope: 'openid profile', state, approved: true, approvedScopes: ['openid', 'profile'],
      codeChallenge: challenge, codeChallengeMethod: 'S256'
    })
  })
  assert.equal(approval.status, 200, '真实 IAM 授权成功')
  const code = (await approval.json() as { data?: { code?: string } }).data?.code
  assert.ok(code, 'IAM 返回授权码')
  const pair = await iam.exchangeCode({ code, state, verifier })
  accessToken = pair.accessToken
  refreshToken = pair.refreshToken
  const claims = await iam.checkToken(accessToken)
  const info = await iam.permissionInfo(accessToken)
  assert.equal(info.user.username, account.username)
  assert.ok(info.roleCodes.includes('crowdfunding_employee'))
  assert.equal(await iam.decideApi(accessToken, 'crowdfunding:project:query', claims.tenantId), true)

  const headers = { Authorization: `Bearer ${accessToken}` }
  const me = await fetch(`${base}/api/auth/me`, { headers })
  assert.equal(me.status, 200)
  const projects = await fetch(`${base}/api/projects`, { headers })
  assert.equal(projects.status, 200)
  assert.equal((await projects.json() as { data: unknown[] }).data.length, 1)
  const subscribed = await fetch(`${base}/api/subscriptions`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'PRJ-IAM-LIVE-TEST', amount: 100,
      idempotencyKey: `iam-live-${randomBytes(8).toString('hex')}`, agreementVersion: 1, agreementsConfirmed: true })
  })
  assert.equal(subscribed.status, 201, '真实 IAM 身份可以认购')
  const record = await db.collection(`${prefix}subscriptions`).findOne({ userId: claims.userId })
  assert.equal(record?.userName, info.user.nickname)
  assert.equal((await db.collection(`${prefix}agreement_confirmations`).findOne({ userId: claims.userId, node: '提交认购' }))?.userName, info.user.nickname)

  assert.equal(await iam.revoke(accessToken), true)
  accessToken = undefined
  assert.equal((await fetch(`${base}/api/projects`, { headers })).status, 401, '撤销令牌后拒绝业务请求')
  await iam.revoke(refreshToken)
  refreshToken = undefined
  console.log('真实 IAM 授权码、认购、协议快照及令牌撤销测试通过（隔离集合）')
} finally {
  if (accessToken) await iam.revoke(accessToken).catch(() => undefined)
  if (refreshToken) await iam.revoke(refreshToken).catch(() => undefined)
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child!.once('exit', resolve)), delay(5000)])
  }
  if (client.topology?.isConnected()) {
    const db = client.db('crowfunding')
    for (const name of names) {
      if (await db.listCollections({ name }, { nameOnly: true }).hasNext()) await db.collection(name).drop()
    }
  }
  await client.close()
}
