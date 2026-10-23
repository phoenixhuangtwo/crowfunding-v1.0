import { traceOperation } from './observability.ts'
export type ProcurementPageResult = {
  items: Array<Record<string, unknown>>
  fetched: number
  total: number
}

export type ProcurementSyncSummary = {
  fetched: number
  total: number
  created: number
  updated: number
  skipped: number
  skippedByReason: {
    missingId: number
    missingTitle: number
    nonPositiveCost: number
    protectedUnchanged: number
  }
}

type FetchProcurementPageOptions = {
  baseUrl: string
  token: string
  projectName?: string
  pageNo?: number
  pageSize?: number
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

async function fetchProcurementPageImpl({
  baseUrl,
  token,
  projectName,
  pageNo = 1,
  pageSize = 10,
  fetchImpl = fetch,
  timeoutMs = 10_000
}: FetchProcurementPageOptions): Promise<ProcurementPageResult> {
  if (!token.trim()) throw new Error('未配置采购系统认证信息，请先配置服务端令牌')

  const url = new URL(baseUrl)
  url.searchParams.set('pageNo', String(pageNo))
  url.searchParams.set('pageSize', String(pageSize))
  url.searchParams.set('queryFromPage', 'N')
  url.searchParams.set('exchangeSellOrder', '')
  url.searchParams.set('extraSellOrder', '')
  url.searchParams.set('recycleFlag', '0')
  if (projectName?.trim()) url.searchParams.set('projectName', projectName.trim())

  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) {
      throw new Error('采购系统请求超时')
    }
    throw error
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('采购系统认证失败，请更新服务端令牌')
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(`采购系统返回了无法解析的数据（HTTP ${response.status}）`)
  }

  if (!response.ok) throw new Error(`采购系统请求失败（HTTP ${response.status}）`)
  if (!payload || typeof payload !== 'object') throw new Error('采购系统返回数据结构异常')

  const body = payload as { code?: unknown; msg?: unknown; data?: unknown }
  if (body.code !== 0) {
    throw new Error(typeof body.msg === 'string' && body.msg ? body.msg : '采购系统返回业务错误')
  }
  if (!body.data || typeof body.data !== 'object') throw new Error('采购系统返回数据结构异常')

  const data = body.data as { list?: unknown; total?: unknown }
  if (!Array.isArray(data.list) || typeof data.total !== 'number') throw new Error('采购系统返回数据结构异常')

  return {
    items: data.list as Array<Record<string, unknown>>,
    fetched: data.list.length,
    total: data.total
  }
}

export async function fetchAllProcurementPages(options: FetchProcurementPageOptions): Promise<ProcurementPageResult> {
  const pageSize = options.pageSize ?? 10
  const firstPage = await fetchProcurementPage({ ...options, pageNo: 1, pageSize })
  const items = [...firstPage.items]
  const pageCount = Math.ceil(firstPage.total / pageSize)

  for (let pageNo = 2; pageNo <= pageCount; pageNo += 1) {
    const page = await fetchProcurementPage({ ...options, pageNo, pageSize })
    items.push(...page.items)
  }

  return { items, fetched: items.length, total: firstPage.total }
}

export function formatProcurementSyncMessage(summary: ProcurementSyncSummary) {
  const reasons = summary.skippedByReason
  return `采购订单同步完成：拉取 ${summary.fetched}/${summary.total} 条，新增 ${summary.created} 条，更新 ${summary.updated} 条，跳过 ${summary.skipped} 条（缺少编号 ${reasons.missingId}、缺少名称 ${reasons.missingTitle}、成本无效 ${reasons.nonPositiveCost}、受保护且无变化 ${reasons.protectedUnchanged}）`
}

export function fetchProcurementPage(options: FetchProcurementPageOptions) {
  return traceOperation('procurement', 'fetchProcurementPage', () => fetchProcurementPageImpl(options))
}
