import { traceOperation, logEvent, logFailure } from '../observability.ts'
import type { Readable } from 'node:stream'
import COS from 'cos-nodejs-sdk-v5'

export type PutObjectInput = { key: string; body: Buffer; contentType: string; sha256: string }

export interface ObjectStorage {
  putObject(input: PutObjectInput): Promise<void>
  headObject(key: string): Promise<{ sizeBytes: number } | null>
  getObjectStream(key: string): Readable
  deleteObject(key: string): Promise<void>
  checkHealth(): Promise<'up' | 'degraded'>
}

type TencentCosConfig = {
  secretId: string
  secretKey: string
  bucket: string
  region: string
}

export class TencentCosObjectStorage implements ObjectStorage {
  private readonly cos: COS

  constructor(private readonly config: TencentCosConfig) {
    this.cos = new COS({ SecretId: config.secretId, SecretKey: config.secretKey })
  }

  async putObject(input: PutObjectInput) {
    await traceOperation('cos', 'putObject', () => this.cos.putObject({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ACL: 'private',
      Headers: { 'x-cos-meta-sha256': input.sha256 }
    }))
  }

  async headObject(key: string) {
    try {
      const result = await traceOperation('cos', 'headObject', () => this.cos.headObject({ Bucket: this.config.bucket, Region: this.config.region, Key: key }))
      const headers = result.headers as Record<string, string | undefined>
      const sizeBytes = Number(headers['content-length'] ?? 0)
      return { sizeBytes }
    } catch (error) {
      const statusCode = Number((error as { statusCode?: unknown })?.statusCode)
      if (statusCode === 404) return null
      throw error
    }
  }

  getObjectStream(key: string) {
    const start = performance.now()
    const stream = this.cos.getObjectStream({ Bucket: this.config.bucket, Region: this.config.region, Key: key }) as Readable
    stream.once('end', () => logEvent('dependency.complete', { dependency: 'cos', operation: 'getObjectStream', outcome: 'success', durationMs: Math.round(performance.now() - start) }))
    stream.once('error', error => {
      logEvent('dependency.complete', { dependency: 'cos', operation: 'getObjectStream', outcome: 'failure', durationMs: Math.round(performance.now() - start) })
      logFailure('cos.stream.error', error)
    })
    return stream
  }

  async deleteObject(key: string) {
    await traceOperation('cos', 'deleteObject', () => this.cos.deleteObject({ Bucket: this.config.bucket, Region: this.config.region, Key: key }))
  }

  async checkHealth() {
    try {
      await traceOperation('cos', 'headBucket', () => this.cos.headBucket({ Bucket: this.config.bucket, Region: this.config.region }))
      return 'up' as const
    } catch {
      return 'degraded' as const
    }
  }
}
