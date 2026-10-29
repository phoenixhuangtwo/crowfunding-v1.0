<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { apiRequest } from '../auth/api-client'
import { readAccessToken } from '../auth/session'

type Project = { id: string; title: string; status: string }
type Line = { participantId: string; kind: 'employee' | 'company'; shares: number;
  principalCents: number; profitCents: number; payoutCents: number; status: string;
  payout?: { paidAt: string; proofAssetIds: string[] } }
type PayoutProxyRequest = { id: string; orderId: string; projectId: string; participantId: string;
  reason: string; accountDisabled: boolean; offlineVerificationNote?: string;
  proofAssetIds: string[]; status: string; reviewReason?: string }
type Order = { id: string; projectId: string; status: string; receivableCents: number;
  procurementPaymentCents: number; profitCents: number; confirmedCostsCents: number;
  companyRoundingResidualCents: number; payoutTotalCents: number;
  lines: Line[]; generatedBy: string; rejectReason?: string }
type Cost = { id: string; projectId: string; amountCents: number; transactionNo: string;
  paidAt: string; reason: string; status: string; registeredBy: string; rejectReason?: string }

const props = defineProps<{ projects: Project[]; role: 'finance' | 'super_admin';
  canGenerate: boolean; canApprove: boolean; canReject: boolean; canVoid: boolean;
  canQueryCost: boolean; canRegisterCost: boolean; canUploadCostProof: boolean; canReviewCost: boolean;
  canRegisterPayout: boolean; canUploadPayoutProof: boolean; canReplyPayoutIssue: boolean;
  canQueryFinancialReconciliation: boolean; canClose: boolean;
  canProxyQuery: boolean; canProxyRequest: boolean; canProxyReview: boolean }>()
