import { fetchAllProcurementPages } from './procurement.ts'
import { loadProcurementMysqlConfig, readMysqlOrders, readMysqlOrderById, ProcurementDatabaseError } from './procurement-mysql.ts'
import { traceOperation } from './observability.ts'

export function procurementSourceMode(env: NodeJS.ProcessEnv = process.env): 'mysql' | 'http' {
  const source = env.PROCUREMENT_SOURCE ?? 'mysql'
  if (source !== 'mysql' && source !== 'http') throw new ProcurementDatabaseError('PROCUREMENT_DB_CONFIGURATION_INVALID', '采购数据源配置无效')
  return source
}
export function loadProcurementOrders(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch) {
  if (procurementSourceMode(env) === 'mysql') {
    return traceOperation('procurement', 'readMysqlOrders', () => readMysqlOrders(loadProcurementMysqlConfig(env)))
  }
  return fetchAllProcurementPages({ baseUrl: env.PROCUREMENT_API_URL ?? 'https://prod-api-admin.fushangyunfu.com/admin-api/erp/offline-order/page', token: env.PROCUREMENT_TOKEN ?? '', fetchImpl })
}
export async function loadProcurementOrder(id: string, projectName?: string, env: NodeJS.ProcessEnv = process.env) {
  if (procurementSourceMode(env) === 'mysql') {
    return traceOperation('procurement', 'readMysqlOrderById', () => readMysqlOrderById(id, loadProcurementMysqlConfig(env)))
  }
  const result = await fetchAllProcurementPages({ baseUrl: env.PROCUREMENT_API_URL ?? 'https://prod-api-admin.fushangyunfu.com/admin-api/erp/offline-order/page', token: env.PROCUREMENT_TOKEN ?? '', projectName })
  return result.items.find(item => String(item.id ?? '').trim() === id) ?? null
}
