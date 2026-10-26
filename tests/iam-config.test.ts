import assert from 'node:assert/strict'
import test from 'node:test'
import { loadIamConfig } from '../server/iam/config.ts'

const validIamEnv = {
  IAM_BASE_URL: 'https://iam.example.test/',
  IAM_CLIENT_ID: 'crowdfunding',
  IAM_CLIENT_SECRET: 'a-server-only-secret',
  IAM_REDIRECT_URI: 'https://crowdfunding.example.test/oauth/callback',
  APP_ALLOWED_ORIGIN: 'https://crowdfunding.example.test'
}

test('loadIamConfig applies the fixed single-tenant defaults', () => {
  const config = loadIamConfig(validIamEnv)

  assert.equal(config.baseUrl.href, 'https://iam.example.test/')
  assert.equal(config.clientId, 'crowdfunding')
  assert.equal(config.redirectUri.href, 'https://crowdfunding.example.test/oauth/callback')
  assert.deepEqual(config.scopes, ['openid', 'profile'])
  assert.equal(config.connectTimeoutMs, 2000)
  assert.equal(config.readTimeoutMs, 5000)
  assert.equal(config.refreshCookieSecure, false)
  assert.equal(config.allowedOrigin, 'https://crowdfunding.example.test')
  assert.equal(config.multiTenantEnabled, false)
  assert.equal(config.defaultTenantId, '0')
})

test('loadIamConfig accepts only a fixed crowdfunding client and exact allowed origin', () => {
  assert.throws(
    () => loadIamConfig({ ...validIamEnv, IAM_CLIENT_ID: 'browser-client' }),
    /IAM_CLIENT_ID 必须为 crowdfunding/
  )
  assert.throws(
    () => loadIamConfig({ ...validIamEnv, APP_ALLOWED_ORIGIN: '*' }),
    /精确 Origin/
  )
  assert.throws(
    () => loadIamConfig({ ...validIamEnv, APP_ALLOWED_ORIGIN: 'https://crowdfunding.example.test/path' }),
    /精确 Origin/
  )
  assert.throws(
    () => loadIamConfig({ ...validIamEnv, IAM_REDIRECT_URI: 'https://other.example.test/oauth/callback' }),
    /IAM_REDIRECT_URI 的 Origin 必须等于 APP_ALLOWED_ORIGIN/
  )
})

test('loadIamConfig rejects wildcard hostnames in the configured allowed origin', () => {
  assert.throws(
    () => loadIamConfig({
      ...validIamEnv,
      APP_ALLOWED_ORIGIN: 'https://*.example.test',
      IAM_REDIRECT_URI: 'https://*.example.test/oauth/callback'
    }),
    /APP_ALLOWED_ORIGIN 必须是精确 Origin/
  )
})

test('loadIamConfig rejects non-http URLs and credentials in every IAM URL', () => {
  assert.throws(
    () => loadIamConfig({ ...validIamEnv, IAM_BASE_URL: 'ftp://iam.example.test/' }),
    /IAM_BASE_URL 仅允许 http 或 https/
  )
  assert.throws(
    () => loadIamConfig({ ...validIamEnv, IAM_BASE_URL: 'https://secret@iam.example.test/' }),
    /IAM_BASE_URL 不允许 URL credentials/
  )
  assert.throws(
    () => loadIamConfig({ ...validIamEnv, IAM_REDIRECT_URI: 'https://user:password@crowdfunding.example.test/oauth/callback' }),
    /IAM_REDIRECT_URI 不允许 URL credentials/
  )
  assert.throws(
    () => loadIamConfig({ ...validIamEnv, APP_ALLOWED_ORIGIN: 'ftp://crowdfunding.example.test' }),
    /APP_ALLOWED_ORIGIN 仅允许 http 或 https/
  )
})

test('loadIamConfig strictly parses timeout and boolean environment values', () => {
  const config = loadIamConfig({
    ...validIamEnv,
    IAM_CONNECT_TIMEOUT_MS: '1250',
    IAM_READ_TIMEOUT_MS: '6000',
    IAM_REFRESH_COOKIE_SECURE: 'true',
    IAM_MULTI_TENANT_ENABLED: 'true',
    IAM_DEFAULT_TENANT_ID: '98765432109876543210'
  })

  assert.equal(config.connectTimeoutMs, 1250)
  assert.equal(config.readTimeoutMs, 6000)
  assert.equal(config.refreshCookieSecure, true)
  assert.equal(config.multiTenantEnabled, true)
  assert.equal(config.defaultTenantId, '98765432109876543210')

  for (const [name, value] of [
    ['IAM_CONNECT_TIMEOUT_MS', '2e3'],
    ['IAM_READ_TIMEOUT_MS', '5000.0'],
    ['IAM_REFRESH_COOKIE_SECURE', '1'],
    ['IAM_MULTI_TENANT_ENABLED', 'False'],
    ['IAM_DEFAULT_TENANT_ID', '1e3']
  ]) {
    assert.throws(() => loadIamConfig({ ...validIamEnv, [name]: value }), new RegExp(name))
  }
})

test('loadIamConfig fixes the default tenant to zero while multi-tenancy is disabled', () => {
  const disabled = loadIamConfig({
    ...validIamEnv,
    IAM_MULTI_TENANT_ENABLED: 'false',
    IAM_DEFAULT_TENANT_ID: '0'
  })
  assert.equal(disabled.defaultTenantId, '0')

  assert.throws(
    () => loadIamConfig({
      ...validIamEnv,
      IAM_MULTI_TENANT_ENABLED: 'false',
      IAM_DEFAULT_TENANT_ID: '42'
    }),
    /IAM_DEFAULT_TENANT_ID/
  )

  const enabled = loadIamConfig({
    ...validIamEnv,
    IAM_MULTI_TENANT_ENABLED: 'true',
    IAM_DEFAULT_TENANT_ID: '42'
  })
  assert.equal(enabled.defaultTenantId, '42')
})

test('loadIamConfig reports configuration names without exposing configured values', () => {
  const secret = 'a-server-only-secret'
  assert.throws(() => loadIamConfig({ ...validIamEnv, IAM_BASE_URL: `https://${secret}@iam.example.test/` }), error => {
    assert.match(String(error), /IAM_BASE_URL/)
    assert.doesNotMatch(String(error), new RegExp(secret))
    return true
  })
})
