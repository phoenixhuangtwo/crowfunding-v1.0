import { randomUUID } from 'node:crypto'
import type { ClientSession, Db } from 'mongodb'

export type AgreementNode = '提交认购' | '查看缴款码' | '确认收款'
export type AgreementVersion = {
  id: string
  version: number
  title: string
  body: string
  effectiveAt: string
  createdBy: string
}
export type AgreementConfirmation = {
  id: string
  version: number
  userId: string
  userName: string
  node: AgreementNode
  relatedId: string
  codeId?: string
  confirmedAt: string
}

export class AgreementError extends Error {
  constructor(readonly status: 400 | 409, readonly code: string, message: string) {
    super(message)
  }
}

export function validateAgreement(title: unknown, body: unknown) {
  if (typeof title !== 'string' || !title.trim()) throw new AgreementError(400, 'AGREEMENT_TITLE_REQUIRED', '请填写协议标题')
  if (typeof body !== 'string' || !body.trim()) throw new AgreementError(400, 'AGREEMENT_BODY_REQUIRED', '请填写协议正文')
  const cleanTitle = title.trim()
  const cleanBody = body.trim()
  if ([...cleanTitle].length < 2 || [...cleanTitle].length > 50) throw new AgreementError(400, 'AGREEMENT_TITLE_INVALID', '协议标题为2-50字')
  if ([...cleanBody].length < 50 || [...cleanBody].length > 5000) throw new AgreementError(400, 'AGREEMENT_BODY_INVALID', '协议正文为50-5000字')
  return { title: cleanTitle, body: cleanBody }
}

export class AgreementService {
  private versions
  private confirmations

  constructor(db: Db, prefix = '') {
    this.versions = db.collection<AgreementVersion>(`${prefix}agreement_versions`)
    this.confirmations = db.collection<AgreementConfirmation>(`${prefix}agreement_confirmations`)
  }

  async ensureIndexes() {
    await this.versions.createIndex({ version: 1 }, { unique: true, name: 'uniq_agreement_version' })
    await this.versions.createIndex({ id: 1 }, { unique: true, name: 'uniq_agreement_id' })
    await this.confirmations.createIndex({ id: 1 }, { unique: true, name: 'uniq_agreement_confirmation_id' })
    await this.confirmations.createIndex({ version: 1, confirmedAt: -1 }, { name: 'idx_agreement_confirmations_version_time' })
    await this.confirmations.createIndex({ userId: 1, node: 1, confirmedAt: -1 }, { name: 'idx_agreement_confirmations_user_node_time' })
  }

  async current(session?: ClientSession) {
    return this.versions.findOne({}, { sort: { version: -1 }, session })
  }

  async list(page = 1, pageSize = 10) {
    const total = await this.versions.countDocuments()
    const items = await this.versions.find({}, { sort: { version: -1 }, skip: (page - 1) * pageSize, limit: pageSize }).toArray()
    return { items, total, page, pageSize }
  }

  async create(input: { title: unknown; body: unknown; createdBy: string }) {
    const fields = validateAgreement(input.title, input.body)
    const current = await this.current()
    const document: AgreementVersion = {
      id: randomUUID(), version: (current?.version ?? 0) + 1, ...fields,
      effectiveAt: new Date().toISOString(), createdBy: input.createdBy
    }
    try {
      await this.versions.insertOne(document)
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
        throw new AgreementError(409, 'AGREEMENT_VERSION_CONFLICT', '协议版本已变化，请刷新后重试')
      }
      throw error
    }
    return document
  }

  async requireCurrent(version: unknown, session?: ClientSession) {
    const current = await this.current(session)
    if (!current) throw new AgreementError(409, 'AGREEMENT_NOT_CONFIGURED', '协议尚未配置，请联系公司')
    if (!Number.isSafeInteger(version) || version !== current.version) {
      throw new AgreementError(409, 'AGREEMENT_VERSION_CHANGED', '协议版本已更新，请重新阅读并确认')
    }
    return current
  }

  async confirm(input: Omit<AgreementConfirmation, 'id' | 'confirmedAt'>, session?: ClientSession) {
    const record: AgreementConfirmation = { id: randomUUID(), ...input, confirmedAt: new Date().toISOString() }
    await this.confirmations.insertOne(record, { session })
    return record
  }

  async listConfirmations(version: number, page = 1, pageSize = 10, filters: { userId?: string; node?: AgreementNode; from?: string; to?: string } = {}) {
    const query = {
      version,
      ...(filters.userId ? { userId: filters.userId } : {}),
      ...(filters.node ? { node: filters.node } : {}),
      ...(filters.from || filters.to ? { confirmedAt: { ...(filters.from ? { $gte: filters.from } : {}), ...(filters.to ? { $lte: filters.to } : {}) } } : {})
    }
    const total = await this.confirmations.countDocuments(query)
    const items = await this.confirmations.find(query, { sort: { confirmedAt: -1 }, skip: (page - 1) * pageSize, limit: pageSize }).toArray()
    return { items, total, page, pageSize }
  }

  async hasRecentCodeConfirmation(userId: string, codeId: string, version: number, after: Date) {
    return (await this.confirmations.countDocuments({
      userId, codeId, version, node: '查看缴款码', confirmedAt: { $gte: after.toISOString() }
    }, { limit: 1 })) > 0
  }
}
