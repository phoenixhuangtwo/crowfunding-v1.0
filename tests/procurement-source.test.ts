import assert from 'node:assert/strict'
import test from 'node:test'
import { loadProcurementOrders, procurementSourceMode } from '../server/procurement-source.ts'

test('mysql is the default source and invalid source values fail closed', () => {
  assert.equal(procurementSourceMode({}), 'mysql')
  assert.equal(procurementSourceMode({ PROCUREMENT_SOURCE: 'http' }), 'http')
  assert.throws(() => procurementSourceMode({ PROCUREMENT_SOURCE: 'fallback' }), /配置/)
})
test('missing mysql configuration never falls back to the old HTTP interface', async () => {
  let calls = 0
  await assert.rejects(loadProcurementOrders({ PROCUREMENT_SOURCE: 'mysql', PROCUREMENT_API_URL: 'http://example.invalid', PROCUREMENT_TOKEN: 'test-only' }, async () => { calls++; throw Error('HTTP must not run') }), /配置/)
  assert.equal(calls, 0)
})
test('HTTP compatibility mode is explicit and independent of mysql credentials', async () => {
  let calls = 0
  const result = await loadProcurementOrders({ PROCUREMENT_SOURCE: 'http', PROCUREMENT_API_URL: 'http://example.invalid', PROCUREMENT_TOKEN: 'test-only' }, async () => { calls++; return new Response(JSON.stringify({ code: 0, data: { list: [], total: 0 } })) })
  assert.equal(calls, 1); assert.deepEqual(result.items, [])
})
