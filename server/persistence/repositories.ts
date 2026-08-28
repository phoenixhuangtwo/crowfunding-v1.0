import type { ClientSession, Db, Filter, Sort } from 'mongodb'
import type {
  AuditLog,
  FileAsset,
  Project,
  ReceivingCode,
  RiskEvent,
  Subscription,
  SubscriptionRule
} from '../domain/models.ts'
import { collectionName } from './schema.ts'

export interface EntityRepository<T extends { id: string }> {
  list(filter?: Filter<T>, options?: { sort?: Sort; limit?: number }, session?: ClientSession): Promise<T[]>
  findOne(filter: Filter<T>, session?: ClientSession): Promise<T | null>
  getById(id: string, session?: ClientSession): Promise<T | null>
  insert(document: T, session?: ClientSession): Promise<void>
  replace(document: T, session?: ClientSession): Promise<void>
  deleteById(id: string, session?: ClientSession): Promise<boolean>
  count(filter?: Filter<T>, session?: ClientSession): Promise<number>
}

export type AppRepositories = {
  projects: EntityRepository<Project>
  subscriptions: EntityRepository<Subscription>
  rules: EntityRepository<SubscriptionRule>
  receivingCodes: EntityRepository<ReceivingCode>
  auditLogs: EntityRepository<AuditLog>
  riskEvents: EntityRepository<RiskEvent>
  fileAssets: EntityRepository<FileAsset>
}

export function entitiesDiffer(left: unknown, right: unknown) {
  return JSON.stringify(left) !== JSON.stringify(right)
}

function withoutMongoId<T>(document: Record<string, unknown>): T {
  const { _id: _unused, ...entity } = document
  return entity as T
}

function createEntityRepository<T extends { id: string }>(db: Db, name: string): EntityRepository<T> {
  const collection = db.collection<T>(name)
  return {
    async list(filter = {}, options = {}, session) {
      let cursor = collection.find(filter, { session })
      if (options.sort) cursor = cursor.sort(options.sort)
      if (options.limit !== undefined) cursor = cursor.limit(options.limit)
      return (await cursor.toArray()).map(document => withoutMongoId<T>(document as unknown as Record<string, unknown>))
    },
    async findOne(filter, session) {
      const document = await collection.findOne(filter, { session })
      return document ? withoutMongoId<T>(document as unknown as Record<string, unknown>) : null
    },
    getById(id, session) {
      return this.findOne({ id } as Filter<T>, session)
    },
    async insert(document, session) {
      await collection.insertOne(document as never, { session })
    },
    async replace(document, session) {
      const result = await collection.replaceOne({ id: document.id } as Filter<T>, document, { session, upsert: false })
      if (result.matchedCount !== 1) throw new Error(`记录不存在：${document.id}`)
    },
    async deleteById(id, session) {
      const result = await collection.deleteOne({ id } as Filter<T>, { session })
      return result.deletedCount === 1
    },
    count(filter = {}, session) {
      return collection.countDocuments(filter, { session })
    }
  }
}

export function createRepositories(db: Db, prefix = ''): AppRepositories {
  return {
    projects: createEntityRepository(db, collectionName('projects', prefix)),
    subscriptions: createEntityRepository(db, collectionName('subscriptions', prefix)),
    rules: createEntityRepository(db, collectionName('subscription_rules', prefix)),
    receivingCodes: createEntityRepository(db, collectionName('receiving_codes', prefix)),
    auditLogs: createEntityRepository(db, collectionName('audit_logs', prefix)),
    riskEvents: createEntityRepository(db, collectionName('risk_events', prefix)),
    fileAssets: createEntityRepository(db, collectionName('file_assets', prefix))
  }
}
