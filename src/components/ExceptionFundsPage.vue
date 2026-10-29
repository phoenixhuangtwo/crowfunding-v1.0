<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { apiRequest } from '../auth/api-client'
import { readAccessToken } from '../auth/session'

type Project = { id: string; title: string; status: string }
type Fund = { id: string; projectId?: string; amountCents: number; processedCents: number;
  remainingCents: number; transactionNo: string; bookedAt: string; sourceNote: string;
  payerUserId?: string; manualVerificationNote: string; proofAssetIds: string[]; status: string;
  allocations: Array<{ id: string; kind: string; amountCents: number; status: string;
    recipientKind?: string; transactionNo?: string; proofAssetIds?: string[] }> }
const props = defineProps<{ projects: Project[]; role: 'finance' | 'super_admin';
  canRegister: boolean; canUploadProof: boolean; canRefund: boolean;
  canUploadRefundProof: boolean; canConfirmRefund: boolean;
  canTransfer: boolean; canReviewTransfer: boolean; canAssignProject: boolean }>()
const emit = defineEmits<{ updated: [] }>()
const openProjects = computed(() => props.projects.filter(project => project.status !== '已完结'))
const filterProjectId = ref('')
const filterStatus = ref('')
const page = ref(1)
const items = ref<Fund[]>([])
const total = ref(0)
const loading = ref(false)
const submitting = ref(false)
const uploading = ref(false)
const projectId = ref('')
const payerUserId = ref('')
const amount = ref<number>()
const transactionNo = ref('')
const bookedAt = ref('')
const sourceNote = ref('')
const manualVerificationNote = ref('')
const proofs = ref<Array<{ id: string; fileName: string }>>([])
const refundTarget = ref<Fund>()
const refundAmount = ref<number>()
const refundTransactionNo = ref('')
const refundPaidAt = ref('')
const refundReason = ref('')
const refundProofs = ref<Array<{ id: string; fileName: string }>>([])
const transferTarget = ref<Fund>()
const transferSubscriptions = ref<Array<{ id: string; projectId: string; userId: string;
  amount: number; actualPaidAmount?: number; pay: string; paymentDeadlineAt: string }>>([])
