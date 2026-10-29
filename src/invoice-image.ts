const supportedInvoiceImageTypes = new Set(['image/png', 'image/jpeg', 'image/bmp'])
const maxInvoiceImageSize = 5 * 1024 * 1024

export function validateInvoiceImage(file: { type: string; size: number }): string | undefined {
  if (!supportedInvoiceImageTypes.has(file.type)) return '发票识别仅支持 PNG、JPG、JPEG 或 BMP 图片'
  if (file.size > maxInvoiceImageSize) return '发票图片大小不能超过 5MB'
  return undefined
}
