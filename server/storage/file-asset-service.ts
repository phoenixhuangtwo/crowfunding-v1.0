import { randomUUID } from 'node:crypto'
import type { ClientSession } from 'mongodb'
import type { FileAsset } from '../domain/models.ts'
import type { EntityRepository } from '../persistence/repositories.ts'
import type { MongoContext } from '../persistence/mongo.ts'
import type { ObjectStorage } from './object-storage.ts'

export type UploadAssetInput = {
  bytes: Buffer
  fileName: string
  mimeType: string
  extension: string
  sha256: string
  purpose: FileAsset['purpose']
  ownerType: FileAsset['ownerType']
  ownerId: string
  createdBy: string
}

type ServiceOptions = {
  assets: EntityRepository<FileAsset>
  storage: ObjectStorage
  mongo: Pick<MongoContext, 'withTransaction'>
  config: { bucket: string; region: string; objectPrefix: string }
  idFactory?: () => string
  now?: () => string
}

function safeObjectKeyPart(value: string) {
  return value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('..') &&
    !value.includes('\\') &&
    !/%(?:2f|5c)/i.test(value) &&
    !/[\0-\x1f\x7f]/.test(value)
}

export function objectKey(prefix: string, purpose: FileAsset['purpose'], assetId: string, extension: string) {
  const validPurpose = ['receiving-code', 'payment-proof', 'settlement-invoice', 'procurement-payment-proof', 'customer-receipt-proof', 'confirmed-cost-proof'].includes(purpose)
  const validPrefix = safeObjectKeyPart(prefix) && prefix.split('/').every(part => /^[A-Za-z0-9_-]+$/.test(part))
  if (!validPrefix || !validPurpose || !safeObjectKeyPart(assetId) || !/^[A-Za-z0-9_-]+$/.test(assetId) || !/^[a-z0-9]+$/.test(extension)) {
    throw new Error('对象键参数不安全')
  }
  return `${prefix}/${purpose}/${assetId}.${extension}`
}

export class FileAssetService {
  private readonly idFactory: () => string
  private readonly now: () => string

  constructor(private readonly options: ServiceOptions) {
    this.idFactory = options.idFactory ?? randomUUID
    this.now = options.now ?? (() => new Date().toISOString())
  }

  private pendingAsset(input: UploadAssetInput): FileAsset {
    const id = this.idFactory()
    const timestamp = this.now()
    return {
      id,
      provider: 'tencent-cos',
      bucket: this.options.config.bucket,
      region: this.options.config.region,
      objectKey: objectKey(this.options.config.objectPrefix, input.purpose, id, input.extension),
      originalName: input.fileName,
      extension: input.extension,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.length,
      sha256: input.sha256,
      purpose: input.purpose,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      status: 'pending',
      createdBy: input.createdBy,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  }

  private async compensateExactAsset(assetId: string, cause: unknown) {
    const current = await this.options.assets.getById(assetId)
    if (!current) return
    const pendingDelete: FileAsset = {
      ...current,
      status: 'pending_delete',
      updatedAt: this.now(),
      lastError: cause instanceof Error ? cause.message.slice(0, 500) : '资产处理失败'
    }
    await this.options.assets.replace(pendingDelete)
    try {
      await this.options.storage.deleteObject(current.objectKey)
      await this.options.assets.deleteById(current.id)
    } catch (deleteError) {
      await this.options.assets.replace({
        ...pendingDelete,
        updatedAt: this.now(),
        lastError: deleteError instanceof Error ? deleteError.message.slice(0, 500) : 'COS 对象删除失败'
      })
    }
  }

  async uploadUnbound(input: UploadAssetInput) {
    const pending = this.pendingAsset(input)
    await this.options.assets.insert(pending)
    try {
      await this.options.storage.putObject({
        key: pending.objectKey,
        body: input.bytes,
        contentType: input.mimeType,
        sha256: input.sha256
      })
      const stored = await this.options.storage.headObject(pending.objectKey)
      if (!stored || stored.sizeBytes !== input.bytes.length) throw new Error('COS 对象校验失败')
      const ready: FileAsset = { ...pending, status: 'ready', updatedAt: this.now() }
      await this.options.assets.replace(ready)
      return ready
    } catch (error) {
      await this.compensateExactAsset(pending.id, error)
      throw error
    }
  }

  async uploadAndBind<T>(input: UploadAssetInput, bind: (asset: FileAsset, session: ClientSession) => Promise<T>) {
    const ready = await this.uploadUnbound(input)
    try {
      return await this.options.mongo.withTransaction(session => bind(ready, session))
    } catch (error) {
      await this.compensateExactAsset(ready.id, error)
      throw error
    }
  }

  async replaceBinding<T>(
    input: UploadAssetInput & { previousAssetId?: string },
    bind: (asset: FileAsset, session: ClientSession) => Promise<T>
  ) {
    const result = await this.uploadAndBind(input, bind)
    if (input.previousAssetId) {
      await this.compensateExactAsset(input.previousAssetId, new Error('资产已被替换'))
    }
    return result
  }

  async deleteBinding<T>(assetId: string, unbind: (asset: FileAsset, session: ClientSession) => Promise<T>) {
    const asset = await this.options.assets.getById(assetId)
    if (!asset) throw new Error('文件不存在')
    const result = await this.options.mongo.withTransaction(async session => {
      const value = await unbind(asset, session)
      await this.options.assets.replace({ ...asset, status: 'pending_delete', updatedAt: this.now() }, session)
      return value
    })
    try {
      await this.options.storage.deleteObject(asset.objectKey)
      await this.options.assets.deleteById(asset.id)
    } catch (error) {
      await this.options.assets.replace({
        ...asset,
        status: 'pending_delete',
        updatedAt: this.now(),
        lastError: error instanceof Error ? error.message.slice(0, 500) : 'COS 对象删除失败'
      })
      throw error
    }
    return result
  }

  async getReadyAsset(assetId: string) {
    const asset = await this.options.assets.getById(assetId)
    return asset?.status === 'ready' ? asset : null
  }

  openReadStream(asset: FileAsset) {
    return this.options.storage.getObjectStream(asset.objectKey)
  }
}