const emit = defineEmits<{ updated: [] }>()
const projectId = ref('')
const orders = ref<Order[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
const submitting = ref(false)
const expanded = ref('')
const costs = ref<Cost[]>([])
const costProjectId = ref('')
const costAmount = ref<number>()
const costTransactionNo = ref('')
const costPaidAt = ref('')
const costReason = ref('')
const costProofs = ref<Array<{ id: string; fileName: string }>>([])
const costUploading = ref(false)
const payoutTarget = ref<{ order: Order; line: Line }>()
const payoutTransactionNo = ref('')
const payoutAt = ref('')
const payoutNote = ref('')
const payoutProofs = ref<Array<{ id: string; fileName: string }>>([])
const payoutUploading = ref(false)
const companyTransferConfirmed = ref(false)
const reconciliation = ref<Record<string, number | boolean | string>>()
const proxyRequests = ref<PayoutProxyRequest[]>([])
const proxyTarget = ref<{ order: Order; line: Line }>()
const proxyReason = ref('')
const proxyAccountDisabled = ref(false)
const proxyOfflineNote = ref('')
const eligible = computed(() => props.projects.filter(item => item.status === '待分配'))
const costEligible = computed(() => props.projects.filter(item => ['待回款', '回款中', '待分配'].includes(item.status)))
const money = (cents: number) => `¥ ${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

watch(eligible, items => {
  if (!projectId.value) projectId.value = items[0]?.id ?? ''
}, { immediate: true })
watch(costEligible, items => {
  if (!items.some(item => item.id === costProjectId.value)) costProjectId.value = items[0]?.id ?? ''
}, { immediate: true })
watch(costProjectId, () => { costProofs.value = [] })
watch([projectId, page], () => { void refresh() }, { immediate: true })
watch(projectId, () => { reconciliation.value = undefined })

async function refresh() {
  loading.value = true
  try {
    const query = new URLSearchParams({ page: String(page.value), pageSize: '10' })
    if (projectId.value) query.set('projectId', projectId.value)
    const response = await apiRequest<{ data: { items: Order[]; total: number } }>(`/api/distribution-orders?${query}`)
    orders.value = response.data.items
    total.value = response.data.total
    if (props.canProxyQuery) {
      const result = await apiRequest<{ data: PayoutProxyRequest[] }>(
        `/api/distribution-payout-proxy-requests${projectId.value ? `?projectId=${encodeURIComponent(projectId.value)}` : ''}`)
      proxyRequests.value = result.data
    }
    if (props.canQueryCost) {
      const result = await apiRequest<{ data: Cost[] }>('/api/confirmed-costs')
      costs.value = result.data
    }
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '读取分配单失败') }
  finally { loading.value = false }
}

async function loadReconciliation() {
  if (!projectId.value || !props.canQueryFinancialReconciliation) return
  try {
    const result = await apiRequest<{ data: Record<string, number | boolean | string> }>(
      `/api/projects/${encodeURIComponent(projectId.value)}/financial-reconciliation`)
    reconciliation.value = result.data
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '结单前对账失败') }
}

async function uploadCostProofs(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!costProjectId.value || !files.length || !props.canUploadCostProof) return
  if (costProofs.value.length + files.length > 5) { ElMessage.warning('最多上传 5 张成本凭证'); return }
  costUploading.value = true
  try {
    for (const file of files) {
      const form = new FormData()
      form.set('image', file)
      const response = await apiRequest<{ data: { id: string; fileName: string } }>(
        `/api/projects/${encodeURIComponent(costProjectId.value)}/confirmed-cost-proofs`,
        { method: 'POST', body: form })
      costProofs.value.push(response.data)
    }
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '成本凭证上传失败') }
  finally { costUploading.value = false }
}

async function registerCost() {
  if (!props.canRegisterCost || !costProjectId.value || submitting.value) return
  if (!costProofs.value.length) { ElMessage.warning('请上传成本凭证'); return }
  if (!costPaidAt.value) { ElMessage.warning('请选择实际付款时间'); return }
  submitting.value = true
  try {
    await apiRequest('/api/confirmed-costs', { method: 'POST', body: JSON.stringify({
      projectId: costProjectId.value, amountCents: Math.round((costAmount.value ?? 0) * 100),
      transactionNo: costTransactionNo.value.trim(), paidAt: new Date(costPaidAt.value).toISOString(),
      proofAssetIds: costProofs.value.map(item => item.id), reason: costReason.value.trim()
    }) })
    ElMessage.success('其他成本已提交公司复核')
    costAmount.value = undefined
    costTransactionNo.value = ''
    costPaidAt.value = ''
    costReason.value = ''
    costProofs.value = []
    await refresh()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '成本登记失败') }
  finally { submitting.value = false }
}

async function reviewCost(cost: Cost, decision: '通过' | '驳回') {
  if (!props.canReviewCost || cost.status !== '待公司复核' || submitting.value) return
  let reason = ''
  try {
    if (decision === '驳回') {
      const result = await ElMessageBox.prompt('填写 5 至 200 字驳回原因', '公司复核成本', { inputType: 'textarea' })
      reason = result.value.trim()
    } else await ElMessageBox.confirm('已核对成本凭证、银行流水及金额，确认计入实际分配利润？', '公司复核成本', { type: 'warning' })
  } catch { return }
  submitting.value = true
  try {
    await apiRequest(`/api/confirmed-costs/${encodeURIComponent(cost.id)}/review`, {
      method: 'POST', body: JSON.stringify({ decision, reason }) })
    ElMessage.success(decision === '通过' ? '成本已确认' : '成本已驳回')
    await refresh()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '成本复核失败') }
  finally { submitting.value = false }
}

function openPayout(order: Order, line: Line) {
  payoutTarget.value = { order, line }
  payoutTransactionNo.value = ''
  payoutAt.value = ''
  payoutNote.value = ''
  payoutProofs.value = []
  companyTransferConfirmed.value = false
}

async function uploadPayoutProofs(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  const target = payoutTarget.value
  if (!target || !props.canUploadPayoutProof || !files.length) return
  if (payoutProofs.value.length + files.length > 5) { ElMessage.warning('最多上传 5 张打款凭证'); return }
  payoutUploading.value = true
  try {
    for (const file of files) {
      const form = new FormData()
      form.set('image', file)
      const response = await apiRequest<{ data: { id: string; fileName: string } }>(
        `/api/distribution-orders/${encodeURIComponent(target.order.id)}/lines/${encodeURIComponent(target.line.participantId)}/proofs`,
        { method: 'POST', body: form })
      payoutProofs.value.push(response.data)
    }
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '打款凭证上传失败') }
  finally { payoutUploading.value = false }
}

async function registerPayout() {
  const target = payoutTarget.value
  if (!target || !props.canRegisterPayout || submitting.value) return
  if (!payoutAt.value) { ElMessage.warning('请选择实际打款时间'); return }
  if (target.line.kind === 'employee' && !payoutProofs.value.length) { ElMessage.warning('请上传员工打款凭证'); return }
  submitting.value = true
  try {
    await apiRequest(`/api/distribution-orders/${encodeURIComponent(target.order.id)}/lines/${encodeURIComponent(target.line.participantId)}/payout`, {
      method: 'POST', body: JSON.stringify({ amountCents: target.line.payoutCents,
        paidAt: new Date(payoutAt.value).toISOString(), transactionNo: payoutTransactionNo.value.trim(),
        proofAssetIds: payoutProofs.value.map(item => item.id), note: payoutNote.value.trim(),
        companyTransferConfirmed: companyTransferConfirmed.value })
    })
    ElMessage.success(target.line.kind === 'company' ? '公司内部结转已记录' : '员工打款已登记，等待员工确认')
    payoutTarget.value = undefined
    await refresh()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '打款登记失败') }
  finally { submitting.value = false }
}

async function replyIssue(order: Order, line: Line) {
  if (!props.canReplyPayoutIssue || submitting.value) return
  let reply = ''
  try {
    const result = await ElMessageBox.prompt('请填写 5 至 200 字核对结果；若需要补差打款，请先处理补差流程。',
      '处理收款异议', { inputType: 'textarea' })
    reply = result.value.trim()
  } catch { return }
  submitting.value = true
  try {
    await apiRequest(`/api/distribution-orders/${encodeURIComponent(order.id)}/lines/${encodeURIComponent(line.participantId)}/issue-reply`, {
      method: 'POST', body: JSON.stringify({ reply }) })
    ElMessage.success('异议已回复，等待员工重新确认')
    await refresh()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '异议回复失败') }
  finally { submitting.value = false }
}

async function generate() {
  if (!projectId.value || !props.canGenerate || submitting.value) return
  try {
    await ElMessageBox.confirm('将根据已复核回款、已登记采购付款、已确认成本与认购份数生成不可编辑的分配快照，确认继续？',
      '生成分配单', { type: 'warning' })
  } catch { return }
  submitting.value = true
  try {
    await apiRequest(`/api/projects/${encodeURIComponent(projectId.value)}/distribution-orders`, {
      method: 'POST', body: '{}' })
    ElMessage.success('分配单已生成，请审批')
    await refresh()
    emit('updated')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '生成分配单失败') }
  finally { submitting.value = false }
}

async function act(order: Order, action: 'approve' | 'reject' | 'void') {
  if (submitting.value) return
  let reason = ''
  try {
    if (action === 'reject') {
      const prompt = await ElMessageBox.prompt('请输入 5 至 200 字驳回原因', '驳回分配单', { inputType: 'textarea' })
      reason = prompt.value.trim()
    } else {
      await ElMessageBox.confirm(action === 'approve'
        ? '审批通过后分配结果不可撤销，且付款登记人与审批人必须不同，确认继续？'
        : '作废后允许重新生成分配单，确认继续？', action === 'approve' ? '审批分配单' : '作废分配单',
      { type: 'warning' })
    }
  } catch { return }
  submitting.value = true
  try {
    await apiRequest(`/api/distribution-orders/${encodeURIComponent(order.id)}/${action}`, {
      method: 'POST', body: JSON.stringify({ reason }) })
    ElMessage.success(action === 'approve' ? '审批通过' : action === 'reject' ? '已驳回' : '已作废')
    await refresh()
    emit('updated')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '处理分配单失败') }
  finally { submitting.value = false }
}

async function submitProxy() {
  const target = proxyTarget.value
  if (!target || !props.canProxyRequest || submitting.value) return
  submitting.value = true
  try {
    const result = await apiRequest<{ message: string }>(
      `/api/distribution-orders/${encodeURIComponent(target.order.id)}/lines/${encodeURIComponent(target.line.participantId)}/proxy-confirm`, {
        method: 'POST', body: JSON.stringify({ reason: proxyReason.value.trim(),
          accountDisabled: proxyAccountDisabled.value,
          offlineVerificationNote: proxyOfflineNote.value.trim() }) })
    ElMessage.success(result.message)
    proxyTarget.value = undefined; proxyReason.value = ''; proxyAccountDisabled.value = false; proxyOfflineNote.value = ''
    await refresh(); emit('updated')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '代确认申请失败') }
  finally { submitting.value = false }
}
async function reviewProxy(item: PayoutProxyRequest, action: 'approve' | 'reject') {
  let reason = ''
  try {
    if (action === 'approve') await ElMessageBox.confirm('已核实原打款凭证、超期时间和收款对象，确认代员工确认收款？', '公司复核代确认', { type: 'warning' })
    else reason = (await ElMessageBox.prompt('请输入 5 至 200 字驳回原因', '驳回代确认', { inputType: 'textarea' })).value.trim()
  } catch { return }
  if (action === 'reject' && (reason.length < 5 || reason.length > 200)) { ElMessage.warning('驳回原因须为 5 至 200 字'); return }
  submitting.value = true
  try {
    const result = await apiRequest<{ message: string }>(
      `/api/distribution-payout-proxy-requests/${encodeURIComponent(item.id)}/review`, {
        method: 'POST', body: JSON.stringify({ action, reason }) })
    ElMessage.success(result.message); await refresh(); emit('updated')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '代确认复核失败') }
  finally { submitting.value = false }
}
async function openProxyProof(assetId: string) {
  try {
    const token = readAccessToken()
    const response = await fetch(`/api/files/${encodeURIComponent(assetId)}/content`, {
      credentials: 'same-origin', headers: token ? { Authorization: `Bearer ${token}` } : undefined })
    if (!response.ok) throw new Error('凭证读取失败')
    const url = URL.createObjectURL(await response.blob())
    window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '凭证读取失败') }
}

async function closeOrder(order: Order) {
  if (!props.canClose || order.status !== '可结单' || submitting.value) return
  try {
    await ElMessageBox.confirm('结单后不可再修改分配结果，确认结单？', '结单确认', { type: 'warning' })
  } catch { return }
  submitting.value = true
  try {
    await apiRequest(`/api/distribution-orders/${encodeURIComponent(order.id)}/close`, {
      method: 'POST', body: JSON.stringify({}) })
    ElMessage.success('结单成功')
    reconciliation.value = undefined
    await refresh()
    emit('updated')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '结单失败') }
  finally { submitting.value = false }
}
</script>

<template>
  <div>
    <header class="page-head"><div><h1>利润分配</h1><p>以实际回款和已确认成本为依据，按认购份数生成分配快照。</p></div></header>
    <section class="panel">
      <el-alert title="利润按已复核客户回款＋公司补款－补款返还－超额差异－采购实付－已确认其他成本计算；份额利润向下取整，尾差归公司。审批后仍须逐笔登记打款并由员工确认。" type="info" :closable="false" />
      <div class="toolbar"><el-select v-model="projectId" filterable clearable placeholder="全部众筹单"><el-option v-for="item in projects" :key="item.id" :value="item.id" :label="`${item.title} · ${item.id}`" /></el-select><el-button @click="refresh">查询</el-button><el-button v-if="canGenerate && projectId && eligible.some(item => item.id === projectId)" type="primary" :loading="submitting" @click="generate">生成分配单</el-button><el-button v-if="canQueryFinancialReconciliation && projectId" @click="loadReconciliation">结单前对账</el-button></div>
      <div v-if="reconciliation" class="reconciliation"><el-alert :title="reconciliation.closeReady ? '各层对账相符，满足已实现的结单校验条件' : '对账未通过，请核对下列差额和待处理项目'" :type="reconciliation.closeReady ? 'success' : 'warning'" :closable="false" /><div class="reconciliation-grid"><div>付款前资金差额：{{ money(Number(reconciliation.fundingDifferenceCents)) }}</div><div>采购付款差额：{{ money(Number(reconciliation.purchaseDifferenceCents)) }}</div><div>回款缺口：{{ money(Number(reconciliation.receiptGapCents)) }}</div><div>未处理回款差异：{{ money(Number(reconciliation.unresolvedReceiptDifferenceCents)) }}</div><div>成本台账差额：{{ money(Number(reconciliation.costLedgerDifferenceCents)) }}</div><div>分配差额：{{ money(Number(reconciliation.distributionDifferenceCents)) }}</div><div>打款台账差额：{{ money(Number(reconciliation.payoutDifferenceCents)) }}</div><div>未处理异常款项：{{ money(Number(reconciliation.unprocessedExceptionCents)) }}</div></div></div>
      <el-table :data="orders" v-loading="loading" empty-text="暂无分配单" style="width:100%">
        <el-table-column prop="projectId" label="众筹单编号" min-width="190" />
        <el-table-column label="应收" width="140"><template #default="scope">{{ money(scope.row.receivableCents) }}</template></el-table-column>
        <el-table-column label="实际利润" width="140"><template #default="scope">{{ money(scope.row.profitCents) }}</template></el-table-column>
        <el-table-column label="所得合计" width="140"><template #default="scope">{{ money(scope.row.payoutTotalCents) }}</template></el-table-column>
        <el-table-column label="公司尾差" width="120"><template #default="scope">{{ money(scope.row.companyRoundingResidualCents) }}</template></el-table-column>
        <el-table-column prop="status" label="状态" width="100" />
        <el-table-column label="操作" min-width="270"><template #default="scope"><el-button size="small" @click="expanded = expanded === scope.row.id ? '' : scope.row.id">明细</el-button><el-button v-if="scope.row.status === '待审批' && canApprove" size="small" type="primary" :disabled="submitting" @click="act(scope.row, 'approve')">审批通过</el-button><el-button v-if="scope.row.status === '待审批' && canReject" size="small" :disabled="submitting" @click="act(scope.row, 'reject')">驳回</el-button><el-button v-if="['待审批', '已驳回'].includes(scope.row.status) && canVoid" size="small" :disabled="submitting" @click="act(scope.row, 'void')">作废</el-button><el-button v-if="scope.row.status === '可结单' && canClose" size="small" type="primary" :disabled="submitting" @click="closeOrder(scope.row)">结单</el-button></template></el-table-column>
      </el-table>
      <el-pagination v-model:current-page="page" :page-size="10" :total="total" layout="prev, pager, next, total" />
      <template v-for="order in orders" :key="order.id"><section v-if="expanded === order.id" class="details"><h2>分配明细 · {{ order.id }}</h2><p>已确认其他成本 {{ money(order.confirmedCostsCents) }}；审批前须核对实际成本是否已全部入账。</p><el-table :data="order.lines"><el-table-column label="认购主体"><template #default="scope">{{ scope.row.kind === 'company' ? '公司' : scope.row.participantId }}</template></el-table-column><el-table-column prop="shares" label="份数" /><el-table-column label="本金"><template #default="scope">{{ money(scope.row.principalCents) }}</template></el-table-column><el-table-column label="利润"><template #default="scope">{{ money(scope.row.profitCents) }}</template></el-table-column><el-table-column label="所得"><template #default="scope">{{ money(scope.row.payoutCents) }}</template></el-table-column><el-table-column prop="status" label="明细状态" /><el-table-column v-if="canRegisterPayout || canReplyPayoutIssue || canProxyRequest" label="操作" width="180"><template #default="scope"><el-button v-if="canRegisterPayout && scope.row.status === '待登记打款' && ['已审批', '打款登记中'].includes(order.status)" size="small" type="primary" @click="openPayout(order, scope.row)">登记打款</el-button><el-button v-if="canReplyPayoutIssue && scope.row.status === '有异议'" size="small" @click="replyIssue(order, scope.row)">回复异议</el-button><el-button v-if="canProxyRequest && scope.row.kind === 'employee' && scope.row.status === '待员工确认'" size="small" @click="proxyTarget = { order, line: scope.row }">申请代确认</el-button></template></el-table-column></el-table></section></template>
    </section>
    <section v-if="canQueryCost" class="panel">
      <h2>其他已确认成本</h2>
      <el-alert title="其他成本经公司复核后才计入实际利润。存在待复核成本时不能生成或审批分配单。" type="info" :closable="false" />
      <el-table :data="costs" empty-text="暂无其他成本记录" style="width:100%;margin-top:16px">
        <el-table-column prop="projectId" label="众筹单" min-width="170" />
        <el-table-column label="金额" width="130"><template #default="scope">{{ money(scope.row.amountCents) }}</template></el-table-column>
        <el-table-column prop="transactionNo" label="付款流水号" min-width="160" />
        <el-table-column prop="reason" label="成本原因" min-width="180" />
        <el-table-column prop="status" label="状态" width="110" />
        <el-table-column v-if="role === 'super_admin' && canReviewCost" label="公司复核" min-width="160"><template #default="scope"><template v-if="scope.row.status === '待公司复核'"><el-button size="small" type="primary" :disabled="submitting" @click="reviewCost(scope.row, '通过')">通过</el-button><el-button size="small" :disabled="submitting" @click="reviewCost(scope.row, '驳回')">驳回</el-button></template><span v-else-if="scope.row.rejectReason">{{ scope.row.rejectReason }}</span></template></el-table-column>
      </el-table>
      <el-form v-if="role === 'finance' && canRegisterCost" label-width="125px" class="cost-form">
        <h3>登记实际发生的其他成本</h3>
        <el-form-item label="众筹单" required><el-select v-model="costProjectId" filterable><el-option v-for="item in costEligible" :key="item.id" :value="item.id" :label="`${item.title} · ${item.id}`" /></el-select></el-form-item>
        <el-form-item label="成本金额" required><el-input-number v-model="costAmount" :min="0.01" :precision="2" /></el-form-item>
        <el-form-item label="付款流水号" required><el-input v-model="costTransactionNo" maxlength="64" /></el-form-item>
        <el-form-item label="付款时间" required><input v-model="costPaidAt" type="datetime-local" /></el-form-item>
        <el-form-item label="付款凭证" required><div><input v-if="canUploadCostProof" type="file" accept="image/png,image/jpeg,image/webp" multiple :disabled="costUploading || !costProjectId" @change="uploadCostProofs" /><div v-for="item in costProofs" :key="item.id">{{ item.fileName }}</div><small>最多 5 张，每张不超过 10 MB。</small></div></el-form-item>
        <el-form-item label="成本原因" required><el-input v-model="costReason" type="textarea" maxlength="200" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="submitting" :disabled="costUploading || !canUploadCostProof" @click="registerCost">提交公司复核</el-button></el-form-item>
      </el-form>
    </section>
    <section v-if="canProxyQuery" class="panel"><h2>分配收款代确认申请</h2><el-table :data="proxyRequests" empty-text="暂无代确认申请" style="width:100%"><el-table-column prop="orderId" label="分配单" min-width="155" /><el-table-column prop="participantId" label="员工" width="110" /><el-table-column prop="reason" label="申请原因" min-width="180" /><el-table-column prop="offlineVerificationNote" label="线下核实记录" min-width="160" /><el-table-column prop="status" label="状态" width="110" /><el-table-column label="原打款凭证" width="115"><template #default="scope"><el-button v-for="id in scope.row.proofAssetIds" :key="id" link type="primary" @click="openProxyProof(id)">查看</el-button></template></el-table-column><el-table-column v-if="canProxyReview" label="操作" width="130"><template #default="scope"><template v-if="scope.row.status === '待公司复核'"><el-button link type="primary" :disabled="submitting" @click="reviewProxy(scope.row, 'approve')">通过</el-button><el-button link type="danger" :disabled="submitting" @click="reviewProxy(scope.row, 'reject')">驳回</el-button></template></template></el-table-column></el-table></section>
    <el-dialog :model-value="Boolean(proxyTarget)" title="申请分配收款代确认" width="620px" @update:model-value="(value: boolean) => { if (!value) proxyTarget = undefined }"><template v-if="proxyTarget"><p>员工：{{ proxyTarget.line.participantId }}；原打款金额：{{ money(proxyTarget.line.payoutCents) }}。仅在原打款满超期天数并留有凭证时可申请。</p><el-form label-width="125px"><el-form-item label="申请原因" required><el-input v-model="proxyReason" type="textarea" maxlength="200" /></el-form-item><el-form-item label="员工账号停用"><el-checkbox v-model="proxyAccountDisabled">已停用或离职</el-checkbox></el-form-item><el-form-item v-if="proxyAccountDisabled" label="线下核实记录" required><el-input v-model="proxyOfflineNote" type="textarea" maxlength="200" /></el-form-item></el-form></template><template #footer><el-button @click="proxyTarget = undefined">取消</el-button><el-button type="primary" :loading="submitting" @click="submitProxy">提交公司复核</el-button></template></el-dialog>
    <el-dialog :model-value="Boolean(payoutTarget)" title="登记分配打款" width="620px" @update:model-value="(value: boolean) => { if (!value) payoutTarget = undefined }">
      <template v-if="payoutTarget">
        <p>认购主体：{{ payoutTarget.line.kind === 'company' ? '公司' : payoutTarget.line.participantId }}；应登记金额：{{ money(payoutTarget.line.payoutCents) }}</p>
        <el-form label-width="125px">
          <el-form-item label="实际打款时间" required><input v-model="payoutAt" type="datetime-local" /></el-form-item>
          <template v-if="payoutTarget.line.kind === 'employee'">
            <el-form-item label="银行流水号" required><el-input v-model="payoutTransactionNo" maxlength="64" /></el-form-item>
            <el-form-item label="打款凭证" required><div><input v-if="canUploadPayoutProof" type="file" accept="image/png,image/jpeg,image/webp" multiple :disabled="payoutUploading" @change="uploadPayoutProofs" /><div v-for="item in payoutProofs" :key="item.id">{{ item.fileName }}</div><small>最多 5 张，每张不超过 10 MB。</small></div></el-form-item>
            <el-form-item label="人工核对说明" required><el-input v-model="payoutNote" type="textarea" maxlength="500" placeholder="说明凭证与实际银行流水的核对情况" /></el-form-item>
          </template>
          <el-form-item v-else label="内部结转确认" required><el-checkbox v-model="companyTransferConfirmed">已核对公司内部结转金额</el-checkbox></el-form-item>
        </el-form>
      </template>
      <template #footer><el-button @click="payoutTarget = undefined">取消</el-button><el-button type="primary" :loading="submitting" :disabled="payoutUploading" @click="registerPayout">确认登记</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.toolbar { display:flex; gap:12px; align-items:center; margin:18px 0; flex-wrap:wrap; }
.toolbar .el-select { width:min(360px, 100%); }
.details { margin-top:20px; padding:18px; background:#f7f9fc; border-radius:8px; }
.cost-form { max-width:800px; margin-top:20px; }
.reconciliation { margin:16px 0; }
.reconciliation-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin-top:12px; }
</style>
