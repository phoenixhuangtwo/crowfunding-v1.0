import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { AgreementError, AgreementService } from '../server/agreements.ts'

const uri = process.env.MONGODB_URI
const database = process.env.MONGODB_DB
if (!uri || !database) throw new Error('MONGODB_URI 和 MONGODB_DB 必须配置')

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 })
const prefix = `__test_agreements_${randomUUID().replaceAll('-', '')}_`
try {
  await client.connect()
  const db = client.db(database)
  const service = new AgreementService(db, prefix)
  await service.ensureIndexes()
  const body = '员工独立承担税费，分配金额为税前金额；客户坏账、退货与采购失败缺口由公司承担，预估收益不构成收益承诺。'
  const first = await service.create({ title: '员工免责协议第一版', body, createdBy: '公司管理员' })
  assert.equal(first.version, 1)
  assert.equal((await service.requireCurrent(1)).id, first.id)
  await service.confirm({ version: first.version, userId: 'employee01', userName: '测试员工', node: '提交认购', relatedId: 'SUB-TEST-1' })
  const second = await service.create({ title: '员工免责协议第二版', body, createdBy: '公司管理员' })
  assert.equal(second.version, 2)
  await assert.rejects(service.requireCurrent(1), (error: unknown) => error instanceof AgreementError && error.code === 'AGREEMENT_VERSION_CHANGED')
  const history = await service.list(1, 10)
  assert.deepEqual(history.items.map(item => item.version), [2, 1])
  const confirmations = await service.listConfirmations(1, 1, 10, { userId: 'employee01', node: '提交认购' })
  assert.equal(confirmations.total, 1)
  assert.equal(confirmations.items[0]?.relatedId, 'SUB-TEST-1')
  assert.equal(await service.hasRecentCodeConfirmation('employee01', 'CODE-1', 2, new Date(Date.now() - 1000)), false)
  await service.confirm({ version: 2, userId: 'employee01', userName: '测试员工', node: '查看缴款码', relatedId: 'SUB-TEST-1', codeId: 'CODE-1' })
  assert.equal(await service.hasRecentCodeConfirmation('employee01', 'CODE-1', 2, new Date(Date.now() - 5000)), true)
  assert.equal(await service.hasRecentCodeConfirmation('employee02', 'CODE-1', 2, new Date(Date.now() - 5000)), false)
  const revised = await service.revise(2, { title: '修改后的免责协议', body: body + ' 本条为新增说明。', createdBy: '公司管理员' })
  assert.equal(revised.version, 3)
  assert.equal((await service.list()).items.find(item => item.version === 2)?.body, body)
  await service.remove(3, '公司管理员')
  assert.equal(await service.current(), null)
  await assert.rejects(service.requireCurrent(2), (error: unknown) => error instanceof AgreementError && error.code === 'AGREEMENT_NOT_CONFIGURED')
  assert.equal((await service.list()).items.some(item => item.version === 3), false)
  assert.equal((await service.listConfirmations(1)).total, 1)
  const fourth = await service.create({ title: '删除后新增的协议', body, createdBy: '公司管理员' })
  assert.equal(fourth.version, 4)
  await assert.rejects(service.revise(3, { title: '不能修改已删除协议', body, createdBy: '公司管理员' }))
  console.log('agreement integration passed in isolated collections')
} finally {
  const db = client.db(database)
  for (const name of ['agreement_versions', 'agreement_confirmations']) {
    await db.collection(`${prefix}${name}`).drop().catch(error => {
      if (error?.codeName !== 'NamespaceNotFound') throw error
    })
  }
  await client.close()
}
