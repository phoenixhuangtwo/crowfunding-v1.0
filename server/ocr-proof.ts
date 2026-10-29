import { randomUUID } from 'node:crypto'
import type { InvoiceOcrResult } from './invoice-ocr.ts'

export const DEFAULT_OCR_PROOF_TTL_MS = 10 * 60 * 1000

type OcrProofRecord = {
  proofId: string
  projectId: string
  assetId: string
  imageDigest: string
  fileName: string
  result: InvoiceOcrResult
  expiresAt: number
}

type OcrProofStoreOptions = {
  ttlMs?: number
  maxEntries?: number
  maxEntriesPerProject?: number
  now?: () => number
  idFactory?: () => string
}

type OcrProofIdentity = {
  proofId: string
  projectId: string
  assetId: string
  imageDigest: string
  fileName: string
}

export class OcrProofStore {
  private readonly proofs = new Map<string, OcrProofRecord>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly maxEntriesPerProject: number
  private readonly now: () => number
  private readonly idFactory: () => string

  constructor(options: OcrProofStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_OCR_PROOF_TTL_MS
    this.maxEntries = options.maxEntries ?? 100
    this.maxEntriesPerProject = options.maxEntriesPerProject ?? 20
    this.now = options.now ?? Date.now
    this.idFactory = options.idFactory ?? randomUUID
  }

  private removeExpired() {
    const now = this.now()
    for (const [proofId, proof] of this.proofs) {
      if (proof.expiresAt <= now) this.proofs.delete(proofId)
    }
  }

  create(input: { projectId: string; assetId: string; imageDigest: string; fileName: string; result: InvoiceOcrResult }) {
    this.removeExpired()
    if (!input.projectId.trim()) throw new Error('OCR 凭证缺少项目编号')
    if (!input.assetId.trim() || !/^[a-f0-9]{64}$/i.test(input.imageDigest)) throw new Error('OCR 凭证缺少有效图片资产')
    if (!Number.isFinite(input.result.amount) || Number(input.result.amount) < 0.01) {
      throw new Error('OCR 未识别到可结算的交易金额')
    }
    const projectEntries = [...this.proofs.values()].filter(proof => proof.projectId === input.projectId).length
    if (this.proofs.size >= this.maxEntries || projectEntries >= this.maxEntriesPerProject) {
      throw new Error('待确认 OCR 凭证已达上限，请先完成或稍后重试')
    }
    const proofId = this.idFactory()
    const expiresAt = this.now() + this.ttlMs
    this.proofs.set(proofId, {
      proofId,
      projectId: input.projectId,
      assetId: input.assetId,
      imageDigest: input.imageDigest,
      fileName: input.fileName,
      result: structuredClone(input.result),
      expiresAt
    })
    return { proofId, expiresAt }
  }

  verify(input: OcrProofIdentity) {
    this.removeExpired()
    const proof = this.proofs.get(input.proofId)
    if (!proof) throw new Error('OCR 凭证不存在或已使用，请重新识别')
    if (proof.projectId !== input.projectId) throw new Error('OCR 凭证与当前项目不匹配')
    if (proof.fileName !== input.fileName || proof.assetId !== input.assetId || proof.imageDigest !== input.imageDigest) {
      throw new Error('OCR 凭证与上传图片不匹配')
    }
    return structuredClone(proof)
  }

  remove(proofId: string) {
    this.proofs.delete(proofId)
  }

  restore(proof: OcrProofRecord) {
    this.removeExpired()
    if (proof.expiresAt > this.now()) this.proofs.set(proof.proofId, structuredClone(proof))
  }

  consume(input: OcrProofIdentity) {
    const proof = this.verify(input)
    this.remove(input.proofId)
    return proof
  }
}