const transferSubscriptionId = ref('')
const transferAmount = ref<number>()
const transferReason = ref('')
const assignTarget = ref<Fund>()
const assignProjectId = ref('')
const assignReason = ref('')
const money = (cents: number) => `¥ ${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

watch([filterProjectId, filterStatus], () => { page.value = 1; void refresh() })
watch(page, () => { void refresh() })
void refresh()

async function refresh() {
  loading.value = true
  try {
    const query = new URLSearchParams({ page: String(page.value), pageSize: '10' })
    if (filterProjectId.value) query.set('projectId', filterProjectId.value)
    if (filterStatus.value) query.set('status', filterStatus.value)
    const result = await apiRequest<{ data: { items: Fund[]; total: number } }>(`/api/exception-funds?${query}`)
    items.value = result.data.items
    total.value = result.data.total
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '读取异常款项失败') }
  finally { loading.value = false }
}

async function uploadProofs(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length || !props.canUploadProof) return
  if (proofs.value.length + files.length > 5) { ElMessage.warning('最多上传 5 张凭证'); return }
  uploading.value = true
  try {
    for (const file of files) {
      const form = new FormData()
      form.set('image', file)
      const result = await apiRequest<{ data: { id: string; fileName: string } }>(
        '/api/exception-funds/proofs', { method: 'POST', body: form })
      proofs.value.push(result.data)
    }
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '上传凭证失败') }
  finally { uploading.value = false }
}

async function register() {
  if (!props.canRegister || submitting.value) return
  const amountCents = Math.round((amount.value ?? 0) * 100)
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) { ElMessage.warning('请输入大于零的金额'); return }
  if (!bookedAt.value || !proofs.value.length) { ElMessage.warning('请填写到账时间并上传凭证'); return }
  if (sourceNote.value.trim().length < 5 || manualVerificationNote.value.trim().length < 5) {
    ElMessage.warning('来源和人工核验说明均至少填写 5 字'); return
  }
  submitting.value = true
  try {
    await apiRequest('/api/exception-funds', { method: 'POST', body: JSON.stringify({
      projectId: projectId.value || undefined, payerUserId: payerUserId.value.trim() || undefined,
      amountCents, transactionNo: transactionNo.value.trim(),
      bookedAt: new Date(bookedAt.value).toISOString(), sourceNote: sourceNote.value.trim(),
      manualVerificationNote: manualVerificationNote.value.trim(), proofAssetIds: proofs.value.map(item => item.id)
    }) })
    ElMessage.success('异常款项登记成功')
    amount.value = undefined; transactionNo.value = ''; bookedAt.value = ''; sourceNote.value = ''; payerUserId.value = ''
    manualVerificationNote.value = ''; proofs.value = []
    await refresh()
    emit('updated')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '登记失败') }
  finally { submitting.value = false }
}

function startRefund(item: Fund) {
  refundTarget.value = item
  refundAmount.value = undefined
  refundTransactionNo.value = ''
  refundPaidAt.value = ''
  refundReason.value = ''
  refundProofs.value = []
}

async function uploadRefundProofs(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!refundTarget.value || !files.length || !props.canUploadRefundProof) return
  if (refundProofs.value.length + files.length > 5) { ElMessage.warning('最多上传 5 张退回凭证'); return }
  uploading.value = true
  try {
    for (const file of files) {
      const form = new FormData()
      form.set('image', file)
      const result = await apiRequest<{ data: { id: string; fileName: string } }>(
        `/api/exception-funds/${encodeURIComponent(refundTarget.value.id)}/refund-proofs`,
        { method: 'POST', body: form })
      refundProofs.value.push(result.data)
    }
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '上传退回凭证失败') }
  finally { uploading.value = false }
}

async function registerRefund() {
  const fund = refundTarget.value
  if (!fund || !props.canRefund || submitting.value) return
  const amountCents = Math.round((refundAmount.value ?? 0) * 100)
  const pendingCents = fund.allocations.filter(item => item.status === '待确认')
    .reduce((sum, item) => sum + item.amountCents, 0)
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > fund.remainingCents - pendingCents) {
    ElMessage.warning('退回金额超过剩余可处理金额'); return
  }
  if (!refundPaidAt.value || !refundProofs.value.length || refundReason.value.trim().length < 5) {
    ElMessage.warning('请填写退回时间、说明并上传凭证'); return
  }
  submitting.value = true
  try {
    await apiRequest(`/api/exception-funds/${encodeURIComponent(fund.id)}/refunds`, {
      method: 'POST', body: JSON.stringify({ amountCents,
        transactionNo: refundTransactionNo.value.trim(), paidAt: new Date(refundPaidAt.value).toISOString(),
        reason: refundReason.value.trim(), proofAssetIds: refundProofs.value.map(item => item.id) }) })
    ElMessage.success('退回已登记，等待收款确认')
    refundTarget.value = undefined
    await refresh()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '登记退回失败') }
  finally { submitting.value = false }
}

async function confirmExternalRefund(fund: Fund, allocationId: string) {
  if (!props.canConfirmRefund || props.role !== 'super_admin' || submitting.value) return
  submitting.value = true
  try {
    await apiRequest(`/api/exception-funds/${encodeURIComponent(fund.id)}/refunds/${encodeURIComponent(allocationId)}/confirm`, {
      method: 'POST', body: JSON.stringify({}) })
    ElMessage.success('已确认非员工退回')
    await refresh()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '确认退回失败') }
  finally { submitting.value = false }
}

async function startTransfer(item: Fund) {
  if (!item.projectId || !props.canTransfer) return
  try {
    const result = await apiRequest<{ data: typeof transferSubscriptions.value }>('/api/subscriptions')
    transferSubscriptions.value = result.data.filter(record => record.projectId === item.projectId
      && record.userId !== 'company' && ['未缴款', '部分缴款'].includes(record.pay))
    transferTarget.value = item
    transferSubscriptionId.value = ''
    transferAmount.value = undefined
    transferReason.value = ''
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '读取认购单失败') }
}

async function registerTransfer() {
  const fund = transferTarget.value
  if (!fund || !props.canTransfer || submitting.value) return
  const amountCents = Math.round((transferAmount.value ?? 0) * 100)
  if (!transferSubscriptionId.value || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    ElMessage.warning('请选择认购单并填写大于零的转入金额'); return
  }
  submitting.value = true
  try {
    await apiRequest(`/api/exception-funds/${encodeURIComponent(fund.id)}/transfers`, {
      method: 'POST', body: JSON.stringify({ subscriptionId: transferSubscriptionId.value,
        amountCents, reason: transferReason.value.trim() }) })
    ElMessage.success('转入已提交公司复核')
    transferTarget.value = undefined
    await refresh()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '转入失败') }
  finally { submitting.value = false }
}

async function reviewTransfer(fund: Fund, allocationId: string, decision: '通过' | '驳回') {
  if (!props.canReviewTransfer || props.role !== 'super_admin' || submitting.value) return
  submitting.value = true
  try {
    await apiRequest(`/api/exception-funds/${encodeURIComponent(fund.id)}/transfers/${encodeURIComponent(allocationId)}/review`, {
      method: 'POST', body: JSON.stringify({ decision }) })
    ElMessage.success(decision === '通过' ? '转入已复核通过' : '转入申请已驳回')
    await refresh()
    emit('updated')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '复核失败') }
  finally { submitting.value = false }
}

async function assignProject() {
  const fund = assignTarget.value
  if (!fund || !props.canAssignProject || submitting.value) return
  submitting.value = true
  try {
    await apiRequest(`/api/exception-funds/${encodeURIComponent(fund.id)}/assign-project`, {
      method: 'POST', body: JSON.stringify({ projectId: assignProjectId.value, reason: assignReason.value.trim() }) })
    ElMessage.success('款项归属已核实')
    assignTarget.value = undefined
    assignProjectId.value = ''; assignReason.value = ''
    await refresh()
    emit('updated')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '核实归属失败') }
  finally { submitting.value = false }
}

async function openProof(assetId: string) {
  try {
    const token = readAccessToken()
    const response = await fetch(`/api/files/${encodeURIComponent(assetId)}/content`, {
      credentials: 'same-origin', headers: token ? { Authorization: `Bearer ${token}` } : undefined
    })
    if (!response.ok) throw new Error('凭证读取失败')
    const url = URL.createObjectURL(await response.blob())
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '凭证读取失败') }
}
</script>

<template>
  <div>
    <header class="page-head"><div><h1>异常款项</h1><p>登记已到账但无法匹配认购单的资金，并跟踪待处理余额。</p></div></header>
    <section class="panel">
      <div class="filters">
        <el-select v-model="filterProjectId" clearable filterable placeholder="全部众筹单">
          <el-option v-for="project in openProjects" :key="project.id" :value="project.id" :label="`${project.title} · ${project.id}`" />
        </el-select>
        <el-select v-model="filterStatus" clearable placeholder="全部状态">
          <el-option value="待处理" label="待处理" /><el-option value="退回待确认" label="退回待确认" />
          <el-option value="转入待复核" label="转入待复核" /><el-option value="已处理" label="已处理" />
        </el-select>
        <el-button @click="refresh">查询</el-button>
      </div>
      <el-table :data="items" v-loading="loading" empty-text="暂无异常款项" style="width:100%">
        <el-table-column prop="id" label="款项编号" min-width="180" />
        <el-table-column label="所属众筹单" min-width="180"><template #default="scope">{{ scope.row.projectId || '待核实' }}</template></el-table-column>
        <el-table-column label="金额 / 已处理 / 剩余" min-width="170"><template #default="scope">{{ money(scope.row.amountCents) }} / {{ money(scope.row.processedCents) }} / {{ money(scope.row.remainingCents) }}</template></el-table-column>
        <el-table-column prop="transactionNo" label="到账流水" min-width="150" />
        <el-table-column prop="bookedAt" label="到账时间" min-width="170" />
        <el-table-column prop="status" label="状态" width="110" />
        <el-table-column label="说明与凭证" min-width="200"><template #default="scope">
          <div>{{ scope.row.sourceNote }}</div>
          <div v-for="assetId in scope.row.proofAssetIds" :key="assetId"><el-button link type="primary" @click="openProof(assetId)">查看凭证</el-button></div>
        </template></el-table-column>
        <el-table-column label="处理" min-width="180"><template #default="scope">
          <el-button v-if="role === 'finance' && canRefund && scope.row.remainingCents > 0" size="small" @click="startRefund(scope.row)">登记退回</el-button>
          <el-button v-if="role === 'finance' && canAssignProject && !scope.row.projectId && scope.row.allocations.length === 0" size="small" @click="assignTarget = scope.row">核实归属</el-button>
          <el-button v-if="role === 'finance' && canTransfer && scope.row.projectId && scope.row.remainingCents > 0" size="small" @click="startTransfer(scope.row)">转入认购单</el-button>
          <div v-for="allocation in scope.row.allocations" :key="allocation.id">
            {{ allocation.kind }} {{ money(allocation.amountCents) }} · {{ allocation.status }}
            <el-button v-if="role === 'super_admin' && canConfirmRefund && allocation.kind === '退回' && allocation.recipientKind === 'external' && allocation.status === '待确认'" link type="primary" :disabled="submitting" @click="confirmExternalRefund(scope.row, allocation.id)">公司确认</el-button>
            <template v-if="role === 'super_admin' && canReviewTransfer && allocation.kind === '转入认购单' && allocation.status === '待确认'"><el-button link type="primary" :disabled="submitting" @click="reviewTransfer(scope.row, allocation.id, '通过')">通过</el-button><el-button link :disabled="submitting" @click="reviewTransfer(scope.row, allocation.id, '驳回')">驳回</el-button></template>
          </div>
        </template></el-table-column>
      </el-table>
      <el-pagination v-model:current-page="page" layout="prev, pager, next, total" :total="total" :page-size="10" />
    </section>
    <section v-if="role === 'finance' && canRegister" class="panel">
      <h2>登记异常款项</h2>
      <el-alert type="warning" :closable="false" title="凭证的金额、流水号和到账时间暂不能可靠自动识别；请对照银行记录人工核验。" />
      <el-form label-width="125px" class="register-form">
        <el-form-item label="所属众筹单"><el-select v-model="projectId" clearable filterable placeholder="尚未核实归属可留空"><el-option v-for="project in openProjects" :key="project.id" :value="project.id" :label="`${project.title} · ${project.id}`" /></el-select></el-form-item>
        <el-form-item label="员工付款人 ID"><el-input v-model="payerUserId" placeholder="非员工付款人留空；员工须填 IAM 用户 ID" /></el-form-item>
        <el-form-item label="到账金额" required><el-input-number v-model="amount" :precision="2" :min="0.01" /></el-form-item>
        <el-form-item label="银行流水号" required><el-input v-model="transactionNo" maxlength="64" /></el-form-item>
        <el-form-item label="到账时间" required><input v-model="bookedAt" type="datetime-local" /></el-form-item>
        <el-form-item label="来源说明" required><el-input v-model="sourceNote" type="textarea" maxlength="200" /></el-form-item>
        <el-form-item label="到账凭证" required><div><input v-if="canUploadProof" type="file" accept="image/png,image/jpeg,image/webp" multiple :disabled="uploading" @change="uploadProofs" /><div v-for="asset in proofs" :key="asset.id">{{ asset.fileName }}</div><small>最多 5 张，每张不超过 10 MB。</small></div></el-form-item>
        <el-form-item label="人工核验说明" required><el-input v-model="manualVerificationNote" type="textarea" maxlength="200" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="submitting" :disabled="uploading || !canUploadProof" @click="register">登记</el-button></el-form-item>
      </el-form>
    </section>
    <section v-if="refundTarget && role === 'finance' && canRefund" class="panel">
      <h2>退回 {{ refundTarget.id }}</h2>
      <p>收款确认人：{{ refundTarget.payerUserId ? `IAM 员工 ${refundTarget.payerUserId}` : '公司（非员工付款人）' }}。剩余 {{ money(refundTarget.remainingCents) }}。</p>
      <el-form label-width="125px" class="register-form">
        <el-form-item label="退回金额" required><el-input-number v-model="refundAmount" :precision="2" :min="0.01" :max="refundTarget.remainingCents / 100" /></el-form-item>
        <el-form-item label="退回流水号" required><el-input v-model="refundTransactionNo" maxlength="64" /></el-form-item>
        <el-form-item label="实际退回时间" required><input v-model="refundPaidAt" type="datetime-local" /></el-form-item>
        <el-form-item label="退回说明" required><el-input v-model="refundReason" type="textarea" maxlength="200" /></el-form-item>
        <el-form-item label="退回凭证" required><div><input v-if="canUploadRefundProof" type="file" accept="image/png,image/jpeg,image/webp" multiple :disabled="uploading" @change="uploadRefundProofs" /><div v-for="asset in refundProofs" :key="asset.id">{{ asset.fileName }}</div></div></el-form-item>
        <el-form-item><el-button type="primary" :loading="submitting" :disabled="uploading || !canUploadRefundProof" @click="registerRefund">登记退回</el-button><el-button @click="refundTarget = undefined">取消</el-button></el-form-item>
      </el-form>
    </section>
    <section v-if="transferTarget && role === 'finance' && canTransfer" class="panel">
      <h2>转入认购单 · {{ transferTarget.id }}</h2>
      <p>剩余 {{ money(transferTarget.remainingCents) }}。须在认购单缴款期限内转入，经公司复核后才计入缴款。</p>
      <el-form label-width="125px" class="register-form">
        <el-form-item label="目标认购单" required><el-select v-model="transferSubscriptionId" filterable placeholder="选择未缴足认购单"><el-option v-for="subscription in transferSubscriptions" :key="subscription.id" :value="subscription.id" :label="`${subscription.id} · 员工 ${subscription.userId} · 应缴 ${subscription.amount} 元 · ${subscription.pay}`" /></el-select></el-form-item>
        <el-form-item label="转入金额" required><el-input-number v-model="transferAmount" :precision="2" :min="0.01" :max="transferTarget.remainingCents / 100" /></el-form-item>
        <el-form-item label="转入说明" required><el-input v-model="transferReason" type="textarea" maxlength="200" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="submitting" @click="registerTransfer">提交公司复核</el-button><el-button @click="transferTarget = undefined">取消</el-button></el-form-item>
      </el-form>
    </section>
    <section v-if="assignTarget && role === 'finance' && canAssignProject" class="panel">
      <h2>核实款项归属 · {{ assignTarget.id }}</h2>
      <el-form label-width="125px" class="register-form">
        <el-form-item label="所属众筹单" required><el-select v-model="assignProjectId" filterable placeholder="选择未结单的众筹单"><el-option v-for="project in openProjects" :key="project.id" :value="project.id" :label="`${project.title} · ${project.id}`" /></el-select></el-form-item>
        <el-form-item label="核实说明" required><el-input v-model="assignReason" type="textarea" maxlength="200" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="submitting" @click="assignProject">确认归属</el-button><el-button @click="assignTarget = undefined">取消</el-button></el-form-item>
      </el-form>
    </section>
  </div>
</template>

<style scoped>
.filters { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:18px; }
.filters .el-select { min-width:190px; }
.register-form { max-width:900px; margin-top:18px; }
.register-form .el-select { width:min(400px,100%); }
small { color:#697586; }
</style>
