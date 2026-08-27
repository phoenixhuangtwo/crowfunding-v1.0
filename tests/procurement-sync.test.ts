import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchProcurementPage } from '../server/procurement.ts'
import { mapProcurementOrderToProject } from '../server/procurement-project.ts'

const upstreamBody = {
  code: 0,
  data: {
    list: [
      {
        id: 1024,
        sellOrder: 'XS-20260825-001',
        projectName: '会议屏采购',
        projectType: 1,
        companyId: 8,
        companyName: '示例公司',
        approvalNo: 'SP-001',
        orderDate: '2026-08-25',
        responsiblePerson: '采购员',
        completeDate: null,
        distributionMode: 1,
        onePackage: false,
        giftsType: null,
        designRequirements: '',
        deliveryRequirements: '',
        remark: '',
        purchaseQuantity: 10,
        totalSellingPrice: 100000,
        totalTransactionPrice: 90000,
        totalCostPrice: 70000,
        purchasingId: 2,
        purchasingName: '采购员',
        purchasingRemark: '',
        purchasingTime: '2026-08-25 09:00:00',
        creator: '2',
        createTime: '2026-08-25 08:00:00',
        file: [],
        picUrls: [],
        purchasingStatus: 1,
        afterSaleStatus: 0,
        orderAdditionalFlag: false,
        orderAdditionalReason: '',
        extraSellOrders: [],
        exchangeSellOrders: [],
        originalSellOrder: null,
        purchasingType: 1,
        rating: null,
        ratingTime: null
      }
    ],
    total: 37,
    totalOut: {},
    totalIn: {}
  },
  msg: ''
}

test('fetchProcurementPage sends the fixed page query and returns a count summary', async () => {
  const result = await fetchProcurementPage({
    baseUrl: 'https://procurement.example.test/admin-api/erp/offline-order/page',
    token: 'Bearer test-token',
    fetchImpl: async (input, init) => {
      assert.equal(
        String(input),
        'https://procurement.example.test/admin-api/erp/offline-order/page?pageNo=1&pageSize=10&queryFromPage=N&exchangeSellOrder=&extraSellOrder=&recycleFlag=0'
      )
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token')
      assert.ok(init?.signal instanceof AbortSignal)
      return new Response(JSON.stringify(upstreamBody), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  })

  assert.equal(result.fetched, 1)
  assert.equal(result.total, 37)
  assert.equal(result.items[0]?.id, 1024)
})

test('fetchProcurementPage includes the project name when loading order details', async () => {
  const options = {
    baseUrl: 'https://procurement.example.test/admin-api/erp/offline-order/page',
    token: 'Bearer test-token',
    projectName: '中国家庭医生',
    fetchImpl: async (input: URL | RequestInfo) => {
      assert.equal(
        String(input),
        'https://procurement.example.test/admin-api/erp/offline-order/page?pageNo=1&pageSize=10&queryFromPage=N&exchangeSellOrder=&extraSellOrder=&recycleFlag=0&projectName=%E4%B8%AD%E5%9B%BD%E5%AE%B6%E5%BA%AD%E5%8C%BB%E7%94%9F'
      )
      return new Response(JSON.stringify(upstreamBody), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  }

  await fetchProcurementPage(options)
})

test('fetchProcurementPage rejects a missing server-side token before calling upstream', async () => {
  let called = false

  await assert.rejects(
    fetchProcurementPage({
      baseUrl: 'https://procurement.example.test/admin-api/erp/offline-order/page',
      token: '',
      fetchImpl: async () => {
        called = true
        return new Response('{}')
      }
    }),
    /未配置采购系统认证信息/
  )

  assert.equal(called, false)
})

test('fetchProcurementPage reports an expired or invalid upstream token', async () => {
  await assert.rejects(
    fetchProcurementPage({
      baseUrl: 'https://procurement.example.test/admin-api/erp/offline-order/page',
      token: 'Bearer expired-token',
      fetchImpl: async () => new Response(JSON.stringify({ code: 401, data: null, msg: 'Unauthorized' }), { status: 401 })
    }),
    /采购系统认证失败/
  )
})

test('fetchProcurementPage rejects an upstream business error instead of reporting success', async () => {
  await assert.rejects(
    fetchProcurementPage({
      baseUrl: 'https://procurement.example.test/admin-api/erp/offline-order/page',
      token: 'Bearer test-token',
      fetchImpl: async () => new Response(JSON.stringify({ code: 500, data: null, msg: '采购服务繁忙' }), { status: 200 })
    }),
    /采购服务繁忙/
  )
})

test('mapProcurementOrderToProject converts cents and matches the existing project fields', () => {
  const project = mapProcurementOrderToProject({
    ...upstreamBody.data.list[0],
    totalSellingPrice: 2_453_018,
    totalTransactionPrice: 2_300_000,
    totalCostPrice: 723_800
  })

  assert.deepEqual(project, {
    id: 'PRJ-FSY-OFFLINE-1024',
    title: '会议屏采购',
    source: '采购系统 · XS-20260825-001',
    projectOwner: '2',
    status: '未开放',
    statusType: 'info',
    progress: 0,
    remain: 7238,
    deadline: '',
    total: 7238,
    costAmount: 7238,
    salesAmount: 23000,
    profitAmount: 15762,
    companyFixedAmount: 0,
    companyTakeoverAmount: 0,
    companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 0,
    subscribed: 0,
    people: 0
  })
})

test('mergeProcurementProject only backfills the creator for protected projects', async () => {
  const { mergeProcurementProject } = await import('../server/procurement-project.ts') as {
    mergeProcurementProject?: (existing: Record<string, unknown>, mapped: Record<string, unknown>, protectedProject: boolean) => string
  }
  const existing = {
    ...mapProcurementOrderToProject(upstreamBody.data.list[0])!,
    title: '已配置规则的内部项目名称',
    status: '已满额' as const,
    projectOwner: undefined
  }
  const mapped = mapProcurementOrderToProject(upstreamBody.data.list[0])!

  assert.equal(typeof mergeProcurementProject, 'function')
  assert.equal(mergeProcurementProject!(existing, mapped, true), 'updated')
  assert.equal(existing.projectOwner, '2')
  assert.equal(existing.title, '已配置规则的内部项目名称')
  assert.equal(existing.status, '已满额')
})

test('mapProcurementOrderToProject falls back to selling price when transaction price is zero', () => {
  const project = mapProcurementOrderToProject({
    ...upstreamBody.data.list[0],
    totalSellingPrice: 2_453_018,
    totalTransactionPrice: 0,
    totalCostPrice: 723_800
  })

  assert.equal(project?.salesAmount, 24530.18)
  assert.equal(project?.profitAmount, 17292.18)
})

test('mapProcurementOrderToProject skips orders without a positive cost', () => {
  assert.equal(mapProcurementOrderToProject({ ...upstreamBody.data.list[0], totalCostPrice: null }), null)
  assert.equal(mapProcurementOrderToProject({ ...upstreamBody.data.list[0], totalCostPrice: 0 }), null)
})

test('fetchProcurementPage aborts a stalled upstream request at the configured timeout', async () => {
  const fetchImpl: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  })

  await assert.rejects(
    fetchProcurementPage({
      baseUrl: 'https://procurement.example.test/admin-api/erp/offline-order/page',
      token: 'Bearer test-token',
      fetchImpl,
      timeoutMs: 1
    }),
    /采购系统请求超时/
  )
})
