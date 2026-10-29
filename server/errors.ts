export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'AppError'
  }
}

export const appError = (status: number, code: string, message: string) => new AppError(status, code, message)

export async function required<T>(value: Promise<T | null>, code: string): Promise<T> {
  const resolved = await value
  if (!resolved) throw appError(404, code, '记录不存在')
  return resolved
}

export const isDuplicateKey = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000
