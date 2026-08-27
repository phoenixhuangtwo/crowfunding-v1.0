export type ProcurementPageResult = {
  items: Array<Record<string, unknown>>
  fetched: number
  total: number
}

type FetchProcurementPageOptions = {
  baseUrl: string
  token: string
  projectName?: string
  fetchImpl?: typeof fetch
}

export async function fetchProcurementPage({
  baseUrl,
  token,
  projectName,
  fetchImpl = fetch
}: FetchProcurementPageOptions): Promise<ProcurementPageResult> {
  if (!token.trim()) throw new Error('未配置采购系统认证信息，请先配置服务端令牌')

  const url = new URL(baseUrl)
  url.searchParams.set('pageNo', '1')
  url.searchParams.set('pageSize', '10')
  url.searchParams.set('queryFromPage', 'N')
  url.searchParams.set('exchangeSellOrder', '')
  url.searchParams.set('extraSellOrder', '')
  url.searchParams.set('recycleFlag', '0')
  if (projectName?.trim()) url.searchParams.set('projectName', projectName.trim())

  const response = await fetchImpl(url, {
    headers: { Authorization: token }
  })

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
