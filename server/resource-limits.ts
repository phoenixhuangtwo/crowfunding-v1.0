export class ResourceLimitError extends Error {
  readonly status = 429
  readonly code = 'RESOURCE_LIMIT_EXCEEDED'
}

type SlidingWindowQuotaOptions = {
  limit: number
  windowMs: number
  now?: () => number
}

export class SlidingWindowQuota {
  private readonly calls = new Map<string, number[]>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(options: SlidingWindowQuotaOptions) {
    this.limit = options.limit
    this.windowMs = options.windowMs
    this.now = options.now ?? Date.now
  }

  take(key: string) {
    const now = this.now()
    const active = (this.calls.get(key) ?? []).filter(timestamp => timestamp > now - this.windowMs)
    if (active.length >= this.limit) throw new ResourceLimitError('请求过于频繁，请稍后重试')
    active.push(now)
    this.calls.set(key, active)
  }
}

export function hasImageStorageCapacity(currentChars: number, replacedChars: number, incomingChars: number, maxChars: number) {
  return currentChars - replacedChars + incomingChars <= maxChars
}

export function hasImageByteCapacity(currentBytes: number, replacedBytes: number, incomingBytes: number, maxBytes: number) {
  return currentBytes - replacedBytes + incomingBytes <= maxBytes
}
