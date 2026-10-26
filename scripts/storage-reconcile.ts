import { loadAppConfig } from '../server/config.ts'
import { connectMongo } from '../server/persistence/mongo.ts'
import { createRepositories } from '../server/persistence/repositories.ts'
import { TencentCosObjectStorage } from '../server/storage/object-storage.ts'
import { reconcile } from '../server/storage/reconcile.ts'

function parseArgs(args: string[]) {
  const apply = args.includes('--apply')
  const assetIndex = args.indexOf('--asset-id')
  const assetId = assetIndex >= 0 ? args[assetIndex + 1]?.trim() : undefined
  return { apply, dryRun: !apply, assetId }
}

async function main() {
  const config = loadAppConfig()
  const mongo = await connectMongo(config.mongodb)
  try {
    const repos = createRepositories(mongo.db, config.mongodb.collectionPrefix)
    const storage = new TencentCosObjectStorage(config.cos)
    const result = await reconcile(parseArgs(process.argv.slice(2)), {
      assets: repos.fileAssets,
      storage,
      async referenceCount(assetId) {
        const [projects, subscriptions, receivingCodes, purchasePayments, receiptBatches, confirmedCosts, distributionOrders, exceptionFunds] = await Promise.all([
          repos.projects.count({ 'settlementInvoices.assetId': assetId } as never),
          repos.subscriptions.count({ 'paymentImages.assetId': assetId } as never),
          repos.receivingCodes.count({ imageAssetId: assetId }),
          mongo.db.collection(`${config.mongodb.collectionPrefix}procurement_payments`).countDocuments({ proofAssetIds: assetId }),
          mongo.db.collection(`${config.mongodb.collectionPrefix}receipt_batches`).countDocuments({ proofAssetIds: assetId }),
          mongo.db.collection(`${config.mongodb.collectionPrefix}confirmed_costs`).countDocuments({ proofAssetIds: assetId }),
          mongo.db.collection(`${config.mongodb.collectionPrefix}distribution_orders`).countDocuments({ 'lines.payout.proofAssetIds': assetId }),
          mongo.db.collection(`${config.mongodb.collectionPrefix}exception_funds`).countDocuments({
            $or: [{ proofAssetIds: assetId }, { 'allocations.proofAssetIds': assetId }] })
        ])
        return projects + subscriptions + receivingCodes + purchasePayments + receiptBatches + confirmedCosts + distributionOrders + exceptionFunds
      }
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await mongo.close()
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : '人工对账失败'}\n`)
  process.exitCode = 1
})
