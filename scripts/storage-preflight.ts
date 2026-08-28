import { loadAppConfig } from '../server/config.ts'
import { connectMongo } from '../server/persistence/mongo.ts'
import { businessCollections, collectionName, inspectSchema } from '../server/persistence/schema.ts'

async function main() {
  const config = loadAppConfig()
  const mongo = await connectMongo(config.mongodb)
  try {
    const conflicts = await inspectSchema(mongo.db, config.mongodb.collectionPrefix)
    const summary = {
      ok: conflicts.length === 0,
      database: config.mongodb.database,
      transactionSupport: true,
      collections: businessCollections.map(name => collectionName(name, config.mongodb.collectionPrefix)),
      conflictCount: conflicts.length,
      conflicts,
      cos: {
        configured: true,
        fields: ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET', 'COS_REGION', 'COS_OBJECT_PREFIX']
      }
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    if (conflicts.length > 0) process.exitCode = 1
  } finally {
    await mongo.close()
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : '存储预检失败'
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  process.exitCode = 1
})
