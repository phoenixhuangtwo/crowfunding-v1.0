# MongoDB and Tencent COS Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `data/dev-state.json` and persisted Base64 images with MongoDB database `crowfunding` and a private Tencent COS bucket while preserving all existing remote database content.

**Architecture:** The API starts only after a non-destructive MongoDB preflight succeeds, then reads and writes typed collections through repositories and transaction-aware domain services. Image bytes enter through bounded multipart endpoints, are validated and uploaded by the backend to private COS, and are referenced from business documents only by internal `assetId`; cross-system failures use explicit file-asset states, request-scoped compensation, and a manual-only reconciliation command.

**Tech Stack:** Node.js 26, TypeScript 5.6, Vue 3, native MongoDB Node.js driver 7.x, `cos-nodejs-sdk-v5` 3.x, Busboy 1.x, Node `crypto`, Node `test`, Vite 6.

**Spec:** `docs/superpowers/specs/2026-08-28-mongodb-cos-persistence-design.md`

## Global Constraints

- The MongoDB database name is exactly `crowfunding`; never correct or rename that spelling.
- Preserve every existing MongoDB database, collection, document, and COS object unless a request names one exact new test asset or one exact user-selected asset.
- Do not import, read at runtime, write, truncate, or delete `data/dev-state.json`.
- Do not seed runtime Mock, demo, or fixture business data; an empty MongoDB collection returns an empty array.
- Business documents store only `assetId`; Base64, COS object keys, COS URLs, and signed URLs never persist in a business collection.
- COS remains private; the backend receives uploads and proxies authorized reads. The browser never receives COS credentials.
- Do not add timers, cron jobs, TTL deletion indexes, background sweepers, or automatic periodic cleanup.
- Reconciliation defaults to dry-run; `--apply` requires one exact asset ID and rechecks current references before deleting anything.
- MongoDB must support multi-document transactions. Preflight failure prevents the API from listening.
- `.env.local` remains ignored. Secrets must not appear in Git, frontend bundles, JSON responses, logs, snapshots, or test output.
- The current application has demo roles rather than a production identity provider. This plan adds a narrow request-context boundary for file authorization but does not claim to deliver production authentication or IAM.
- Unit tests may use dependency fakes; runtime and acceptance data must come from the real MongoDB/COS services, never from a fallback fixture.

## Official References

- MongoDB Node driver: `https://www.mongodb.com/docs/drivers/node/current/`
- MongoDB transactions: `https://www.mongodb.com/docs/drivers/node/current/crud/transactions/`
- Tencent COS Node SDK: `https://github.com/tencentyun/cos-nodejs-sdk-v5`
- Tencent COS object APIs: `https://cloud.tencent.com/document/product/436/64958`

## File Structure

### New runtime files

- `server/config.ts` — validate and return all MongoDB/COS settings without exposing secret values.
- `server/domain/models.ts` — canonical business and file-asset types shared by services and repositories.
- `server/errors.ts` — stable HTTP/application errors, required-record checks, and duplicate-key detection.
- `server/request-context.ts` — validate the current test-environment user/role context for private file access.
- `server/http-multipart.ts` — bounded single-image multipart parsing.
- `server/image-file.ts` — extension, MIME, magic-byte, size, and SHA-256 validation.
- `server/persistence/mongo.ts` — MongoDB connection, transaction helper, shutdown, and readiness state.
- `server/persistence/schema.ts` — collection names, index definitions, read-only conflict checks, and non-destructive index creation.
- `server/persistence/repositories.ts` — typed repositories and the `AppRepositories` aggregate.
- `server/services/query-service.ts` — all list/detail reads and response-only file URLs.
- `server/services/subscription-service.ts` — subscription creation and idempotent project amount updates.
- `server/services/rule-service.ts` — rule create/update/status/delete transactions.
- `server/services/project-service.ts` — open, terminate, interrupt, and takeover transactions.
- `server/services/receiving-code-service.ts` — receiving-code metadata and image binding.
- `server/services/payment-service.ts` — payment upload/OCR/review and payment-image deletion.
- `server/services/settlement-service.ts` — invoice OCR proof and cumulative settlement transactions.
- `server/services/procurement-sync-service.ts` — procurement merge and audit transaction.
- `server/storage/object-storage.ts` — storage interface and production Tencent COS adapter.
- `server/storage/file-asset-service.ts` — file asset state machine and request-scoped compensation.
- `server/storage/reconcile.ts` — dry-run reconciliation and one-asset explicit apply operation.
- `scripts/storage-preflight.ts` — read-only schema/transaction/COS configuration report.
- `scripts/storage-reconcile.ts` — CLI wrapper for manual reconciliation.
- `src/file-upload.ts` — frontend FormData and private file URL helpers.
- `.env.example` — secret-free required configuration names.

### New tests and test support

- `tests/config.test.ts`
- `tests/mongodb-schema.test.ts`
- `tests/mongodb-repositories.test.ts`
- `tests/no-json-persistence.test.ts`
- `tests/http-multipart.test.ts`
- `tests/image-file.test.ts`
- `tests/file-asset-service.test.ts`
- `tests/receiving-code-service.test.ts`
- `tests/payment-storage.test.ts`
- `tests/settlement-storage.test.ts`
- `tests/file-access.test.ts`
- `tests/storage-reconcile.test.ts`
- `tests/frontend-file-upload.test.ts`
- `tests/live-storage-integration.mjs`
- `tests/helpers/fake-object-storage.ts`
- `tests/helpers/mongo-test-scope.ts`
- `tests/fixtures/storage-smoke-state.ts`

### Existing files to modify

- `package.json`, `package-lock.json` — dependencies and storage test/preflight scripts.
- `server/server.ts` — async bootstrap and dependency-injected routes; remove JSON state and seed state.
- `server/project-settlement.ts` — replace invoice `imageUrl` with `assetId`.
- `server/ocr-proof.ts` — bind proof to raw image digest and asset ID rather than a Data URL.
- `server/resource-limits.ts` — byte-based COS quota checks rather than Base64 character totals.
- `src/App.vue` — multipart uploads, asset IDs, private backend image URLs, and real empty states.
- `tests/project-settlement-confirmation.test.ts` — assert asset binding.
- `tests/security-boundaries.test.ts` — raw-byte digest and asset ownership attacks.
- `tests/smoke.mjs` — isolated MongoDB/COS smoke run with no JSON backup/restore.
- `tests/mine-demo-subscriptions.test.ts` — remove runtime seed expectations and assert real empty-state behavior.
- `scripts/local-processes.sh` — surface startup/preflight failures without secret output.
- `docs/04-设计/HLD-概要设计.md`, `docs/04-设计/LLD-详细设计.md`, `docs/08-落地实施文档.md`, and `docs/06-操作手册/全项目操作使用说明.md` — replace JSON/GridFS descriptions with the verified MongoDB/COS runtime contract.

---

### Task 1: Configuration, Dependencies, and Canonical Domain Models

**Files:**
- Create: `.env.example`
- Create: `server/config.ts`
- Create: `server/domain/models.ts`
- Create: `server/errors.ts`
- Create: `tests/config.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `server/project-settlement.ts`

**Interfaces:**
- Consumes: `process.env` and the domain fields currently declared in `server/server.ts`.
- Produces: `loadAppConfig(env): AppConfig`, `AppError`, `appError`, `required`, `Actor`, `RequestContext`, `FileAsset`, `PaymentImage.assetId`, `SettlementInvoiceRecord.assetId`, and `ReceivingCode.imageAssetId`.

- [ ] **Step 1: Write failing configuration tests**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadAppConfig } from '../server/config.ts'

const valid = {
  MONGODB_URI: 'mongodb://example.invalid:27017/?replicaSet=rs0',
  MONGODB_DB: 'crowfunding',
  COS_SECRET_ID: 'configured-secret-id',
  COS_SECRET_KEY: 'configured-secret-key',
  COS_BUCKET: 'private-bucket-1250000000',
  COS_REGION: 'ap-guangzhou',
  COS_OBJECT_PREFIX: 'crowfunding'
}

test('configuration requires the exact crowfunding database', () => {
  assert.equal(loadAppConfig(valid).mongodb.database, 'crowfunding')
  assert.throws(() => loadAppConfig({ ...valid, MONGODB_DB: 'crowdfunding' }), /MONGODB_DB 必须为 crowfunding/)
})

test('configuration reports missing names without exposing values', () => {
  assert.throws(() => loadAppConfig({ ...valid, COS_SECRET_KEY: '' }), error => {
    assert.match(String(error), /COS_SECRET_KEY/)
    assert.doesNotMatch(String(error), /configured-secret/)
    return true
  })
})
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `npx tsx --test tests/config.test.ts`
Expected: FAIL with `Cannot find module '../server/config.ts'`.

- [ ] **Step 3: Install bounded production dependencies**

Run:

```bash
npm install mongodb@^7 cos-nodejs-sdk-v5@^3 busboy@^1
npm install --save-dev @types/busboy@^1
```

Expected: `package.json` records MongoDB 7.x, COS SDK 3.x, Busboy 1.x, and the matching Busboy type package; `npm audit` output is reviewed before continuing.

- [ ] **Step 4: Implement strict configuration parsing**

```ts
export type AppConfig = {
  mongodb: { uri: string; database: 'crowfunding'; collectionPrefix: string }
  cos: { secretId: string; secretKey: string; bucket: string; region: string; objectPrefix: string }
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`缺少服务端配置 ${name}`)
  return value
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const database = required(env, 'MONGODB_DB')
  if (database !== 'crowfunding') throw new Error('MONGODB_DB 必须为 crowfunding')
  const collectionPrefix = env.MONGODB_COLLECTION_PREFIX?.trim() ?? ''
  if (collectionPrefix && env.NODE_ENV !== 'test') throw new Error('仅测试环境允许 MONGODB_COLLECTION_PREFIX')
  if (collectionPrefix && !/^__test_[a-z0-9_]+_$/.test(collectionPrefix)) {
    throw new Error('MONGODB_COLLECTION_PREFIX 不是安全测试前缀')
  }
  return {
    mongodb: {
      uri: required(env, 'MONGODB_URI'),
      database,
      collectionPrefix
    },
    cos: {
      secretId: required(env, 'COS_SECRET_ID'),
      secretKey: required(env, 'COS_SECRET_KEY'),
      bucket: required(env, 'COS_BUCKET'),
      region: required(env, 'COS_REGION'),
      objectPrefix: required(env, 'COS_OBJECT_PREFIX').replace(/^\/+|\/+$/g, '')
    }
  }
}
```

- [ ] **Step 5: Extract canonical domain types and remove persisted image URLs**

```ts
export type PaymentImage = {
  id: string
  assetId: string
  paymentImageName: string
  recognizedAmount: number
  uploadedAt: string
  status: '已识别' | '识别失败'
}

