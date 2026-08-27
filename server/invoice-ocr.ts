const defaultEndpoint = 'https://gjbsb.market.alicloudapi.com/ocrservice/advanced'
const maxImageDataUrlLength = Math.ceil(5 * 1024 * 1024 * 4 / 3) + 128
const supportedImageDataUrl = /^data:image\/(?:png|jpe?g|bmp);base64,([A-Za-z0-9+/]+={0,2})$/

export type InvoiceOcrField = {
  key: string
  label: string
  value: string
}

export type InvoiceOcrResult = {
  amount?: number
  taskNo?: string
  fields: InvoiceOcrField[]
}

type RecognizeFinanceBillOptions = {
  imageDataUrl: string
  appCode: string
  endpoint?: string
  fetchImpl?: typeof fetch
}

function normalizedReceiptText(content: string) {
  return content
    .replace(/，/g, ',')
    .replace(/(\d)\s*,\s*(?=\d)/g, '$1,')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractReceiptAmount(content: string) {
  const match = content.match(/(?:交易金额(?:[（(]小写[）)])?|金额[（(]小写[）)]|价税合计(?:[（(]小写[）)])?|小写金额|金额合计|合计金额)\s*[：:]\s*(?:CNY|RMB|人民币|[¥￥])?\s*(-?\d[\d,]*(?:\.\d{1,2})?)/i)
  if (!match) return undefined
  const amount = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(amount) ? amount : undefined
}

function formatReceiptAmount(amount: number) {
  const [integer, decimal] = amount.toFixed(2).split('.')
  return `CNY ${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`
}

function extractReceiptFields(content: string): InvoiceOcrField[] {
  const normalized = normalizedReceiptText(content)
  const transactionDate = normalized.match(/交易日期\s*[：:]\s*(\d{4}(?:年\d{1,2}月\d{1,2}日|[-/.]\d{1,2}[-/.]\d{1,2}))/)?.[1]
  const payer = normalized.match(/付款人\s*[：:]\s*(.+?)(?=\s*(?:付款开户行|付款方开户行|收款账号|收款人|交易金额|金额[（(]小写)\s*[：:]|$)/)?.[1]
  const payee = normalized.match(/收款人\s*[：:]\s*(.+?)(?=\s*(?:收款方?开户行|交易金额|金额[（(]小写)\s*[：:]|$)/)?.[1]
  const amount = extractReceiptAmount(normalized)
  return [
    { key: 'transactionDate', label: '交易日期', value: transactionDate?.trim() || '未识别' },
    { key: 'payer', label: '付款人', value: payer?.trim() || '未识别' },
    { key: 'payee', label: '收款人', value: payee?.trim() || '未识别' },
    { key: 'transactionAmount', label: '交易金额', value: amount === undefined ? '未识别' : formatReceiptAmount(amount) }
  ]
}

function recognizedContent(result: Record<string, unknown>) {
  if (typeof result.content === 'string' && result.content.trim()) return result.content.trim()
  if (!Array.isArray(result.prism_wordsInfo)) return ''
  return result.prism_wordsInfo
    .map(item => item && typeof item === 'object' && typeof (item as { word?: unknown }).word === 'string'
      ? (item as { word: string }).word.trim()
      : '')
    .filter(Boolean)
    .join('\n')
}

export async function recognizeFinanceBill({
  imageDataUrl,
  appCode,
  endpoint = defaultEndpoint,
  fetchImpl = fetch
}: RecognizeFinanceBillOptions): Promise<InvoiceOcrResult> {
  if (!appCode.trim()) throw new Error('未配置发票 OCR 服务端认证信息')
  if (imageDataUrl.length > maxImageDataUrlLength) throw new Error('发票图片大小不能超过 5MB')
  const match = supportedImageDataUrl.exec(imageDataUrl)
  if (!match) throw new Error('发票识别仅支持 PNG、JPG、JPEG 或 BMP 图片')

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `APPCODE ${appCode.trim()}`,
      'Content-Type': 'application/json; charset=UTF-8'
    },
    body: JSON.stringify({ img: match[1] })
  })

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(`发票识别服务返回了无法解析的数据（HTTP ${response.status}）`)
  }

  const result = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  if (!response.ok || result.success === false || result.error_code) {
    const suppliedMessage = [result.error_msg, result.message, result.msg]
      .find(value => typeof value === 'string' && value.trim())
    const message = typeof suppliedMessage === 'string' ? suppliedMessage.trim() : `HTTP ${response.status}`
    throw new Error(`发票识别失败：${message}`)
  }

  const content = recognizedContent(result)
  if (!content) throw new Error('发票识别失败：未识别到有效票据内容')
  const normalizedContent = normalizedReceiptText(content)
  return {
    amount: extractReceiptAmount(normalizedContent),
    taskNo: [result.taskNo, result.request_id, result.requestId, result.RequestId]
      .find(value => typeof value === 'string') as string | undefined,
    fields: extractReceiptFields(normalizedContent)
  }
}
