import { readFileSync } from 'node:fs'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import type { ProcurementPageResult } from './procurement.ts'

export class ProcurementDatabaseError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ProcurementDatabaseError' }
}

export type ProcurementMysqlConfig = {
  host: string; port: number; user: string; password: string; database: string; table: string
  pageSize: number; connectTimeoutMs: number; queryTimeoutMs: number
}
export type ProcurementMysqlSession = {
  select(sql: string, values?: readonly (string | number)[]): Promise<Array<Record<string, unknown>>>
  command(sql: string): Promise<void>
  close(): Promise<void>
}
type Connector = (config: ProcurementMysqlConfig) => Promise<ProcurementMysqlSession>

function configurationError(): never {
  throw new ProcurementDatabaseError('PROCUREMENT_DB_CONFIGURATION_INVALID', '采购数据库配置不完整或无效，请检查服务端连接配置')
}
function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value)) return configurationError()
  return `\`${value}\``
}
function integer(value: string | undefined, fallback: number, max: number) {
  const result = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(result) || result < 1 || result > max) return configurationError()
  return result
}
export function loadProcurementMysqlConfig(env: NodeJS.ProcessEnv = process.env): ProcurementMysqlConfig {
  const host = env.PROCUREMENT_MYSQL_HOST?.trim()
  const user = env.PROCUREMENT_MYSQL_USER?.trim()
  const database = env.PROCUREMENT_MYSQL_DATABASE?.trim()
  const table = env.PROCUREMENT_MYSQL_TABLE?.trim() || 'erp_offline_order'
  let password = env.PROCUREMENT_MYSQL_PASSWORD
  if (password === undefined && env.PROCUREMENT_MYSQL_PASSWORD_FILE) {
    try { password = readFileSync(env.PROCUREMENT_MYSQL_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '') }
    catch { return configurationError() }
  }
  if (!host || !user || !database || password === undefined) return configurationError()
  identifier(database); identifier(table)
  return { host, user, database, table, password,
    port: integer(env.PROCUREMENT_MYSQL_PORT, 3306, 65535),
    pageSize: integer(env.PROCUREMENT_MYSQL_PAGE_SIZE, 500, 1000),
    connectTimeoutMs: integer(env.PROCUREMENT_MYSQL_CONNECT_TIMEOUT_MS, 10000, 60000),
    queryTimeoutMs: integer(env.PROCUREMENT_MYSQL_QUERY_TIMEOUT_MS, 15000, 60000) }
}

function externalId(value: unknown): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new ProcurementDatabaseError('PROCUREMENT_DB_DATA_INVALID', '采购数据库主键超出安全范围')
  const id = String(value ?? '')
  if (!/^\d+$/.test(id)) throw new ProcurementDatabaseError('PROCUREMENT_DB_DATA_INVALID', '采购数据库主键格式无效')
  return id
}
function money(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^-?\d+(?:\.0+)?$/.test(String(value))) {
    throw new ProcurementDatabaseError('PROCUREMENT_DB_DATA_INVALID', '采购数据库金额不符合安全整数分约定，本次未同步')
  }
  const amount = Number(value)
  if (!Number.isSafeInteger(amount)) throw new ProcurementDatabaseError('PROCUREMENT_DB_DATA_INVALID', '采购数据库金额不符合安全整数分约定，本次未同步')
  return amount
}
export function normalizeMysqlOrder(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, id: externalId(row.id), totalCostPrice: money(row.totalCostPrice),
    totalSellingPrice: money(row.totalSellingPrice), totalTransactionPrice: money(row.totalTransactionPrice) }
}