export type Actor = { userId: string; label: string; role: 'employee' | 'admin' | 'finance' | 'super_admin' | 'system' }
export type RequestContext = Pick<Actor, 'userId' | 'role'>

export type FileAsset = {
  id: string
  provider: 'tencent-cos'
  bucket: string
  region: string
  objectKey: string
  originalName: string
  extension: string
  mimeType: string
  sizeBytes: number
  sha256: string
  purpose: 'receiving-code' | 'payment-proof' | 'settlement-invoice'
  ownerType: 'receiving-code' | 'subscription' | 'project'
  ownerId: string
  status: 'pending' | 'ready' | 'failed' | 'pending_delete'
  createdBy: string
  createdAt: string
  updatedAt: string
  lastError?: string
}
```

Update `SettlementInvoiceRecord` to use `assetId: string` and `ReceivingCode` to use `imageAssetId?: string`. Add stable `id` fields to new `AuditLog` and `RiskEvent` records so their unique indexes have a defined value, and add optional `projectId` to `RiskEvent` for project-scoped querying.

Create the shared error boundary:

```ts
export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
export const appError = (status: number, code: string, message: string) => new AppError(status, code, message)
export async function required<T>(value: Promise<T | null>, code: string): Promise<T> {
  const resolved = await value
  if (!resolved) throw appError(404, code, '记录不存在')
  return resolved
}
export const isDuplicateKey = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 11000
```

- [ ] **Step 6: Add a secret-free environment template**

```dotenv
MONGODB_URI=
MONGODB_DB=crowfunding
MONGODB_COLLECTION_PREFIX=
COS_SECRET_ID=
COS_SECRET_KEY=
COS_BUCKET=
COS_REGION=
COS_OBJECT_PREFIX=crowfunding
```

- [ ] **Step 7: Run focused tests and typecheck**

Run: `npx tsx --test tests/config.test.ts && npx vue-tsc -b --pretty false`
Expected: PASS; no type contains persisted `imageUrl` or `paymentImageUrl`.

- [ ] **Step 8: Commit the configuration and model boundary**

```bash
git add .env.example package.json package-lock.json server/config.ts server/domain/models.ts server/errors.ts server/project-settlement.ts tests/config.test.ts
git commit -m "refactor: define MongoDB and COS domain contracts"
```

### Task 2: MongoDB Connection, Transaction Capability, and Non-Destructive Schema Preflight

**Files:**
- Create: `server/persistence/mongo.ts`
- Create: `server/persistence/schema.ts`
- Create: `scripts/storage-preflight.ts`
- Create: `tests/mongodb-schema.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `AppConfig['mongodb']`, MongoDB `MongoClient`, and canonical domain model collection names.
- Produces: `connectMongo(config): Promise<MongoContext>`, `inspectSchema(db, prefix): Promise<SchemaConflict[]>`, `ensureSchema(db, prefix): Promise<void>`, and `withTransaction(work): Promise<T>`.

- [ ] **Step 1: Write failing pure schema tests**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { collectionName, indexDefinitions, transactionCapabilityError } from '../server/persistence/schema.ts'

test('production collection names are exact and unprefixed', () => {
  assert.equal(collectionName('projects', ''), 'projects')
  assert.equal(collectionName('file_assets', '__test_run_'), '__test_run_file_assets')
})

test('subscription idempotency uses a non-empty partial unique index', () => {
  const index = indexDefinitions.subscriptions.find(item => item.name === 'uniq_subscriptions_idempotency_key')
  assert.deepEqual(index?.partialFilterExpression, { idempotencyKey: { $gt: '' } })
  assert.equal(index?.unique, true)
})

test('transactions require a replica set or mongos', () => {
  assert.match(transactionCapabilityError({ isWritablePrimary: true }), /事务/)
  assert.equal(transactionCapabilityError({ setName: 'rs0', isWritablePrimary: true }), null)
  assert.equal(transactionCapabilityError({ msg: 'isdbgrid', isWritablePrimary: true }), null)
})
```

- [ ] **Step 2: Run the schema test and verify it fails**

Run: `npx tsx --test tests/mongodb-schema.test.ts`
Expected: FAIL because `server/persistence/schema.ts` does not exist.

- [ ] **Step 3: Define exact collection and index specifications**

```ts
export const businessCollections = [
  'projects', 'subscriptions', 'subscription_rules', 'receiving_codes',
  'audit_logs', 'risk_events', 'file_assets'
] as const

export type PlannedIndex = {
  name: string
  key: Record<string, 1 | -1>
  unique?: boolean
  partialFilterExpression?: Record<string, unknown>
}

export const legacyImageFields: Record<(typeof businessCollections)[number], readonly string[]> = {
  projects: ['settlementInvoices.imageUrl'],
  subscriptions: ['paymentImageUrl', 'paymentImages.paymentImageUrl'],
  subscription_rules: [],
  receiving_codes: ['imageUrl'],
  audit_logs: [],
  risk_events: [],
  file_assets: []
}

export const indexDefinitions = {
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
} as const
```

Do not define TTL indexes.

- [ ] **Step 4: Implement read-only conflict inspection before mutations**

```ts
export type SchemaConflict = {
  collection: string
  kind: 'duplicate-id' | 'duplicate-idempotency-key' | 'legacy-image-field' | 'index-conflict'
  detail: string
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
      if (count) conflicts.push({ collection: name, kind: 'legacy-image-field', detail: field })
    }
    for (const definition of indexDefinitions[base].filter(item => item.unique)) {
      const field = Object.keys(definition.key)[0]
      const duplicate = await collection.aggregate([
        { $match: definition.partialFilterExpression ?? { [field]: { $exists: true } } },
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 1 }
      ]).next()
      if (duplicate) conflicts.push({ collection: name, kind: field === 'id' ? 'duplicate-id' : 'duplicate-idempotency-key', detail: field })
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

const sameIndexDefinition = (existing: IndexDescriptionInfo, expected: PlannedIndex) =>
  JSON.stringify(existing.key) === JSON.stringify(expected.key) &&
  Boolean(existing.unique) === Boolean(expected.unique) &&
  JSON.stringify(existing.partialFilterExpression ?? null) === JSON.stringify(expected.partialFilterExpression ?? null)
```

The concrete implementation must probe `imageUrl`, `paymentImageUrl`, and embedded Base64 fields in owned collections and report counts without returning the image data.

- [ ] **Step 5: Implement connection and transaction checks**

```ts
export type MongoContext = {
  client: MongoClient
  db: Db
  withTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export async function connectMongo(config: AppConfig['mongodb']): Promise<MongoContext> {
  const client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 5_000, retryWrites: true })
  await client.connect()
  const db = client.db(config.database)
  const hello = await db.command({ hello: 1 })
  const error = transactionCapabilityError(hello)
  if (error) { await client.close(); throw new Error(error) }
  return createMongoContext(client, db)
}
```

Use `session.withTransaction()` with primary read preference and majority write concern. Never run parallel operations inside one transaction callback.

- [ ] **Step 6: Implement non-destructive schema creation**

`ensureSchema()` must call `inspectSchema()` first, throw when any conflict exists, then create only missing collections/indexes. It must never call `dropDatabase`, `drop`, `deleteMany`, `replaceOne` on existing records, or `dropIndex`.

```ts
export async function ensureSchema(db: Db, prefix = '') {
  const conflicts = await inspectSchema(db, prefix)
  if (conflicts.length) throw new SchemaConflictError(conflicts)
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name))
  for (const base of businessCollections) {
    const name = collectionName(base, prefix)
    if (!existing.has(name)) await db.createCollection(name)
    for (const definition of indexDefinitions[base]) {
      await db.collection(name).createIndex(definition.key, definition)
    }
  }
}
```

- [ ] **Step 7: Add the read-only preflight CLI and script**

```json
{
  "scripts": {
    "storage:preflight": "node --env-file-if-exists=.env.local --import tsx scripts/storage-preflight.ts"
  }
}
```

The CLI prints only database name, transaction support, collection names, conflict counts, and COS configuration names. It must redact URI hosts, usernames, passwords, SecretId, and SecretKey.

- [ ] **Step 8: Run focused tests**

Run: `npx tsx --test tests/mongodb-schema.test.ts tests/config.test.ts`
Expected: PASS and no database connection occurs during unit tests.

- [ ] **Step 9: Commit MongoDB preflight**

```bash
git add package.json package-lock.json server/persistence/mongo.ts server/persistence/schema.ts scripts/storage-preflight.ts tests/mongodb-schema.test.ts
git commit -m "feat: add non-destructive MongoDB preflight"
```

### Task 3: Typed Repositories and Real Empty-State Queries

**Files:**
- Create: `server/persistence/repositories.ts`
- Create: `server/services/query-service.ts`
- Create: `tests/mongodb-repositories.test.ts`
- Create: `tests/no-json-persistence.test.ts`
- Modify: `server/server.ts`
- Modify: `tests/mine-demo-subscriptions.test.ts`

**Interfaces:**
- Consumes: `MongoContext.db`, canonical domain types, optional `ClientSession`, and collection prefix.
- Produces: `createRepositories(db, prefix): AppRepositories`, `QueryService`, and an API bootstrap that has no JSON state or seed state.

- [ ] **Step 1: Write failing repository contract tests**

```ts
test('empty repositories return empty arrays without seed fallback', async () => {
  const repos = createFakeRepositories()
  const queries = new QueryService(repos)
  assert.deepEqual(await queries.listProjects(), [])
  assert.deepEqual(await queries.listSubscriptions(), [])
})

