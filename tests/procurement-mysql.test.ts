import assert from 'node:assert/strict'
import test from 'node:test'
import { loadProcurementMysqlConfig, normalizeMysqlOrder, readMysqlOrders, readMysqlOrderById, ProcurementDatabaseError, type ProcurementMysqlSession } from '../server/procurement-mysql.ts'

const env = { PROCUREMENT_MYSQL_HOST: 'localhost', PROCUREMENT_MYSQL_USER: 'reader', PROCUREMENT_MYSQL_PASSWORD: 'unit-test-only', PROCUREMENT_MYSQL_DATABASE: 'fsy_mall', PROCUREMENT_MYSQL_TABLE: 'erp_offline_order' }
const config = () => loadProcurementMysqlConfig(env)
const row = (id: string, cost: unknown = '15000') => ({ id, projectName: '数据库采购单', sellOrder: 'XS-TEST', totalCostPrice: cost, totalSellingPrice: '20000', totalTransactionPrice: null, createTime: '2026-10-28 09:00:00', creator: '88', purchasingName: '测试采购员' })
function session(pages: Array<Array<Record<string, unknown>>>, total: number) {
  const calls: Array<{ sql: string; values: readonly (string | number)[] }> = []
  const commands: string[] = []; let closed = false
  const db: ProcurementMysqlSession = {
    command: async sql => { commands.push(sql) },
    select: async (sql, values = []) => { calls.push({ sql, values }); return sql.includes('COUNT(*)') ? [{ total: String(total) }] : (pages.shift() ?? []) },
    close: async () => { closed = true }
  }
  return { db, calls, commands, get closed() { return closed } }
}

test('mysql normalization preserves bigint IDs and integer cents, including zero/null amounts', () => {
  const normalized = normalizeMysqlOrder(row('9007199254740993', '15000.00'))
  assert.equal(normalized.id, '9007199254740993'); assert.equal(normalized.totalCostPrice, 15000)
  assert.equal(normalized.totalTransactionPrice, null); assert.equal(normalized.createTime, '2026-10-28 09:00:00')
  assert.equal(normalizeMysqlOrder(row('1', 0)).totalCostPrice, 0)
  assert.equal(normalizeMysqlOrder(row('1', null)).totalCostPrice, null)
  assert.throws(() => normalizeMysqlOrder(row('1', '15000.25')), /整数分/)
  assert.throws(() => normalizeMysqlOrder(row('1', '9007199254740993')), /整数分/)
})

test('mysql configuration rejects unsafe identifiers and does not silently accept missing credentials', () => {
  assert.equal(config().port, 3306)
  assert.throws(() => loadProcurementMysqlConfig({ ...env, PROCUREMENT_MYSQL_TABLE: 'orders;DELETE' }), /配置/)
  assert.throws(() => loadProcurementMysqlConfig({ ...env, PROCUREMENT_MYSQL_PASSWORD: undefined }), /配置/)
})

test('full mysql read uses a read-only snapshot and keyset pages without dropping zero-cost records', async () => {
  const fake = session([[row('9007199254740993'), row('9007199254740994', 0)], [row('9007199254740995', null)]], 3)
  const result = await readMysqlOrders({ ...config(), pageSize: 2 }, async () => fake.db)
  assert.deepEqual(result.items.map(x => x.id), ['9007199254740993', '9007199254740994', '9007199254740995'])
  assert.equal(result.fetched, 3); assert.equal(result.total, 3); assert.equal(result.items[1]!.totalCostPrice, 0)
  assert.ok(fake.commands.includes('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'))
  assert.ok(fake.calls.every(c => !/total_cost_price\s*>/i.test(c.sql)))
  assert.ok(fake.calls.every(c => c.sql.includes("deleted = b'0'") && c.sql.includes("recycle_flag = b'0'")))
  assert.deepEqual(fake.calls[2]!.values, ['9007199254740994', 2]); assert.ok(fake.closed)
})

test('empty mysql source closes cleanly without inventing projects', async () => {
  const fake = session([], 0); const result = await readMysqlOrders(config(), async () => fake.db)
  assert.deepEqual(result.items, []); assert.equal(result.total, 0); assert.ok(fake.closed)
})

test('mysql pagination failure returns no partial success and always closes the connection', async () => {
  const fake = session([[row('1'), row('2')], []], 3)
  await assert.rejects(readMysqlOrders({ ...config(), pageSize: 2 }, async () => fake.db), /分页/)
  assert.ok(fake.closed); assert.ok(fake.commands.includes('ROLLBACK'))
})

test('duplicate or out-of-order IDs fail the whole read rather than creating an incomplete snapshot', async () => {
  const fake = session([[row('2'), row('1')]], 2)
  await assert.rejects(readMysqlOrders(config(), async () => fake.db), /主键/); assert.ok(fake.closed)
})

test('detail queries exact ID parameters, independent of project name and page position', async () => {
  const fake = session([[row('9007199254740993')]], 1)
  const result = await readMysqlOrderById('9007199254740993', config(), async () => fake.db)
  assert.equal(result?.id, '9007199254740993'); assert.deepEqual(fake.calls[0]!.values, ['9007199254740993'])
  assert.match(fake.calls[0]!.sql, /o\.id = \?/); assert.ok(!fake.calls[0]!.sql.includes('9007199254740993'))
  assert.ok(fake.closed)
})

test('malformed detail IDs cannot alter SQL or open a connection', async () => {
  let connected = false
  assert.equal(await readMysqlOrderById("1' OR 1=1", config(), async () => { connected = true; return session([], 0).db }), null)
  assert.equal(connected, false)
})

test('database auth errors are actionable and never disclose the source error or password', async () => {
  const source = Object.assign(new Error('unit-test-only confidential connection details'), { code: 'ER_ACCESS_DENIED_ERROR' })
  await assert.rejects(readMysqlOrders(config(), async () => { throw source }), error => {
    assert.ok(error instanceof ProcurementDatabaseError)
    assert.equal(error.code, 'PROCUREMENT_DB_AUTH_REQUIRED'); assert.ok(!error.message.includes('unit-test-only'))
    return true
  })
})

test('transaction command failures are sanitized and still close the read session', async () => {
  let closed = false
  const fake: ProcurementMysqlSession = {
    select: async () => [],
    command: async sql => { if (sql !== 'ROLLBACK') throw Object.assign(new Error('private transport details'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' }) },
    close: async () => { closed = true }
  }
  await assert.rejects(readMysqlOrders(config(), async () => fake), error => {
    assert.ok(error instanceof ProcurementDatabaseError); assert.equal(error.code, 'PROCUREMENT_DB_TIMEOUT'); return true
  })
  assert.ok(closed)
})
