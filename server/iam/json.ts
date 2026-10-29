import JSONBig from 'json-bigint'

const iamJson = JSONBig({ strict: true, useNativeBigInt: true })

export type NormalizeIamIdOptions = { allowZero?: boolean }

function canonicalDecimal(value: string, allowZero: boolean): string {
  if (!/^\d+$/.test(value)) throw new Error('IAM ID 必须为非负十进制整数')
  const normalized = value.replace(/^0+(?=\d)/, '')
  if (!allowZero && normalized === '0') throw new Error('IAM ID 必须为正十进制整数')
  return normalized
}

function rejectFractionOrExponentTokens(text: string): void {
  let insideString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (insideString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') insideString = false
      continue
    }
    if (character === '"') {
      insideString = true
      continue
    }
    if (character !== '-' && (character < '0' || character > '9')) continue
    const token = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (!token) continue
    if (token[0].includes('.') || /[eE]/.test(token[0])) {
      throw new SyntaxError('IAM JSON 整数必须使用十进制形式')
    }
    index += token[0].length - 1
  }
}

export function normalizeIamId(value: unknown, options: NormalizeIamIdOptions = {}): string {
  const allowZero = options.allowZero ?? false
  if (typeof value === 'string') return canonicalDecimal(value, allowZero)
  if (typeof value === 'bigint') return canonicalDecimal(value.toString(), allowZero)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('IAM ID Number 必须为安全整数')
    if (Object.is(value, -0) || value < 0) throw new Error('IAM ID 必须为非负十进制整数')
    return canonicalDecimal(String(value), allowZero)
  }
  throw new Error('IAM ID 必须为十进制字符串、安全整数或 BigInt')
}

export function parseIamJson(text: string): unknown {
  try {
    rejectFractionOrExponentTokens(text)
    return iamJson.parse(text)
  } catch {
    throw new SyntaxError('IAM JSON 无效')
  }
}