test('response file URLs are derived from asset IDs only', () => {
  assert.deepEqual(presentReceivingCode({ id: 'RCV-1', imageAssetId: 'asset-1' }), {
    id: 'RCV-1', imageAssetId: 'asset-1', imageUrl: '/api/files/asset-1/content'
  })
})
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npx tsx --test tests/mongodb-repositories.test.ts tests/no-json-persistence.test.ts`
Expected: FAIL because repositories and query service do not exist.

- [ ] **Step 3: Implement repository interfaces**

```ts
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
```

The Mongo implementation must strip `_id` on reads and never use `upsert: true` for updates to an existing business ID.

- [ ] **Step 4: Implement query service filters in MongoDB**

`QueryService` must provide exact methods for `/api/projects`, `/api/subscriptions`, `/api/rules`, `/api/receiving-codes`, `/api/audit-logs`, `/api/risk-events`, and `/api/state`. `/api/state` assembles a fresh response from MongoDB for diagnostics; it does not cache or persist a snapshot.

```ts
export class QueryService {
  constructor(private readonly repos: AppRepositories) {}
  listProjects() { return this.repos.projects.list({}, { sort: { deadline: 1, id: 1 } }) }
  listSubscriptions() { return this.repos.subscriptions.list({}, { sort: { createdAt: -1, id: -1 } }) }
  listReceivingCodes() { return this.repos.receivingCodes.list({}, { sort: { updatedAt: -1, id: 1 } }) }
  async state() {
    const [projects, subscriptions, rules, receivingCodes, auditLogs, riskEvents] = await Promise.all([
      this.listProjects(), this.listSubscriptions(), this.repos.rules.list(), this.listReceivingCodes(),
      this.repos.auditLogs.list({}, { sort: { time: -1 } }), this.repos.riskEvents.list({}, { sort: { time: -1 } })
    ])
    return { projects, subscriptions, rules, receivingCodes, auditLogs, riskEvents }
  }
}
```

- [ ] **Step 5: Refactor API bootstrap to inject dependencies**

```ts
export type AppDependencies = {
  mongo: MongoContext
  repositories: AppRepositories
  queries: QueryService
  config: AppConfig
}

