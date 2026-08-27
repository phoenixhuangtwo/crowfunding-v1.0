import assert from 'node:assert/strict'
import test from 'node:test'
import { recognizeFinanceBill } from '../server/invoice-ocr.ts'

test('advanced OCR returns the fixed transaction date, payer, payee and amount fields', async () => {
  let requestUrl = ''
  let requestInit: RequestInit | undefined
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input)
    requestInit = init
    return new Response(JSON.stringify({
      content: [
        '出账回单 招商银行',
        '交易日期：2026年08月21日 业务类型：支付',
        '付款账号：120924458210001 付款人：广州福尚云科技研发有限公司 付款开户行：招商银行广州分行',
        '收款账号：31050165363600002275 收款人：文昌科技(上海)有限公司 收款方开户行：中国建设银行股份有限公司上海曹河泾支行',
        '金额(小写)：CNY10, 000.00 交易金额(大写)：人民币壹万元整'
      ].join('\n'),
      prism_version: '1.0.9',
      prism_wnum: 5,
      prism_wordsInfo: [
        { word: '出账回单 招商银行', prob: 99 },
        { word: '交易日期：2026年08月21日 业务类型：支付', prob: 98 },
        { word: '付款账号：120924458210001 付款人：广州福尚云科技研发有限公司 付款开户行：招商银行广州分行', prob: 99 },
        { word: '收款账号：31050165363600002275 收款人：文昌科技(上海)有限公司 收款方开户行：中国建设银行股份有限公司上海曹河泾支行', prob: 97 },
        { word: '金额(小写)：CNY10, 000.00 交易金额(大写)：人民币壹万元整', prob: 99 }
      ]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  const result = await recognizeFinanceBill({
    imageDataUrl: 'data:image/png;base64,aGVsbG8=',
    appCode: 'server-only-code',
    fetchImpl
  })

  assert.equal(requestUrl, 'https://gjbsb.market.alicloudapi.com/ocrservice/advanced')
  assert.equal(requestInit?.method, 'POST')
  assert.ok(requestInit?.signal instanceof AbortSignal)
  assert.deepEqual(requestInit?.headers, {
    Authorization: 'APPCODE server-only-code',
    'Content-Type': 'application/json; charset=UTF-8'
  })
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { img: 'aGVsbG8=' })
  assert.equal(result.amount, 10000)
  assert.equal(result.taskNo, undefined)
  assert.deepEqual(result.fields, [
    { key: 'transactionDate', label: '交易日期', value: '2026年08月21日' },
    { key: 'payer', label: '付款人', value: '广州福尚云科技研发有限公司' },
    { key: 'payee', label: '收款人', value: '文昌科技(上海)有限公司' },
    { key: 'transactionAmount', label: '交易金额', value: 'CNY 10,000.00' }
  ])
})

test('advanced OCR keeps all four fixed fields visible when part of a receipt is not recognized', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    content: '交易日期：2026-08-21\n金额（小写）：￥520.00',
    prism_wnum: 2,
    prism_wordsInfo: []
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  const result = await recognizeFinanceBill({
    imageDataUrl: 'data:image/png;base64,aGVsbG8=',
    appCode: 'server-only-code',
    fetchImpl
  })

  assert.equal(result.amount, 520)
  assert.deepEqual(result.fields, [
    { key: 'transactionDate', label: '交易日期', value: '2026-08-21' },
    { key: 'payer', label: '付款人', value: '未识别' },
    { key: 'payee', label: '收款人', value: '未识别' },
    { key: 'transactionAmount', label: '交易金额', value: 'CNY 520.00' }
  ])
})

test('advanced OCR reports the upstream business error without leaking credentials', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    error_code: 400,
    error_msg: '图片格式错误'
  }), { status: 400, headers: { 'Content-Type': 'application/json' } })

  await assert.rejects(
    recognizeFinanceBill({
      imageDataUrl: 'data:image/jpeg;base64,aGVsbG8=',
      appCode: 'must-not-leak',
      fetchImpl
    }),
    error => error instanceof Error && error.message === '发票识别失败：图片格式错误'
  )
})

test('advanced OCR treats an empty text response as recognition failure', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    content: '',
    prism_version: '1.0.9',
    prism_wnum: 0,
    prism_wordsInfo: []
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  await assert.rejects(
    recognizeFinanceBill({
      imageDataUrl: 'data:image/png;base64,aGVsbG8=',
      appCode: 'server-only-code',
      fetchImpl
    }),
    /未识别到有效票据内容/
  )
})

test('finance invoice OCR rejects unsupported or oversized image data before calling the supplier', async () => {
  let called = false
  const fetchImpl: typeof fetch = async () => {
    called = true
    return new Response('{}')
  }

  await assert.rejects(
    recognizeFinanceBill({
      imageDataUrl: 'data:application/pdf;base64,aGVsbG8=',
      appCode: 'server-only-code',
      fetchImpl
    }),
    /PNG、JPG、JPEG 或 BMP/
  )
  assert.equal(called, false)
})

test('finance invoice OCR aborts a stalled upstream request at the configured timeout', async () => {
  const fetchImpl: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  })

  await assert.rejects(
    recognizeFinanceBill({
      imageDataUrl: 'data:image/png;base64,aGVsbG8=',
      appCode: 'server-only-code',
      fetchImpl,
      timeoutMs: 1
    }),
    /发票识别服务请求超时/
  )
})