const connectMysql: Connector = async config => {
  const connection = await mysql.createConnection({ host: config.host, port: config.port, user: config.user,
    password: config.password, database: config.database, connectTimeout: config.connectTimeoutMs,
    supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, multipleStatements: false, charset: 'utf8mb4' })
  return {
    async select(sql, values = []) {
      try {
        const [rows] = await connection.execute<RowDataPacket[]>({ sql, timeout: config.queryTimeoutMs }, [...values])
        return rows
      } catch (error) { connection.destroy(); throw error }
    },
    async command(sql) {
      try { await connection.query({ sql, timeout: config.queryTimeoutMs }) }
      catch (error) { connection.destroy(); throw error }
    },
    async close() {
      try { await connection.end() }
      catch (error) { connection.destroy(); throw error }
    }
  }
}
function safeDatabaseError(error: unknown): ProcurementDatabaseError {
  if (error instanceof ProcurementDatabaseError) return error
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR'].includes(code)) {
    return new ProcurementDatabaseError('PROCUREMENT_DB_AUTH_REQUIRED', '采购数据库认证失败，请检查服务端账号和密码')
  }
  if (['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_BAD_DB_ERROR'].includes(code)) {
    return new ProcurementDatabaseError('PROCUREMENT_DB_SCHEMA_INVALID', '采购数据库库表或字段不匹配，请检查服务端配置')
  }
  if (['ETIMEDOUT', 'PROTOCOL_SEQUENCE_TIMEOUT'].includes(code)) {
    return new ProcurementDatabaseError('PROCUREMENT_DB_TIMEOUT', '采购数据库查询超时，本次未同步')
  }
  return new ProcurementDatabaseError('PROCUREMENT_DB_UNAVAILABLE', '采购数据库读取失败，请检查连接和服务状态')
}
async function readSnapshot<T>(config: ProcurementMysqlConfig, connector: Connector, work: (session: ProcurementMysqlSession) => Promise<T>): Promise<T> {
  let session: ProcurementMysqlSession | undefined
  try {
    session = await connector(config)
    await session.command('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await session.command('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    const result = await work(session)
    await session.command('COMMIT')
    return result
  } catch (error) {
    if (session) await session.command('ROLLBACK').catch(() => undefined)
    throw safeDatabaseError(error)
  } finally { if (session) await session.close().catch(() => undefined) }
}
function sourceSql(config: ProcurementMysqlConfig) {
  const database = identifier(config.database), table = identifier(config.table)
  const from = `${database}.${table} o`
  const active = "o.deleted = b'0' AND o.recycle_flag = b'0'"
  // Only fields consumed by the existing project/detail mappings are selected. Account secrets are never read.
  const columns = `o.id, o.project_name AS projectName, o.sell_order AS sellOrder,
    o.total_cost_price AS totalCostPrice, o.total_selling_price AS totalSellingPrice,
    o.total_transaction_price AS totalTransactionPrice, o.create_time AS createTime, o.creator,
    o.project_type AS projectType, o.purchasing_type AS purchasingType, o.purchasing_status AS purchasingStatus,
    o.purchase_quantity AS purchaseQuantity, o.responsible_person AS responsiblePerson,
    o.purchasing_time AS purchasingTime, o.delivery_requirements AS deliveryRequirements,
    o.design_requirements AS designRequirements, o.remark, o.purchasing_remark AS purchasingRemark,
    COALESCE(NULLIF(u.nickname, ''), NULLIF(u.username, ''), CAST(o.purchasing_id AS CHAR)) AS purchasingName`
  const joined = `${from} LEFT JOIN ${database}.\`system_users\` u ON u.id = o.purchasing_id AND u.deleted = b'0'`
  return { from, active, columns, joined }
}
export async function readMysqlOrders(config: ProcurementMysqlConfig, connector: Connector = connectMysql): Promise<ProcurementPageResult> {
  const sql = sourceSql(config)
  return readSnapshot(config, connector, async session => {
    const counts = await session.select(`SELECT COUNT(*) AS total FROM ${sql.from} WHERE ${sql.active}`)
    const total = Number(counts[0]?.total)
    if (!Number.isSafeInteger(total) || total < 0) throw new ProcurementDatabaseError('PROCUREMENT_DB_DATA_INVALID', '采购数据库记录数量无效')
    const items: Array<Record<string, unknown>> = []; let cursor: string | undefined
    while (items.length < total) {
      const values = cursor === undefined ? [config.pageSize] : [cursor, config.pageSize]
      const rows = await session.select(`SELECT ${sql.columns} FROM ${sql.joined} WHERE ${sql.active}${cursor === undefined ? '' : ' AND o.id > ?'} ORDER BY o.id ASC LIMIT ?`, values)
      if (!rows.length || rows.length > config.pageSize) throw new ProcurementDatabaseError('PROCUREMENT_DB_DATA_INVALID', '采购数据库分页结果不完整，本次未同步')
      for (const row of rows) {
        const item = normalizeMysqlOrder(row), id = String(item.id)
        if (cursor !== undefined && BigInt(id) <= BigInt(cursor)) throw new ProcurementDatabaseError('PROCUREMENT_DB_DATA_INVALID', '采购数据库主键顺序异常，本次未同步')
        cursor = id; items.push(item)
      }
    }
    if (items.length !== total) throw new ProcurementDatabaseError('PROCUREMENT_DB_DATA_INVALID', '采购数据库分页数量不一致，本次未同步')
    return { items, fetched: items.length, total }
  })
}
export async function readMysqlOrderById(id: string, config: ProcurementMysqlConfig, connector: Connector = connectMysql): Promise<Record<string, unknown> | null> {
  if (!/^\d+$/.test(id)) return null
  const sql = sourceSql(config)
  return readSnapshot(config, connector, async session => {
    const rows = await session.select(`SELECT ${sql.columns} FROM ${sql.joined} WHERE ${sql.active} AND o.id = ? LIMIT 1`, [id])
    return rows[0] ? normalizeMysqlOrder(rows[0]) : null
  })
}