export function createRequestHandler(deps: AppDependencies) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    // Route with dependency-injected services and centralized error mapping.
  }
}
```

`server/server.ts` loads config, connects MongoDB, runs `ensureSchema`, creates dependencies, then listens. Remove `statePath`, `seedState`, every Mock seed array, `loadState()`, `saveState()`, module-level business arrays, and `mkdirSync/readFileSync/writeFileSync` imports.

- [ ] **Step 6: Replace demo-seed tests with empty-state tests**

```ts
test('empty MongoDB state stays empty instead of loading demo subscriptions', async () => {
  const queries = new QueryService(createFakeRepositories())
  assert.deepEqual(await queries.listSubscriptions(), [])
})
```

- [ ] **Step 7: Add a static regression guard against JSON persistence**

```ts
const source = await readFile(new URL('../server/server.ts', import.meta.url), 'utf8')
assert.doesNotMatch(source, /dev-state\.json|loadState\(|saveState\(|readFileSync|writeFileSync/)
```

- [ ] **Step 8: Run focused tests and typecheck**

Run: `npx tsx --test tests/mongodb-repositories.test.ts tests/no-json-persistence.test.ts tests/mine-demo-subscriptions.test.ts && npx vue-tsc -b --pretty false`
Expected: PASS; the API source contains no JSON persistence path.

- [ ] **Step 9: Commit the MongoDB read path**

```bash
git add server/server.ts server/persistence/repositories.ts server/services/query-service.ts tests/mongodb-repositories.test.ts tests/no-json-persistence.test.ts tests/mine-demo-subscriptions.test.ts
git commit -m "feat: read application state from MongoDB"
```

### Task 4: Transactional Subscription, Rule, and Project Mutations

**Files:**
- Create: `server/services/subscription-service.ts`
- Create: `server/services/rule-service.ts`
- Create: `server/services/project-service.ts`
- Create: `tests/mongodb-write-services.test.ts`
- Modify: `server/server.ts`

**Interfaces:**
- Consumes: `AppRepositories`, `MongoContext.withTransaction`, existing validation helpers, and `AuditLog`.
- Produces: transactional service methods for subscription create, payment review, rule lifecycle, project open/terminate/interrupt, and takeover.

- [ ] **Step 1: Write failing transaction-behavior tests**

```ts
test('subscription creation updates project, inserts one subscription, and audits in one transaction', async () => {
  const harness = createServiceHarness({ project: openProject({ remain: 500 }) })
  const created = await harness.subscriptions.create({
    projectId: 'PRJ-1', userId: 'employee01', amount: 100,
    agreementsConfirmed: true, idempotencyKey: 'idem-1'
  })
  assert.equal(created.idempotencyKey, 'idem-1')
  assert.equal(harness.project('PRJ-1').remain, 400)
  assert.equal(harness.auditLogs().length, 1)
  assert.equal(harness.committedTransactions, 1)
})

test('duplicate idempotency key returns the existing subscription without a second write', async () => {
  const harness = createServiceHarness({ subscription: subscription({ idempotencyKey: 'idem-1' }) })
  const existing = await harness.subscriptions.create(validSubscriptionRequest({ idempotencyKey: 'idem-1' }))
  assert.equal(existing.id, 'SUB-EXISTING')
  assert.equal(harness.committedTransactions, 0)
})
```

- [ ] **Step 2: Run the service test and verify failure**

Run: `npx tsx --test tests/mongodb-write-services.test.ts`
Expected: FAIL because the service modules do not exist.

- [ ] **Step 3: Implement transaction-safe audit creation**

```ts
function audit(entry: Omit<AuditLog, 'id' | 'time' | 'result'> & { result?: AuditLog['result'] }): AuditLog {
  return { id: randomUUID(), time: now(), result: entry.result ?? '成功', ...entry }
}
```

Every mutation inserts its audit record with the same `ClientSession` as the business changes.

- [ ] **Step 4: Implement subscription creation with unique-key recovery**

Inside one transaction: re-read project, validate remaining amount, update project totals, insert subscription, insert audit. If MongoDB raises duplicate key for `idempotencyKey`, abort and return the existing subscription by that key.

```ts
async create(input: CreateSubscriptionInput) {
  const duplicate = await this.repos.subscriptions.findOne({ idempotencyKey: input.idempotencyKey })
  if (duplicate) return duplicate
  try {
    return await this.mongo.withTransaction(async session => {
      const project = await this.repos.projects.getById(input.projectId, session)
      if (!project) throw appError(404, 'PROJECT_NOT_FOUND', '项目不存在')
      const record = buildSubscription(project, input)
      await this.repos.projects.replace(applySubscriptionAmount(project, input.amount), session)
      await this.repos.subscriptions.insert(record, session)
      await this.repos.auditLogs.insert(auditForSubscription(project, record), session)
      return record
    })
  } catch (error) {
    if (!isDuplicateKey(error)) throw error
    const existing = await this.repos.subscriptions.findOne({ idempotencyKey: input.idempotencyKey })
    if (!existing) throw error
    return existing
  }
}
```

- [ ] **Step 5: Implement rule lifecycle transactions**

Move `/api/rules`, `/api/rules/:id/update`, `/status`, and `/delete` mutations into `RuleService`. Re-read project, receiving code, subscriptions, and current rule inside the transaction before enforcing locking and single-rule constraints.

```ts
async setStatus(ruleId: string, nextStatus: SubscriptionRule['status'], actor: Actor) {
  return this.mongo.withTransaction(async session => {
    const rule = await required(this.repos.rules.getById(ruleId, session), 'RULE_NOT_FOUND')
    const subscriptions = await this.repos.subscriptions.count({ projectId: rule.projectId }, session)
    if (subscriptions > 0 && nextStatus !== rule.status) throw appError(409, 'RULE_LOCKED', '规则已有认购记录，不能修改状态')
    const updated = { ...rule, status: nextStatus, updatedAt: now() }
    await this.repos.rules.replace(updated, session)
    await this.repos.auditLogs.insert(auditRuleStatus(rule, updated, actor), session)
    return updated
  })
}
```

- [ ] **Step 6: Implement project lifecycle transactions**

Move `/api/projects/:id/open`, `/terminate`, `/interrupt`, and `/api/takeovers/:id/force` into `ProjectService`. Re-read all amounts and related subscriptions inside each transaction and retain current status/error codes.

```ts
async interrupt(projectId: string, reason: string, actor: Actor) {
  return this.mongo.withTransaction(async session => {
    const project = await required(this.repos.projects.getById(projectId, session), 'PROJECT_NOT_FOUND')
    const updated = interruptProject(project, reason, now())
    await this.repos.projects.replace(updated, session)
    await this.repos.auditLogs.insert(auditProjectInterrupt(project, updated, actor), session)
    return updated
  })
}
```

- [ ] **Step 7: Wire services into routes and remove remaining array mutations**

Routes parse the request, call one service method, and serialize its result. They must not call `.push`, `.unshift`, `.splice`, or mutate a document returned by a repository without a subsequent transactional `replace`.

- [ ] **Step 8: Run focused and existing business tests**

Run:

```bash
npx tsx --test tests/mongodb-write-services.test.ts tests/subscription-rule-filter.test.ts tests/project-settlement-status.test.ts tests/payment-review.test.ts
```

Expected: PASS with the same public business errors and status transitions.

- [ ] **Step 9: Commit transactional core writes**

```bash
git add server/server.ts server/services/subscription-service.ts server/services/rule-service.ts server/services/project-service.ts tests/mongodb-write-services.test.ts
git commit -m "feat: persist core mutations transactionally"
```

### Task 5: Procurement Sync, Receiving-Code Metadata, and Payment Review Transactions

**Files:**
- Create: `server/services/procurement-sync-service.ts`
- Create: `server/services/receiving-code-service.ts`
- Create: `server/services/payment-service.ts`
- Create: `tests/mongodb-secondary-services.test.ts`
- Modify: `server/server.ts`

**Interfaces:**
- Consumes: repositories, transaction helper, `fetchProcurementPage`, project mapping helpers, and current payment review rules.
- Produces: transactional procurement merge, receiving-code metadata lifecycle, and payment approve/reject methods.

- [ ] **Step 1: Write failing service tests**

```ts
test('procurement sync reports created updated and skipped counts from persisted results', async () => {
  const service = createProcurementServiceHarness([{ id: 1024, projectName: '采购项目', totalCostPrice: 800000 }])
  assert.deepEqual(await service.sync(), { fetched: 1, total: 1, created: 1, updated: 0, skipped: 0 })
  assert.equal(service.persistedProjects().length, 1)
})

test('payment review and its audit record commit together', async () => {
  const harness = createPaymentServiceHarness(pendingReviewSubscription())
  await harness.service.review({ subscriptionId: 'SUB-1', decision: 'approve', operator: 'finance01 · 财务' })
  assert.equal(harness.subscription('SUB-1').pay, '已收款')
  assert.equal(harness.auditLogs().at(-1)?.action, '支付复核 · 通过')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx --test tests/mongodb-secondary-services.test.ts`
Expected: FAIL because the new services do not exist.

- [ ] **Step 3: Implement procurement merge with per-order transaction boundaries**

For each mapped order, re-read the existing project and its rule/subscription existence, then insert or replace only that project. Record one final count-summary audit after all order transactions finish. A repeated sync must keep exactly one project with the same ID.

```ts
for (const order of page.items) {
  const mapped = mapProcurementOrderToProject(order)
  if (!mapped) { skipped += 1; continue }
  await this.mongo.withTransaction(async session => {
    const current = await this.repos.projects.getById(mapped.id, session)
    if (!current) { await this.repos.projects.insert(mapped, session); created += 1; return }
    const locked = await this.isProjectLocked(current.id, session)
    const result = mergeProcurementProject(current, mapped, locked)
    if (result === 'skipped') { skipped += 1; return }
    await this.repos.projects.replace(current, session)
    updated += 1
  })
}
```

- [ ] **Step 4: Implement receiving-code metadata operations**

Create and disable operations use MongoDB counts and transactional audit logs. Creation does not accept a Base64 image; image binding is added in Task 8.

```ts
async create(input: CreateReceivingCodeInput) {
  return this.mongo.withTransaction(async session => {
    if (await this.repos.receivingCodes.count({}, session) >= 100) throw appError(429, 'RECEIVING_CODE_LIMIT_EXCEEDED', '收款码数量已达上限')
    const record = buildReceivingCode(input)
    await this.repos.receivingCodes.insert(record, session)
    await this.repos.auditLogs.insert(auditReceivingCodeCreated(record), session)
    return record
  })
}
```

- [ ] **Step 5: Implement payment review operations**

Approve/reject operations re-read the subscription, validate current status, apply the decision, and insert the audit log in one transaction. Preserve the existing second-confirmation UI contract.

```ts
async review(input: ReviewPaymentInput) {
  return this.mongo.withTransaction(async session => {
    const current = await required(this.repos.subscriptions.getById(input.subscriptionId, session), 'SUBSCRIPTION_NOT_FOUND')
    const updated = applyPaymentReview(current, input)
    await this.repos.subscriptions.replace(updated, session)
    await this.repos.auditLogs.insert(auditPaymentReview(current, updated, input.operator), session)
    return updated
  })
}
```

- [ ] **Step 6: Wire routes and run focused tests**

Run:

```bash
npx tsx --test tests/mongodb-secondary-services.test.ts tests/procurement-sync.test.ts tests/payment-review.test.ts
```

Expected: PASS; no service accesses module-level arrays.

- [ ] **Step 7: Commit secondary MongoDB writes**

```bash
git add server/server.ts server/services/procurement-sync-service.ts server/services/receiving-code-service.ts server/services/payment-service.ts tests/mongodb-secondary-services.test.ts
git commit -m "feat: persist procurement and review workflows"
```

### Task 6: Bounded Multipart Parsing and Raw Image Validation

**Files:**
- Create: `server/http-multipart.ts`
- Create: `server/image-file.ts`
- Create: `tests/http-multipart.test.ts`
- Create: `tests/image-file.test.ts`
- Modify: `server/resource-limits.ts`
- Modify: `tests/security-boundaries.test.ts`

**Interfaces:**
- Consumes: `IncomingMessage`, Busboy, Node `crypto`, approved image size/type limits.
- Produces: `readSingleImageMultipart(req, options): Promise<MultipartImage>`, `validateImageFile(input): ValidatedImage`, and byte-based quota helpers.

- [ ] **Step 1: Write failing multipart and file tests**

```ts
test('PNG magic bytes are accepted and SHA-256 is computed from raw bytes', () => {
  const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const image = validateImageFile({ bytes, fileName: 'receipt.png', declaredMime: 'image/png', maxBytes: 5 * 1024 * 1024 })
  assert.equal(image.mimeType, 'image/png')
  assert.equal(image.extension, 'png')
  assert.equal(image.sha256, createHash('sha256').update(bytes).digest('hex'))
})

test('declared PNG with SVG content is rejected', () => {
  assert.throws(() => validateImageFile({
    bytes: Buffer.from('<svg></svg>'), fileName: 'unsafe.png', declaredMime: 'image/png', maxBytes: 1024
  }), /文件内容与图片类型不匹配/)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx --test tests/http-multipart.test.ts tests/image-file.test.ts`
Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement strict one-file multipart parsing**

```ts
export type MultipartImage = {
  fields: Record<string, string>
  file: { bytes: Buffer; fileName: string; declaredMime: string }
}

export function readSingleImageMultipart(
  req: IncomingMessage,
  options: { maxFileBytes: number; maxFieldBytes: number; allowedFields: readonly string[] }
): Promise<MultipartImage>
```

Reject missing/multiple files, unknown fields, duplicate fields, oversized headers, field overflow, file overflow, aborted requests, and non-multipart content types. Never write request data to disk.

- [ ] **Step 4: Implement magic-byte detection for approved formats**

Support PNG and JPEG everywhere; BMP for payment proof; WebP only where the existing endpoint already allows it. Compare file extension, declared MIME, and magic bytes. Compute SHA-256 from the exact raw bytes that are sent to OCR and COS.

```ts
const signatures = [
  { mimeType: 'image/png', extension: 'png', matches: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) },
  { mimeType: 'image/jpeg', extension: 'jpg', matches: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: 'image/bmp', extension: 'bmp', matches: (b: Buffer) => b.subarray(0, 2).toString('ascii') === 'BM' },
  { mimeType: 'image/webp', extension: 'webp', matches: (b: Buffer) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' }
]
```

- [ ] **Step 5: Replace Base64-character storage quotas with byte quotas**

```ts
export function hasImageByteCapacity(currentBytes: number, replacedBytes: number, incomingBytes: number, maxBytes: number) {
  return currentBytes - replacedBytes + incomingBytes <= maxBytes
}
```

The current per-file 5 MiB limit, image count limits, 8 MiB request boundary, and OCR rate limit remain enforced.

- [ ] **Step 6: Run security-focused tests**

Run:

```bash
npx tsx --test tests/http-multipart.test.ts tests/image-file.test.ts tests/security-boundaries.test.ts
```

Expected: PASS for truncation, over-limit streams, SVG/polyglot rejection, digest stability, and valid PNG/JPEG inputs.

- [ ] **Step 7: Commit multipart and image validation**

```bash
git add server/http-multipart.ts server/image-file.ts server/resource-limits.ts tests/http-multipart.test.ts tests/image-file.test.ts tests/security-boundaries.test.ts
git commit -m "feat: validate bounded multipart image uploads"
```

### Task 7: Tencent COS Adapter and File-Asset State Machine

**Files:**
- Create: `server/storage/object-storage.ts`
- Create: `server/storage/file-asset-service.ts`
- Create: `tests/helpers/fake-object-storage.ts`
- Create: `tests/file-asset-service.test.ts`

**Interfaces:**
- Consumes: COS config, `FileAssetRepository`, validated image bytes, transaction helper, and audit repository.
- Produces: `ObjectStorage`, `TencentCosObjectStorage`, and the `FileAssetService` methods shown below.

- [ ] **Step 1: Write failing state-machine tests**

```ts
test('successful upload transitions pending to ready and returns only asset metadata', async () => {
  const harness = createFileAssetHarness()
  const asset = await harness.service.upload(validUpload({ ownerType: 'project', ownerId: 'PRJ-1' }))
  assert.equal(asset.status, 'ready')
  assert.equal(harness.storage.objects.size, 1)
  assert.equal('body' in asset, false)
})

test('business bind failure marks and immediately deletes the uploaded object', async () => {
  const harness = createFileAssetHarness({ failBinding: true })
  await assert.rejects(() => harness.service.uploadAndBind(validUpload()), /绑定失败/)
  assert.equal(harness.storage.objects.size, 0)
  assert.equal(harness.assets().length, 0)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx --test tests/file-asset-service.test.ts`
Expected: FAIL because storage modules do not exist.

- [ ] **Step 3: Define the storage interface**

```ts
export interface ObjectStorage {
  putObject(input: { key: string; body: Buffer; contentType: string; sha256: string }): Promise<void>
  headObject(key: string): Promise<{ sizeBytes: number } | null>
  getObjectStream(key: string): NodeJS.ReadableStream
  deleteObject(key: string): Promise<void>
  checkHealth(): Promise<'up' | 'degraded'>
}
```

Define the service boundary before implementing it:

```ts
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

export type BindAsset<T> = (asset: FileAsset, session: ClientSession) => Promise<T>
export type UnbindAsset<T> = (asset: FileAsset, session: ClientSession) => Promise<T>
export type PutObjectInput = { key: string; body: Buffer; contentType: string; sha256: string }

export interface FileAssetService {
  uploadUnbound(input: UploadAssetInput): Promise<FileAsset>
  uploadAndBind<T>(input: UploadAssetInput, bind: (asset: FileAsset, session: ClientSession) => Promise<T>): Promise<T>
  replaceBinding<T>(input: UploadAssetInput & { previousAssetId?: string }, bind: (asset: FileAsset, session: ClientSession) => Promise<T>): Promise<T>
  deleteBinding<T>(assetId: string, unbind: (asset: FileAsset, session: ClientSession) => Promise<T>): Promise<T>
  getReadyAsset(assetId: string): Promise<FileAsset | null>
  openReadStream(asset: FileAsset): NodeJS.ReadableStream
}
```

- [ ] **Step 4: Implement production COS calls**

Use `cos-nodejs-sdk-v5` Promise APIs for `putObject`, `headObject`, and `deleteObject`, plus `getObjectStream` for backend proxy reads. Pass `Bucket`, `Region`, and a generated `Key` on every call. Set object ACL to `private`, content type to the validated MIME, and a non-sensitive SHA-256 metadata header.

```ts
async putObject(input: PutObjectInput) {
  await this.cos.putObject({
    Bucket: this.config.bucket,
    Region: this.config.region,
    Key: input.key,
    Body: input.body,
    ContentType: input.contentType,
    ACL: 'private',
    Headers: { 'x-cos-meta-sha256': input.sha256 }
  })
}

getObjectStream(key: string) {
  return this.cos.getObjectStream({ Bucket: this.config.bucket, Region: this.config.region, Key: key })
}
```

- [ ] **Step 5: Implement deterministic object-key generation**

```ts
export function objectKey(prefix: string, purpose: FileAsset['purpose'], assetId: string, extension: string) {
  return `${prefix}/${purpose}/${assetId}.${extension}`
}
```

Reject prefixes, asset IDs, purposes, or extensions that contain `..`, backslashes, encoded slashes, control characters, or leading slashes.

- [ ] **Step 6: Implement upload and request-scoped compensation**

Create `pending`, upload COS, mark `ready`, then invoke the caller-provided MongoDB binding transaction. On later failure, mark `pending_delete`, attempt one exact object deletion, and preserve `lastError` when that deletion fails. Do not start any retry timer.

```ts
async uploadUnbound(input: UploadAssetInput) {
  const pending = this.createPendingAsset(input)
  await this.assets.insert(pending)
  try {
    await this.storage.putObject({ key: pending.objectKey, body: input.bytes, contentType: input.mimeType, sha256: input.sha256 })
    const ready = { ...pending, status: 'ready' as const, updatedAt: now() }
    await this.assets.replace(ready)
    return ready
  } catch (error) {
    await this.compensateExactAsset(pending.id, error)
    throw error
  }
}

async uploadAndBind<T>(input: UploadAssetInput, bind: BindAsset<T>) {
  const ready = await this.uploadUnbound(input)
  try {
    return await this.mongo.withTransaction(session => bind(ready, session))
  } catch (error) {
    await this.compensateExactAsset(ready.id, error)
    throw error
  }
}
```

- [ ] **Step 7: Implement replace and delete semantics**

Replacement makes the new asset `ready` before switching the business reference. Deletion unbinds inside MongoDB first, marks `pending_delete`, then deletes the exact COS object. Successful delete removes `file_assets` metadata and leaves the audit record.

```ts
async deleteBinding<T>(assetId: string, unbind: UnbindAsset<T>) {
  const asset = await required(this.assets.getById(assetId), 'FILE_NOT_FOUND')
  const result = await this.mongo.withTransaction(async session => {
    const value = await unbind(asset, session)
    await this.assets.replace({ ...asset, status: 'pending_delete', updatedAt: now() }, session)
    return value
  })
  await this.storage.deleteObject(asset.objectKey)
  await this.assets.deleteById(asset.id)
  return result
}
```

- [ ] **Step 8: Run focused failure-matrix tests**

Run: `npx tsx --test tests/file-asset-service.test.ts tests/security-boundaries.test.ts`
Expected: PASS for COS upload failure, ready-state failure, binding failure, delete failure, wrong owner, wrong purpose, and successful compensation.

- [ ] **Step 9: Commit COS and file assets**

```bash
git add server/storage/object-storage.ts server/storage/file-asset-service.ts tests/helpers/fake-object-storage.ts tests/file-asset-service.test.ts
git commit -m "feat: store private image assets in Tencent COS"
```

### Task 8: Receiving-Code Multipart Image Workflow

**Files:**
- Create: `tests/receiving-code-service.test.ts`
- Modify: `server/services/receiving-code-service.ts`
- Modify: `server/server.ts`
- Modify: `server/domain/models.ts`

**Interfaces:**
- Consumes: `readSingleImageMultipart`, `validateImageFile`, `FileAssetService`, receiving-code repository, audit repository.
- Produces: receiving-code create/upload/replace responses with `imageAssetId` and derived `/api/files/:assetId/content`.

- [ ] **Step 1: Write failing receiving-code image tests**

```ts
test('receiving-code image binding stores only assetId', async () => {
  const harness = createReceivingCodeHarness(receivingCode({ id: 'RCV-1' }))
  const updated = await harness.service.setImage('RCV-1', validPngUpload(), actor('finance01', 'finance'))
  assert.equal(updated.imageAssetId, 'asset-1')
  assert.equal(JSON.stringify(harness.persistedCode()), JSON.stringify({ ...updated }))
  assert.doesNotMatch(JSON.stringify(harness.persistedCode()), /base64|objectKey|myqcloud/)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx --test tests/receiving-code-service.test.ts`
Expected: FAIL because receiving-code image binding still expects JSON Base64.

- [ ] **Step 3: Implement image upload and replacement binding**

`POST /api/receiving-codes/:id/image` accepts fields `operator` and one file field named `image`. It creates an asset with purpose `receiving-code`, owner type `receiving-code`, owner ID equal to the code ID, then transactionally switches `imageAssetId` and writes an audit entry.

```ts
return this.files.replaceBinding({
  ...validatedImage,
  purpose: 'receiving-code', ownerType: 'receiving-code', ownerId: receivingCodeId, createdBy: actor.userId,
  previousAssetId: current.imageAssetId
}, async (asset, session) => {
  const updated = { ...current, imageAssetId: asset.id, imageName: validatedImage.fileName, updatedAt: now() }
  await this.repos.receivingCodes.replace(updated, session)
  await this.repos.auditLogs.insert(auditReceivingImage(current, updated, actor), session)
  return updated
})
```

- [ ] **Step 4: Remove receiving-code Base64 fields and capacity accounting**

Delete `imageUrl` persistence and the Base64 total-character scan. Response presenters derive the backend file content URL from `imageAssetId`.

```ts
export function presentReceivingCode(code: ReceivingCode) {
  return { ...code, imageUrl: code.imageAssetId ? `/api/files/${encodeURIComponent(code.imageAssetId)}/content` : undefined }
}
```

- [ ] **Step 5: Run receiving-code and security tests**

Run: `npx tsx --test tests/receiving-code-service.test.ts tests/security-boundaries.test.ts`
Expected: PASS; invalid uploads preserve the previous asset binding.

- [ ] **Step 6: Commit the receiving-code image workflow**

```bash
git add server/server.ts server/domain/models.ts server/services/receiving-code-service.ts tests/receiving-code-service.test.ts
git commit -m "feat: persist receiving code images by asset id"
```

### Task 9: Payment Screenshot Storage and OCR

**Files:**
- Create: `tests/payment-storage.test.ts`
- Modify: `server/services/payment-service.ts`
- Modify: `server/server.ts`
- Modify: `server/domain/models.ts`
- Modify: `server/invoice-ocr.ts`
- Modify: `tests/payment-review.test.ts`

**Interfaces:**
- Consumes: validated payment-proof bytes, COS asset service, OCR provider, subscription repository, transaction helper.
- Produces: multipart `/api/payments/ocr`, `PaymentImage.assetId`, accumulated recognized amount, and exact image deletion.

- [ ] **Step 1: Write failing payment storage tests**

```ts
test('recognized payment screenshot stores assetId and cumulative amount', async () => {
  const harness = createPaymentStorageHarness(subscription({ amount: 100, paymentImages: [] }))
  const result = await harness.service.uploadAndRecognize({
    subscriptionId: 'SUB-1', paymentId: 'PAY-1', image: validPngUpload(), actor: actor('employee01', 'employee')
  })
  assert.equal(result.paymentImages[0].assetId, 'asset-1')
  assert.equal(result.recognizedPaidAmount, 100)
  assert.doesNotMatch(JSON.stringify(harness.persistedSubscription()), /paymentImageUrl|base64/)
})

test('failed OCR keeps a deletable asset-backed history row', async () => {
  const harness = createPaymentStorageHarness(subscription({ paymentImages: [] }), { ocrError: '未识别到有效票据内容' })
  const result = await harness.service.uploadAndRecognize(validPaymentUpload())
  assert.equal(result.paymentImages[0].status, '识别失败')
  assert.equal(result.paymentImages[0].assetId, 'asset-1')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx --test tests/payment-storage.test.ts`
Expected: FAIL because payment images still persist Data URLs.

- [ ] **Step 3: Convert raw bytes to an in-memory OCR payload only**

`recognizeFinanceBill` may receive an ephemeral Data URL created from the validated Buffer because the upstream OCR API expects Base64, but that string must stay inside the provider call and must never enter repositories, logs, audits, or responses.

```ts
function ephemeralDataUrl(image: ValidatedImage) {
  return `data:${image.mimeType};base64,${image.bytes.toString('base64')}`
}

const ocr = await recognizeFinanceBill({
  imageDataUrl: ephemeralDataUrl(image),
  appCode: process.env.INVOICE_OCR_APPCODE ?? '',
  endpoint: process.env.INVOICE_OCR_API_URL
})
```

- [ ] **Step 4: Implement multipart payment OCR persistence**

`POST /api/payments/ocr` accepts fields `paymentId`, `subscriptionId`, `expectedAmount`, `operator`, and one `image` file. Upload COS first, call OCR, then transactionally append a `PaymentImage` with `assetId`. Preserve the maximum 10 images, cumulative recognized amount, status mapping, and quota behavior.

```ts
return this.files.uploadAndBind(paymentAssetInput, async (asset, session) => {
  const current = await required(this.repos.subscriptions.getById(input.subscriptionId, session), 'SUBSCRIPTION_NOT_FOUND')
  if ((current.paymentImages?.length ?? 0) >= 10) throw appError(429, 'PAYMENT_IMAGE_LIMIT_EXCEEDED', '支付截图数量已达上限')
  const imageRecord = buildPaymentImage(asset.id, input.fileName, ocrResult, now())
  const updated = appendPaymentImage(current, imageRecord)
  await this.repos.subscriptions.replace(updated, session)
  await this.repos.auditLogs.insert(auditPaymentImage(updated, imageRecord, input.actor), session)
  return updated
})
```

- [ ] **Step 5: Implement exact payment image deletion**

`POST /api/payments/images/delete` uses `subscriptionId` and `imageId`, validates that the row is deletable, unbinds the one asset in a transaction, recalculates cumulative fields, then invokes exact COS deletion. It must not delete another image sharing a filename or digest.

```ts
return this.files.deleteBinding(image.assetId, async (_asset, session) => {
  const current = await required(this.repos.subscriptions.getById(subscriptionId, session), 'SUBSCRIPTION_NOT_FOUND')
  const updated = removePaymentImage(current, imageId)
  await this.repos.subscriptions.replace(updated, session)
  await this.repos.auditLogs.insert(auditPaymentImageDeleted(current, updated, imageId, actor), session)
  return updated
})
```

- [ ] **Step 6: Run payment and security regression tests**

Run:

```bash
npx tsx --test tests/payment-storage.test.ts tests/payment-review.test.ts tests/security-boundaries.test.ts
```

Expected: PASS for recognized, failed, quota, wrong subscription, wrong asset owner, review, and delete flows.

- [ ] **Step 7: Commit payment image persistence**

```bash
git add server/server.ts server/domain/models.ts server/invoice-ocr.ts server/services/payment-service.ts tests/payment-storage.test.ts tests/payment-review.test.ts
git commit -m "feat: store payment screenshots in private COS"
```

### Task 10: Settlement Invoice Asset Binding and OCR Proof Integrity

**Files:**
- Create: `tests/settlement-storage.test.ts`
- Modify: `server/services/settlement-service.ts`
- Modify: `server/server.ts`
- Modify: `server/project-settlement.ts`
- Modify: `server/ocr-proof.ts`
- Modify: `tests/project-settlement-confirmation.test.ts`
- Modify: `tests/security-boundaries.test.ts`

**Interfaces:**
- Consumes: validated settlement image Buffer/SHA-256, file-asset service, OCR provider, `OcrProofStore`, project repository, transaction helper.
- Produces: multipart invoice OCR with `assetId`, proof bound to `{projectId, assetId, imageDigest, fileName}`, and confirmation that persists `SettlementInvoiceRecord.assetId`.

- [ ] **Step 1: Write failing settlement asset tests**

```ts
test('OCR proof binds project asset digest and filename', () => {
  const store = new OcrProofStore({ idFactory: () => 'proof-1' })
  const proof = store.create({
    projectId: 'PRJ-1', assetId: 'asset-1', imageDigest: 'a'.repeat(64),
    fileName: 'invoice.png', result: { amount: 50, fields: [] }
  })
  assert.throws(() => store.consume({
    proofId: proof.proofId, projectId: 'PRJ-1', assetId: 'asset-2',
    imageDigest: 'a'.repeat(64), fileName: 'invoice.png'
  }), /OCR 凭证与上传图片不匹配/)
})

test('settlement history persists assetId without image bytes', async () => {
  const result = await createSettlementHarness().confirm(validSettlementConfirmation({ assetId: 'asset-1' }))
  assert.equal(result.project.settlementInvoices[0].assetId, 'asset-1')
  assert.doesNotMatch(JSON.stringify(result.project), /imageUrl|base64/)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx --test tests/settlement-storage.test.ts tests/project-settlement-confirmation.test.ts`
Expected: FAIL because the proof and settlement record still use Data URLs.

- [ ] **Step 3: Refactor OCR proof identity**

```ts
type OcrProofIdentity = {
  proofId: string
  projectId: string
  assetId: string
  imageDigest: string
  fileName: string
}
```

The store compares the supplied digest string produced from raw bytes; it no longer hashes a Data URL.

- [ ] **Step 4: Implement multipart settlement OCR**

`POST /api/invoices/ocr` accepts `projectId`, `fileName`, and one `image` file. Validate project lifecycle, upload a `settlement-invoice` asset owned by that project, call OCR, and create a short-lived one-time proof. If OCR cannot create a usable proof, attempt immediate exact-object compensation and retain any failed compensation state for manual reconciliation.

```ts
const asset = await this.files.uploadUnbound({
  ...validatedImage,
  purpose: 'settlement-invoice', ownerType: 'project', ownerId: project.id, createdBy: actor.userId
})
try {
  const result = await this.ocr.recognize(ephemeralDataUrl(validatedImage))
  return this.proofs.create({ projectId: project.id, assetId: asset.id, imageDigest: validatedImage.sha256, fileName, result })
} catch (error) {
  await this.files.deleteBinding(asset.id, async () => undefined)
  throw error
}
```

- [ ] **Step 5: Implement proof-based confirmation**

`POST /api/projects/:id/settlements/confirm` accepts `idempotencyKey`, `settlementProofId`, `assetId`, and `operator`. It consumes the matching proof, confirms the asset is `ready` and owned by the project, then transactionally updates cumulative settlement state, appends the invoice asset ID, and writes the audit log.

```ts
const proof = this.proofs.consume({ proofId, projectId, assetId, imageDigest: asset.sha256, fileName })
const result = await this.mongo.withTransaction(async session => {
  const project = await required(this.repos.projects.getById(projectId, session), 'PROJECT_NOT_FOUND')
  const confirmed = confirmProjectSettlement(project, settlementInputFromProof(input, proof), now())
  await this.repos.projects.replace(project, session)
  await this.repos.auditLogs.insert(auditSettlement(project, confirmed, actor), session)
  return confirmed
})
return result
```

Check for an already persisted settlement `idempotencyKey` before consuming the proof. If the transaction fails after proof consumption, return an error that explicitly requires OCR to be repeated; do not silently restore a proof that may have raced with another request.

- [ ] **Step 6: Preserve idempotency and proof replay defenses**

Repeated `idempotencyKey` returns the prior invoice without adding amount again. Replayed, expired, wrong-project, wrong-asset, wrong-digest, or wrong-filename proofs return the existing stable security error family and never bind the asset.

- [ ] **Step 7: Run settlement and security tests**

Run:

```bash
npx tsx --test tests/settlement-storage.test.ts tests/project-settlement-confirmation.test.ts tests/security-boundaries.test.ts
```

Expected: PASS for partial settlement, exact completion, overpayment, replay, tamper, wrong owner, and resource limits.

- [ ] **Step 8: Commit settlement asset persistence**

```bash
git add server/server.ts server/project-settlement.ts server/ocr-proof.ts server/services/settlement-service.ts tests/settlement-storage.test.ts tests/project-settlement-confirmation.test.ts tests/security-boundaries.test.ts
git commit -m "feat: bind settlement proofs to COS assets"
```

### Task 11: Private File Reads and Manual-Only Reconciliation

**Files:**
- Create: `server/request-context.ts`
- Create: `server/storage/reconcile.ts`
- Create: `scripts/storage-reconcile.ts`
- Create: `tests/file-access.test.ts`
- Create: `tests/storage-reconcile.test.ts`
- Modify: `server/server.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `IncomingMessage`, `AppRepositories['fileAssets']`, owner repositories, `FileAssetService`, and audit repository.
- Produces: `requestContext(req): RequestContext`, `authorizeAssetRead`, `GET /api/files/:assetId/content`, `reconcile({dryRun, assetId, apply})`, and `npm run storage:reconcile`.

- [ ] **Step 1: Write failing file authorization tests**

```ts
test('employee can read only a payment asset owned by their subscription', async () => {
  const harness = createFileAccessHarness(paymentAsset({ ownerId: 'SUB-1' }), subscription({ id: 'SUB-1', userId: 'employee01' }))
  await assert.doesNotReject(() => harness.authorize({ userId: 'employee01', role: 'employee' }, 'asset-1'))
  await assert.rejects(() => harness.authorize({ userId: 'employee02', role: 'employee' }, 'asset-1'), /无权访问/)
})

test('file response proxies bytes and never returns COS location headers', async () => {
  const response = await requestFile('/api/files/asset-1/content', financeHeaders())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('location'), null)
  assert.doesNotMatch(JSON.stringify([...response.headers]), /myqcloud|objectKey/)
})
```

- [ ] **Step 2: Write failing reconciliation safety tests**

```ts
test('reconciliation is dry-run unless one exact asset id is supplied', async () => {
  const harness = createReconcileHarness([failedAsset('asset-1'), failedAsset('asset-2')])
  assert.equal((await harness.reconcile({ dryRun: true, apply: false })).mutated, 0)
  await assert.rejects(() => harness.reconcile({ dryRun: false, apply: true }), /必须指定 --asset-id/)
  assert.equal((await harness.reconcile({ dryRun: false, apply: true, assetId: 'asset-1' })).mutated, 1)
  assert.equal(harness.assetExists('asset-2'), true)
})
```

- [ ] **Step 3: Run tests and verify failure**

Run: `npx tsx --test tests/file-access.test.ts tests/storage-reconcile.test.ts`
Expected: FAIL because access and reconciliation modules do not exist.

- [ ] **Step 4: Implement request-context validation**

Accept only the known roles `employee`, `admin`, `finance`, and `super_admin`, plus a non-empty user ID. Reject missing/invalid context on private file routes. Document that these test-environment headers are not production authentication.

```ts
export function requestContext(req: IncomingMessage): RequestContext {
  const userId = String(req.headers['x-user-id'] ?? '').trim()
  const role = String(req.headers['x-user-role'] ?? '').trim()
  if (!userId || !['employee', 'admin', 'finance', 'super_admin'].includes(role)) {
    throw appError(401, 'REQUEST_CONTEXT_REQUIRED', '缺少有效访问身份')
  }
  return { userId, role: role as RequestContext['role'] }
}
```

- [ ] **Step 5: Implement owner-aware file authorization**

Employees may read payment assets for their own subscription. Finance/super-admin roles may read payment and settlement assets. Admin/super-admin roles may read project assets. Receiving-code visibility follows the current role/page rules. Asset existence and permission errors return the same generic 404 response to avoid enumeration.

```ts
export async function authorizeAssetRead(context: RequestContext, asset: FileAsset, repos: AppRepositories) {
  if (asset.status !== 'ready') throw fileNotFound()
  if (context.role === 'super_admin') return
  if (asset.purpose === 'payment-proof') {
    const subscription = await repos.subscriptions.getById(asset.ownerId)
    if (context.role === 'finance' || subscription?.userId === context.userId) return
  }
  if (asset.purpose === 'settlement-invoice' && context.role === 'finance') return
  if (asset.purpose === 'receiving-code' && ['employee', 'admin', 'finance'].includes(context.role)) return
  throw fileNotFound()
}
```

- [ ] **Step 6: Implement backend-proxied file streaming**

Read only `ready` assets, call `getObjectStream(asset.objectKey)`, set the validated MIME and `Cache-Control: private, no-store`, and pipe bytes to the response. Never set a COS `Location` header and never log the signed request.

```ts
res.writeHead(200, {
  'Content-Type': asset.mimeType,
  'Content-Length': String(asset.sizeBytes),
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff'
})
fileAssetService.openReadStream(asset)
  .once('error', () => { if (!res.headersSent) sendStorageUnavailable(res); else res.destroy() })
  .pipe(res)
```

- [ ] **Step 7: Implement reconciliation without scheduling**

Dry-run lists metadata only: asset ID, status, purpose, owner type/ID, reference count, and whether the exact COS object exists. Apply mode requires `--asset-id`, re-reads current references, and acts only when the asset has zero business references and its status is `failed`, `pending_delete`, or an explicitly selected unbound `ready` asset. This permits manual removal of an abandoned successful OCR upload without introducing scheduled cleanup.

```ts
export async function reconcile(input: ReconcileInput, deps: ReconcileDependencies) {
  if (input.apply && !input.assetId) throw new Error('--apply 必须同时指定 --asset-id')
  const assets = input.assetId ? [await deps.assets.getById(input.assetId)].filter(Boolean) : await deps.assets.list()
  const report = await Promise.all(assets.map(asset => inspectAsset(asset!, deps)))
  if (!input.apply) return { mutated: 0, report }
  const target = report[0]
  if (!target || target.referenceCount !== 0 || !['failed', 'pending_delete', 'ready'].includes(target.status)) {
    throw new Error('资产仍被引用或状态不允许人工处理')
  }
  await deleteExactAsset(target, deps)
  return { mutated: 1, report }
}
```

- [ ] **Step 8: Add script and static no-scheduler guard**

```json
{
  "scripts": {
    "storage:reconcile": "node --env-file-if-exists=.env.local --import tsx scripts/storage-reconcile.ts"
  }
}
```

Add a test that checks production source and `package.json` contain no `setInterval`, `node-cron`, cleanup schedule, or TTL index definition.

- [ ] **Step 9: Run focused tests**

Run: `npx tsx --test tests/file-access.test.ts tests/storage-reconcile.test.ts tests/security-boundaries.test.ts`
Expected: PASS with no automatic cleanup path.

- [ ] **Step 10: Commit private reads and reconciliation**

```bash
git add package.json package-lock.json server/server.ts server/request-context.ts server/storage/reconcile.ts scripts/storage-reconcile.ts tests/file-access.test.ts tests/storage-reconcile.test.ts
git commit -m "feat: authorize file reads and manual reconciliation"
```

### Task 12: Frontend FormData Uploads and Real Empty States

**Files:**
- Create: `src/file-upload.ts`
- Create: `tests/frontend-file-upload.test.ts`
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: browser `File`, current role/account, multipart backend endpoints, `assetId`, and backend file content URLs.
- Produces: `buildImageFormData`, `assetContentUrl`, FormData-based receiving/payment/settlement flows, and empty-state UI without runtime demo rows.

- [ ] **Step 1: Write failing frontend helper tests**

```ts
test('FormData contains the original File and text fields without Base64', () => {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'receipt.png', { type: 'image/png' })
  const form = buildImageFormData(file, { projectId: 'PRJ-1', operator: 'finance01 · 财务' })
  assert.equal(form.get('image'), file)
  assert.equal(form.get('projectId'), 'PRJ-1')
  assert.doesNotMatch(String(form.get('image')), /base64/)
})

test('asset content URL is backend-relative and encoded', () => {
  assert.equal(assetContentUrl('asset/1'), '/api/files/asset%2F1/content')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx --test tests/frontend-file-upload.test.ts`
Expected: FAIL because `src/file-upload.ts` does not exist.

- [ ] **Step 3: Implement upload helpers**

```ts
export function buildImageFormData(file: File, fields: Record<string, string | number>) {
  const form = new FormData()
  form.set('image', file, file.name)
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value))
  return form
}

export function assetContentUrl(assetId?: string) {
  return assetId ? `/api/files/${encodeURIComponent(assetId)}/content` : ''
}
```

- [ ] **Step 4: Replace Data URL persistence in all three UI flows**

Receiving code, payment screenshot, and settlement invoice requests send FormData and omit the manual `Content-Type` header so the browser supplies the multipart boundary. Local previews use `URL.createObjectURL(file)` and call `URL.revokeObjectURL()` when replaced, closed, or unmounted.

```ts
const response = await fetch(`/api/receiving-codes/${encodeURIComponent(codeId)}/image`, {
  method: 'POST',
  body: buildImageFormData(selectedFile, { operator: `${roleMeta.value.account} · ${roleMeta.value.label}` })
})
```

- [ ] **Step 5: Add request-context headers for private file reads**

Create one backend file request helper that sends the current account and role headers, receives a Blob, and exposes a revocable `blob:` URL to Element Plus image preview. Do not put context values in query strings.

```ts
export async function loadPrivateImage(assetId: string, context: { userId: string; role: string }) {
  const response = await fetch(assetContentUrl(assetId), {
    headers: { 'x-user-id': context.userId, 'x-user-role': context.role }
  })
  if (!response.ok) throw new Error('图片读取失败')
  return URL.createObjectURL(await response.blob())
}
```

- [ ] **Step 6: Remove runtime demo fallback arrays and legacy image fields**

Delete UI logic that reconstructs `paymentImages` from `paymentImageUrl`. Use `assetId` plus response-derived image URL/blob URL. Empty API arrays render the existing empty-state components.

```ts
const activePaymentImages = computed(() => activePaymentSubscription.value?.paymentImages ?? [])
const hasProjects = computed(() => projects.value.length > 0)
```

- [ ] **Step 7: Run frontend-focused tests and build**

Run:

```bash
npx tsx --test tests/frontend-file-upload.test.ts tests/invoice-image.test.ts tests/settlement-invoice-upload-card.test.ts tests/settlement-invoice-record-list.test.ts
npm run build
```

Expected: PASS; production bundle search has no `data:image` runtime persistence branch or `dev-state.json`.

- [ ] **Step 8: Commit frontend multipart migration**

```bash
git add src/App.vue src/file-upload.ts tests/frontend-file-upload.test.ts
git commit -m "feat: upload private images with multipart forms"
```

### Task 13: Isolated Live MongoDB/COS Tests, Smoke Rewrite, Runtime Docs, and Final Verification

**Files:**
- Create: `tests/helpers/mongo-test-scope.ts`
- Create: `tests/fixtures/storage-smoke-state.ts`
- Create: `tests/live-storage-integration.mjs`
- Modify: `tests/smoke.mjs`
- Modify: `package.json`
- Modify: `scripts/local-processes.sh`
- Modify: `docs/04-设计/HLD-概要设计.md`
- Modify: `docs/04-设计/LLD-详细设计.md`
- Modify: `docs/08-落地实施文档.md`
- Modify: `docs/06-操作手册/全项目操作使用说明.md`

**Interfaces:**
- Consumes: real `.env.local` MongoDB/COS configuration, `MONGODB_COLLECTION_PREFIX`, `COS_OBJECT_PREFIX`, all production services, and a tracked run ID.
- Produces: isolated real-service integration tests, rewritten smoke test, startup diagnostics, updated operator docs, and final acceptance evidence.

- [ ] **Step 1: Write the isolated-scope safety test first**

```ts
test('test scope accepts only a generated prefix and records exact cleanup targets', () => {
  const scope = createMongoTestScope('run-20260828-001')
  assert.equal(scope.prefix, '__test_run_20260828_001_')
  assert.throws(() => createMongoTestScope('projects'), /不安全的测试运行标识/)
  assert.deepEqual(scope.cleanupCollections(['projects']), ['__test_run_20260828_001_projects'])
})
```

- [ ] **Step 2: Implement MongoDB test collection isolation**

Production startup rejects a non-empty collection prefix unless `NODE_ENV=test`. The helper generates `__test_<sanitized-run-id>_`, records every created collection, and teardown drops only the exact recorded names after verifying the prefix again.

```ts
export function createMongoTestScope(runId: string) {
  const safe = runId.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!/^run_[a-z0-9_]+$/.test(safe)) throw new Error('不安全的测试运行标识')
  const prefix = `__test_${safe}_`
  return { prefix, collection: (base: string) => `${prefix}${base}` }
}
```

- [ ] **Step 3: Implement COS test object isolation**

Live tests use `crowfunding/integration-tests/<run-id>/asset-test.png`, record every object key created, and teardown deletes only those exact keys. No prefix-wide or bucket-wide delete API is allowed.

```js
const runId = `run-${Date.now()}-${process.pid}`
const objectKey = `crowfunding/integration-tests/${runId}/asset-test.png`
const createdObjectKeys = new Set([objectKey])
// finally: for (const key of createdObjectKeys) await storage.deleteObject(key)
```

- [ ] **Step 4: Add a real-service integration script**

```json
{
  "scripts": {
    "test:storage-live": "node --env-file-if-exists=.env.local tests/live-storage-integration.mjs"
  }
}
```

The script verifies MongoDB connection/transaction/index behavior and one COS put/head/get/delete cycle. It checks the downloaded SHA-256 equals the uploaded SHA-256 and prints no secret-bearing error object.

- [ ] **Step 5: Rewrite smoke setup and teardown**

Remove `copyFile`, `writeFile`, JSON backup, and JSON restore. Before starting, hash `data/dev-state.json` if present. Seed only the generated MongoDB test collections with `tests/fixtures/storage-smoke-state.ts`, run the full API flow against test-prefixed collections, restart the API, verify persistence, then delete only recorded test collections/objects. Confirm the JSON hash and mtime are unchanged.

- [ ] **Step 6: Convert smoke uploads to multipart**

Use Node `FormData` and `Blob` for receiving-code, payment, and settlement uploads. Assert returned business records contain `assetId`, private file endpoints return the original bytes, and serialized MongoDB documents contain no Base64 or COS URL.

```js
const form = new FormData()
form.set('projectId', settlementProject.id)
form.set('fileName', 'smoke-invoice.png')
form.set('image', new Blob([pngBytes], { type: 'image/png' }), 'smoke-invoice.png')
const response = await fetch(`${baseUrl}/api/invoices/ocr`, { method: 'POST', body: form })
```

- [ ] **Step 7: Update local process diagnostics**

When API startup fails, `scripts/local-processes.sh` prints the log path and the final redacted preflight error. It must not echo `.env.local`, MongoDB URI, COS SDK error URL, SecretId, or SecretKey.

```bash
tail -n 20 "$API_LOG" | sed -E 's#mongodb(\+srv)?://[^ ]+#mongodb://[REDACTED]#g; s/(Secret(Id|Key)|COS_SECRET_(ID|KEY))[^ ]*/\1=[REDACTED]/g' >&2
```

- [ ] **Step 8: Update runtime and operations documentation**

Document exact storage architecture, `.env.local` variable names, `npm run storage:preflight`, live integration testing, manual-only reconciliation, private file reads, and the fact that `data/dev-state.json` is ignored and not a rollback source. Record all generated documentation paths in the final handoff.

- [ ] **Step 9: Run preflight without mutations**

Run: `npm run storage:preflight`
Expected: database `crowfunding`, transaction-capable deployment, no unreported schema conflict, and COS configuration present. The output contains no URI or credentials.

- [ ] **Step 10: Run the real storage integration test**

Run: `npm run test:storage-live`
Expected: one isolated MongoDB transaction and one exact COS object put/head/get/delete cycle pass; existing business collection counts remain unchanged.

- [ ] **Step 11: Run the complete automated suite**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: all unit and smoke tests pass, production build succeeds, and diff check is clean.

- [ ] **Step 12: Start the real application and verify runtime health**

Run:

```bash
npm run local -- restart
curl -fsS http://127.0.0.1:4100/api/health
curl -fsS http://127.0.0.1:5174/
```

Expected: health reports MongoDB provider and database `crowfunding`; frontend returns HTTP 200; no JSON path or secret is exposed.

- [ ] **Step 13: Verify persistence and existing-data preservation**

Run the UI/API restart persistence scenario against the generated `__test_<run-id>_` collections and the matching COS integration-test prefix. For the unprefixed production collection names, compare read-only counts and conflict reports before/after; they must be identical. Do not create, delete, or rewrite an unprefixed business record during automated acceptance.

- [ ] **Step 14: Final security and source scans**

Run:

```bash
rg -n "dev-state\.json|loadState\(|saveState\(|writeFileSync|setInterval|node-cron|expireAfterSeconds" server src package.json
rg -n "paymentImageUrl|imageDataUrl|imageUrl" server/domain server/persistence
rg -n "MONGODB_URI=.+|COS_SECRET_ID=.+|COS_SECRET_KEY=.+" --hidden -g '!.env.local' -g '!node_modules' -g '!.git'
```

Expected: the first two scans find no JSON persistence, persisted image URL, or automatic-cleanup path; the secret scan finds no committed secret value. An ephemeral OCR provider conversion may remain inside `server/invoice-ocr.ts`, outside domain and persistence code.

- [ ] **Step 15: Commit integration, smoke, and documentation**

```bash
git add package.json package-lock.json scripts/local-processes.sh tests/helpers/mongo-test-scope.ts tests/fixtures/storage-smoke-state.ts tests/live-storage-integration.mjs tests/smoke.mjs docs/04-设计/HLD-概要设计.md docs/04-设计/LLD-详细设计.md docs/08-落地实施文档.md docs/06-操作手册/全项目操作使用说明.md
git commit -m "test: verify MongoDB and COS persistence end to end"
```

## Final Review Gate

Before declaring completion, compare every acceptance criterion in the design spec with fresh evidence from Tasks 1-13. Report separately:

- Code and unit-test completion.
- Real MongoDB transaction/index verification.
- Real COS put/read/delete verification.
- Full E2E and API-restart persistence verification.
- `data/dev-state.json` hash/mtime unchanged evidence.
- Existing `crowfunding` content preservation evidence.
- Remaining production-authentication limitation for private files.
- Git commit and push status; do not treat a local commit as remote delivery.

## Spec Coverage Map

| Design requirement | Plan tasks |
| --- | --- |
| MongoDB is the only business source; no JSON fallback or runtime seeds | 1-5, 13 |
| Exact existing database `crowfunding`; non-destructive preflight and indexes | 1-3, 13 |
| Transactional project, subscription, rule, review, audit, and settlement writes | 2, 4, 5, 9, 10 |
| Private COS, backend upload, business `assetId` only | 6-10, 12 |
| Raw-byte validation, SHA-256, size/count/rate protections | 6, 7, 9, 10 |
| Request-scoped compensation with explicit asset states | 7-10 |
| No timer, cron, TTL deletion, or scheduled cleanup | 7, 11, 13 |
| Manual dry-run reconciliation and exact one-asset apply | 11 |
| Private backend-proxied reads and owner checks | 11, 12 |
| Real MongoDB/COS integration, restart persistence, and existing-data preservation | 13 |
| Secret-free configuration, logs, responses, and frontend bundles | 1, 2, 7, 11-13 |
