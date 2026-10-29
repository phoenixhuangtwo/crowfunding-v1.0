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
    mongodb: { uri: required(env, 'MONGODB_URI'), database, collectionPrefix },
    cos: {
      secretId: required(env, 'COS_SECRET_ID'),
      secretKey: required(env, 'COS_SECRET_KEY'),
      bucket: required(env, 'COS_BUCKET'),
      region: required(env, 'COS_REGION'),
      objectPrefix: required(env, 'COS_OBJECT_PREFIX').replace(/^\/+|\/+$/g, '')
    }
  }
}
