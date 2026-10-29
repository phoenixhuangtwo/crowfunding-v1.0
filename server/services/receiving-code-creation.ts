import type { ClientSession, Filter } from 'mongodb'
import type { AuditLog, ReceivingCode } from '../domain/models.ts'
import type { EntityRepository } from '../persistence/repositories.ts'
import type { MongoContext } from '../persistence/mongo.ts'
import type { ValidatedImage } from '../image-file.ts'
import type { FileAssetService } from '../storage/file-asset-service.ts'

type CreationInput = {
  createRequestId: string
  subject: string
  accountNote: string
  codeName: string
  operator: string
  role: 'admin' | 'finance'
  image?: ValidatedImage
}

type CreationDependencies = {
  receivingCodes: EntityRepository<ReceivingCode>
  auditLogs: EntityRepository<AuditLog>
  files: Pick<FileAssetService, 'uploadAndBind'>
  mongo: Pick<MongoContext, 'withTransaction'>
  idFactory(): string
  auditIdFactory(): string
  now(): string
}

class ExistingCreationRequest extends Error {
  constructor(readonly record: ReceivingCode) {
    super('收款码创建请求已处理')
  }
}

function requestFilter(createRequestId: string) {
  return { createRequestId } as Filter<ReceivingCode>
}

function duplicateKey(error: unknown) {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
}

export async function createReceivingCodeOnce(input: CreationInput, dependencies: CreationDependencies) {
  const createRequestId = input.createRequestId.trim()
  if (!createRequestId) throw new Error('缺少收款码创建请求标识')

  const existing = await dependencies.receivingCodes.findOne(requestFilter(createRequestId))
  if (existing) return { record: existing, created: false }

  const recordId = dependencies.idFactory()
  const commit = async (imageAssetId: string | undefined, session: ClientSession) => {
    const repeated = await dependencies.receivingCodes.findOne(requestFilter(createRequestId), session)
    if (repeated) throw new ExistingCreationRequest(repeated)
    const record: ReceivingCode = {
      id: recordId,
      createRequestId,
      subject: input.subject,
      accountNote: input.accountNote,
      codeName: input.codeName,
      status: '启用',
      updatedBy: input.operator,
      updatedAt: dependencies.now(),
      imageAssetId,
      imageName: input.image?.fileName
    }
    await dependencies.receivingCodes.insert(record, session)
    await dependencies.auditLogs.insert({
      id: dependencies.auditIdFactory(),
      time: dependencies.now(),
      actor: input.operator,
      role: input.role,
      action: '创建收款码',
      target: record.id,
      before: null,
      after: record,
      result: '成功'
    }, session)
    return record
  }

  try {
    const record = input.image
      ? await dependencies.files.uploadAndBind({
          ...input.image,
          purpose: 'receiving-code',
          ownerType: 'receiving-code',
          ownerId: recordId,
          createdBy: input.operator.split(' · ')[0] || input.operator
        }, (asset, session) => commit(asset.id, session))
      : await dependencies.mongo.withTransaction(session => commit(undefined, session))
    return { record, created: true }
  } catch (error) {
    if (error instanceof ExistingCreationRequest) return { record: error.record, created: false }
    if (duplicateKey(error)) {
      const repeated = await dependencies.receivingCodes.findOne(requestFilter(createRequestId))
      if (repeated) return { record: repeated, created: false }
    }
    throw error
  }
}
