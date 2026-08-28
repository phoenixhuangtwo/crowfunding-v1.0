import type { Db, IndexDescriptionInfo } from 'mongodb'

export const businessCollections = [
  'projects',
  'subscriptions',
  'subscription_rules',
  'receiving_codes',
  'audit_logs',
  'risk_events',
  'file_assets'
] as const

export type BusinessCollection = (typeof businessCollections)[number]

export type PlannedIndex = {
  name: string
  key: Record<string, 1 | -1>
  unique?: boolean
  partialFilterExpression?: Record<string, unknown>
}

export const legacyImageFields: Record<BusinessCollection, readonly string[]> = {
  projects: ['settlementInvoices.imageUrl'],
  subscriptions: ['paymentImageUrl', 'paymentImages.paymentImageUrl'],
  subscription_rules: [],
  receiving_codes: ['imageUrl'],
  audit_logs: [],
  risk_events: [],
  file_assets: []
}

export const indexDefinitions: Record<BusinessCollection, readonly PlannedIndex[]> = {
  projects: [
    { name: 'uniq_projects_id', key: { id: 1 }, unique: true },
    { name: 'idx_projects_status', key: { status: 1 } },
    { name: 'idx_projects_deadline', key: { deadline: 1 } },
    { name: 'idx_projects_rule_id', key: { ruleId: 1 } }
  ],
  subscriptions: [
    { name: 'uniq_subscriptions_id', key: { id: 1 }, unique: true },
    {
      name: 'uniq_subscriptions_idempotency_key',
      key: { idempotencyKey: 1 },
      unique: true,
      partialFilterExpression: { idempotencyKey: { $gt: '' } }
    },
    { name: 'idx_subscriptions_project_user', key: { projectId: 1, userId: 1 } },
    { name: 'idx_subscriptions_status', key: { pay: 1 } }
  ],
  subscription_rules: [
    { name: 'uniq_subscription_rules_id', key: { id: 1 }, unique: true },
    { name: 'idx_subscription_rules_project_id', key: { projectId: 1 } },
    { name: 'idx_subscription_rules_status', key: { status: 1 } }
  ],
  receiving_codes: [
    { name: 'uniq_receiving_codes_id', key: { id: 1 }, unique: true },
    {
      name: 'uniq_receiving_codes_create_request_id',
      key: { createRequestId: 1 },
      unique: true,
      partialFilterExpression: { createRequestId: { $gt: '' } }
    },
    { name: 'idx_receiving_codes_status', key: { status: 1 } }
  ],
  audit_logs: [
    { name: 'uniq_audit_logs_id', key: { id: 1 }, unique: true },
    { name: 'idx_audit_logs_time', key: { time: -1 } },
    { name: 'idx_audit_logs_target', key: { target: 1 } }
  ],
  risk_events: [
    { name: 'uniq_risk_events_id', key: { id: 1 }, unique: true },
    { name: 'idx_risk_events_project_status', key: { projectId: 1, status: 1 } },
    { name: 'idx_risk_events_time', key: { time: -1 } }
  ],
  file_assets: [
    { name: 'uniq_file_assets_id', key: { id: 1 }, unique: true },
    { name: 'uniq_file_assets_object_key', key: { objectKey: 1 }, unique: true },
    { name: 'idx_file_assets_owner', key: { ownerType: 1, ownerId: 1 } },
    { name: 'idx_file_assets_status', key: { status: 1 } }
  ]
}

export type SchemaConflict = {
  collection: string
  kind: 'duplicate-id' | 'duplicate-idempotency-key' | 'legacy-image-field' | 'index-conflict'
  detail: string
}

export class SchemaConflictError extends Error {
  constructor(readonly conflicts: SchemaConflict[]) {
    super(`MongoDB 结构预检发现 ${conflicts.length} 个冲突，未执行任何结构变更`)
    this.name = 'SchemaConflictError'
  }
}

export function collectionName(base: BusinessCollection, prefix = '') {
  return `${prefix}${base}`
}

export function transactionCapabilityError(hello: Record<string, unknown>) {
  if (typeof hello.setName === 'string' || hello.msg === 'isdbgrid') return null
  return 'MongoDB 部署不支持事务：需要副本集或分片集群'
}

function sameIndexDefinition(existing: IndexDescriptionInfo, expected: PlannedIndex) {
  return JSON.stringify(existing.key) === JSON.stringify(expected.key) &&
    Boolean(existing.unique) === Boolean(expected.unique) &&
    JSON.stringify(existing.partialFilterExpression ?? null) === JSON.stringify(expected.partialFilterExpression ?? null)
}

export async function inspectSchema(db: Db, prefix = ''): Promise<SchemaConflict[]> {
  const conflicts: SchemaConflict[] = []
  const existingNames = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name))

  for (const base of businessCollections) {
    const name = collectionName(base, prefix)
    if (!existingNames.has(name)) continue
    const collection = db.collection(name)

    for (const field of legacyImageFields[base]) {
      const count = await collection.countDocuments({ [field]: { $exists: true } }, { limit: 1 })
      if (count > 0) conflicts.push({ collection: name, kind: 'legacy-image-field', detail: field })
    }

    for (const definition of indexDefinitions[base].filter(item => item.unique)) {
      const field = Object.keys(definition.key)[0]
      const duplicate = await collection.aggregate([
        { $match: definition.partialFilterExpression ?? { [field]: { $exists: true } } },
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 1 }
      ]).next()
      if (duplicate) {
        conflicts.push({
          collection: name,
          kind: field === 'id' ? 'duplicate-id' : 'duplicate-idempotency-key',
          detail: field
        })
      }
    }

    const existingIndexes = await collection.listIndexes().toArray()
    for (const definition of indexDefinitions[base]) {
      const named = existingIndexes.find(item => item.name === definition.name)
      if (named && !sameIndexDefinition(named, definition)) {
        conflicts.push({ collection: name, kind: 'index-conflict', detail: definition.name })
      }
    }
  }
  return conflicts
}

export async function ensureSchema(db: Db, prefix = '') {
  const conflicts = await inspectSchema(db, prefix)
  if (conflicts.length > 0) throw new SchemaConflictError(conflicts)

  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name))
  for (const base of businessCollections) {
    const name = collectionName(base, prefix)
    if (!existing.has(name)) await db.createCollection(name)
    for (const definition of indexDefinitions[base]) {
      await db.collection(name).createIndex(definition.key, {
        name: definition.name,
        ...(definition.unique === undefined ? {} : { unique: definition.unique }),
        ...(definition.partialFilterExpression
          ? { partialFilterExpression: definition.partialFilterExpression }
          : {})
      })
    }
  }
}
