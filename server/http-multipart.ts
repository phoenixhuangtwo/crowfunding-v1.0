import type { IncomingMessage } from 'node:http'
import Busboy from 'busboy'

export type MultipartImage = {
  fields: Record<string, string>
  file: { bytes: Buffer; fileName: string; declaredMime: string }
}

export function readSingleImageMultipart(
  req: IncomingMessage,
  options: { maxFileBytes: number; maxFieldBytes: number; allowedFields: readonly string[] }
): Promise<MultipartImage> {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] ?? '')
    if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
      reject(new Error('请求必须使用 multipart/form-data'))
      return
    }

    let parser: ReturnType<typeof Busboy>
    try {
      parser = Busboy({
        headers: req.headers,
        limits: {
          files: 2,
          fields: options.allowedFields.length + 1,
          parts: options.allowedFields.length + 2,
          fileSize: options.maxFileBytes,
          fieldSize: options.maxFieldBytes,
          headerPairs: 100
        }
      })
    } catch {
      reject(new Error('multipart 请求格式无效'))
      return
    }

    const fields: Record<string, string> = {}
    let file: MultipartImage['file'] | undefined
    let fileCount = 0
    let failed = false

    const fail = (error: Error) => {
      if (failed) return
      failed = true
      reject(error)
    }

    parser.on('field', (name, value, info) => {
      if (failed) return
      if (!options.allowedFields.includes(name)) return fail(new Error(`不允许的表单字段：${name}`))
      if (Object.hasOwn(fields, name)) return fail(new Error(`重复字段：${name}`))
      if (info.valueTruncated || Buffer.byteLength(value) > options.maxFieldBytes) return fail(new Error(`表单字段过大：${name}`))
      fields[name] = value
    })

    parser.on('file', (name, stream, info) => {
      fileCount += 1
      if (name !== 'image') {
        stream.resume()
        fail(new Error(`不允许的文件字段：${name}`))
        return
      }
      if (fileCount > 1) {
        stream.resume()
        fail(new Error('只能上传一个图片文件'))
        return
      }
      const chunks: Buffer[] = []
      let truncated = false
      stream.on('limit', () => { truncated = true })
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
      stream.on('error', () => fail(new Error('图片上传流读取失败')))
      stream.on('end', () => {
        if (truncated) return fail(new Error('图片文件超过大小限制'))
        file = { bytes: Buffer.concat(chunks), fileName: info.filename, declaredMime: info.mimeType }
      })
    })

    parser.on('filesLimit', () => fail(new Error('只能上传一个图片文件')))
    parser.on('fieldsLimit', () => fail(new Error('表单字段数量超过限制')))
    parser.on('partsLimit', () => fail(new Error('multipart 内容数量超过限制')))
    parser.on('error', () => fail(new Error('multipart 请求解析失败')))
    parser.on('finish', () => {
      if (failed) return
      if (!file || fileCount !== 1) return fail(new Error('必须上传一个图片文件'))
      resolve({ fields, file })
    })
    req.once('aborted', () => fail(new Error('图片上传请求已中断')))
    req.once('error', () => fail(new Error('图片上传请求读取失败')))
    const buffered = (req as IncomingMessage & { rawBody?: Buffer }).rawBody
    if (buffered) parser.end(buffered)
    else req.pipe(parser)
  })
}
