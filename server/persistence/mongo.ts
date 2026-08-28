import { MongoClient, type ClientSession, type Db } from 'mongodb'
import type { AppConfig } from '../config.ts'
import { transactionCapabilityError } from './schema.ts'

export type MongoContext = {
  client: MongoClient
  db: Db
  withTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T>
  close(): Promise<void>
}

function createMongoContext(client: MongoClient, db: Db): MongoContext {
  return {
    client,
    db,
    async withTransaction<T>(work: (session: ClientSession) => Promise<T>) {
      const session = client.startSession()
      try {
        const result = await session.withTransaction(() => work(session), {
          readPreference: 'primary',
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' }
        })
        if (result === undefined) throw new Error('MongoDB 事务未返回结果')
        return result
      } finally {
        await session.endSession()
      }
    },
    close: () => client.close()
  }
}

export async function connectMongo(config: AppConfig['mongodb']): Promise<MongoContext> {
  const client = new MongoClient(config.uri, {
    serverSelectionTimeoutMS: 5_000,
    retryWrites: true
  })
  try {
    await client.connect()
    const db = client.db(config.database)
    const hello = await db.command({ hello: 1 })
    const capabilityError = transactionCapabilityError(hello)
    if (capabilityError) throw new Error(capabilityError)
    return createMongoContext(client, db)
  } catch (error) {
    await client.close().catch(() => undefined)
    throw error
  }
}
