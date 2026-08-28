import { createHash } from 'node:crypto'

export type ValidatedImage = {
  bytes: Buffer
  fileName: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/bmp' | 'image/webp'
  extension: 'png' | 'jpg' | 'bmp' | 'webp'
  sizeBytes: number
  sha256: string
}

type ImageInput = {
  bytes: Buffer
  fileName: string
  declaredMime: string
  maxBytes: number
  allowedMimeTypes?: readonly ValidatedImage['mimeType'][]
}

const signatures: Array<{
  mimeType: ValidatedImage['mimeType']
  extension: ValidatedImage['extension']
  extensions: readonly string[]
  matches(bytes: Buffer): boolean
}> = [
  {
    mimeType: 'image/png',
    extension: 'png',
    extensions: ['png'],
    matches: bytes => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  },
  {
    mimeType: 'image/jpeg',
    extension: 'jpg',
    extensions: ['jpg', 'jpeg'],
    matches: bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  },
  {
    mimeType: 'image/bmp',
    extension: 'bmp',
    extensions: ['bmp'],
    matches: bytes => bytes.length >= 2 && bytes.subarray(0, 2).toString('ascii') === 'BM'
  },
  {
    mimeType: 'image/webp',
    extension: 'webp',
    extensions: ['webp'],
    matches: bytes => bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  }
]

export function validateImageFile(input: ImageInput): ValidatedImage {
  if (input.bytes.length === 0 || input.bytes.length > input.maxBytes) throw new Error(`图片大小不能超过 ${input.maxBytes} 字节`)
  if (!input.fileName || input.fileName.length > 255 || /[\\/\0-\x1f]/.test(input.fileName) || input.fileName.includes('..')) {
    throw new Error('图片文件名无效')
  }

  const detected = signatures.find(signature => signature.matches(input.bytes))
  if (!detected || detected.mimeType !== input.declaredMime.toLowerCase()) throw new Error('文件内容与图片类型不匹配')
  if (input.allowedMimeTypes && !input.allowedMimeTypes.includes(detected.mimeType)) throw new Error('该图片类型不受支持')

  const extension = input.fileName.includes('.') ? input.fileName.split('.').at(-1)!.toLowerCase() : ''
  if (!detected.extensions.includes(extension)) throw new Error('文件扩展名与图片类型不匹配')

  return {
    bytes: input.bytes,
    fileName: input.fileName,
    mimeType: detected.mimeType,
    extension: detected.extension,
    sizeBytes: input.bytes.length,
    sha256: createHash('sha256').update(input.bytes).digest('hex')
  }
}
