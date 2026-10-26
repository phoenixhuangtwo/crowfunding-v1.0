<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { apiRequest } from '../auth/api-client'
import { readAccessToken } from '../auth/session'

type Project = { id: string; title: string; status: string; salesAmount?: number }
type Line = { projectId: string; amountCents: number }
type Batch = { id: string; kind: '客户回款' | '公司补款'; transactionNo: string; bookedAt: string;
  totalCents: number; lines: Line[]; proofAssetIds: string[]; registeredBy: string; reason?: string;
  status: '待复核' | '已通过' | '已驳回'; note?: string; returns?: Line[]; rejectReason?: string }
type Summary = { receivableCents: number; distributableCents: number; companyBalanceCents: number;
  gapCents: number; excessCents: number; companyReturnsCents: number; handledCents: number;
  unresolvedCents: number; differences: Array<{ id: string; amountCents: number; destination: string;
    reason: string; refundTransactionNo?: string }> }

const props = defineProps<{ projects: Project[]; role: 'finance' | 'super_admin';
  canRegister: boolean; canUploadProof: boolean; canReview: boolean; canRegisterDifference: boolean }>()
const emit = defineEmits<{ updated: [] }>()
const eligible = computed(() => props.projects.filter(project => ['待回款', '回款中', '待分配'].includes(project.status)))
const projectId = ref('')
const filterKind = ref('')
const filterStatus = ref('')
const page = ref(1)
const items = ref<Batch[]>([])
const total = ref(0)
const summary = ref<Summary>()
const loading = ref(false)
const submitting = ref(false)
const kind = ref<'客户回款' | '公司补款'>('客户回款')
const lines = ref<Array<{ projectId: string; amount: number | undefined }>>([{ projectId: '', amount: undefined }])
const transactionNo = ref('')
const bookedAt = ref('')
const reason = ref('')
const note = ref('')
const proofs = ref<Array<{ id: string; fileName: string }>>([])
const uploading = ref(false)
const differenceAmount = ref<number>()
const differenceDestination = ref<'退回客户' | '计入公司'>('退回客户')
const differenceReason = ref('')
const refundTransactionNo = ref('')
const money = (value: number) => `¥ ${(value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const lineTotal = computed(() => lines.value.reduce((sum, line) => sum + Math.round((line.amount ?? 0) * 100), 0))
const canReviewBatch = (batch: Batch) => props.canReview && batch.status === '待复核'
  && (batch.kind === '客户回款' ? props.role === 'finance' : props.role === 'super_admin')

watch(eligible, options => {
  if (!options.some(item => item.id === projectId.value)) projectId.value = options[0]?.id ?? ''
}, { immediate: true })
watch(projectId, () => {
  page.value = 1
  lines.value = [{ projectId: projectId.value, amount: undefined }]
  proofs.value = []
  void refresh()
})
watch([filterKind, filterStatus], () => { page.value = 1; void refresh() })

async function refresh() {
  loading.value = true
  try {
    const query = new URLSearchParams({ page: String(page.value), pageSize: '10' })
    if (projectId.value) query.set('projectId', projectId.value)
    if (filterKind.value) query.set('kind', filterKind.value)
    if (filterStatus.value) query.set('status', filterStatus.value)
    const response = await apiRequest<{ data: { items: Batch[]; total: number } }>(`/api/receipt-batches?${query}`)
    items.value = response.data.items
    total.value = response.data.total
    if (projectId.value) {
      const result = await apiRequest<{ data: Summary }>(`/api/projects/${encodeURIComponent(projectId.value)}/receipt-summary`)
      summary.value = result.data
    } else summary.value = undefined
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '读取回款失败') }
  finally { loading.value = false }
}

async function uploadProofs(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  const anchor = lines.value[0]?.projectId
  if (!anchor || !files.length || !props.canUploadProof) return
  if (proofs.value.length + files.length > 5) { ElMessage.warning('一笔流水最多 5 张凭证'); return }
  uploading.value = true
  try {
    for (const file of files) {
      const form = new FormData()
      form.set('image', file)
      const response = await apiRequest<{ data: { id: string; fileName: string } }>(
        `/api/projects/${encodeURIComponent(anchor)}/receipt-proofs`, { method: 'POST', body: form })
      proofs.value.push(response.data)
    }
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '上传回款凭证失败') }
  finally { uploading.value = false }
}

async function register() {
  if (!props.canRegister || submitting.value) return
  const normalized = lines.value.map(line => ({ projectId: line.projectId, amountCents: Math.round((line.amount ?? 0) * 100) }))
  if (!normalized.length || normalized.some(line => !line.projectId || line.amountCents <= 0)) { ElMessage.warning('请选择众筹单并填写大于零的金额'); return }
  if (!proofs.value.length) { ElMessage.warning('请上传回款凭证'); return }
  if (!bookedAt.value) { ElMessage.warning('请选择到账时间'); return }
  if (note.value.trim().length < 5) { ElMessage.warning('请填写至少 5 字人工核对说明'); return }
  submitting.value = true
  try {
    await apiRequest('/api/receipt-batches', { method: 'POST', body: JSON.stringify({ kind: kind.value,
      transactionNo: transactionNo.value.trim(), bookedAt: new Date(bookedAt.value).toISOString(),
      totalCents: lineTotal.value, lines: normalized, proofAssetIds: proofs.value.map(item => item.id),
      recognitionFailed: true, note: note.value.trim(), reason: reason.value.trim() }) })
    ElMessage.success(kind.value === '公司补款' ? '补款已提交公司复核' : '回款已登记，待财务复核')
    proofs.value = []
    transactionNo.value = ''
    bookedAt.value = ''
    reason.value = ''
    note.value = ''
    lines.value = [{ projectId: projectId.value, amount: undefined }]
    await refresh()
    emit('updated')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '登记失败') }
  finally { submitting.value = false }
}

async function review(batch: Batch, decision: '通过' | '驳回') {
  if (!canReviewBatch(batch)) return
  let reasonText = ''
  let actualBankCents: number | undefined
  let actualBankTransactionNo: string | undefined
  try {
    if (decision === '驳回') {
      const result = await ElMessageBox.prompt('填写 5 至 200 字驳回原因', '驳回回款', { inputType: 'textarea' })
      reasonText = result.value.trim()
    } else {
      const result = await ElMessageBox.prompt(`请核对银行实际到账金额，登记金额 ${money(batch.totalCents)}。输入实际到账金额（元）：`,
        '复核回款', { inputValue: (batch.totalCents / 100).toFixed(2) })
      if (!/^\d+(?:\.\d{1,2})?$/.test(result.value.trim())) { ElMessage.warning('实际到账金额格式无效'); return }
      actualBankCents = Math.round(Number(result.value.trim()) * 100)
      const number = await ElMessageBox.prompt('请对照银行流水输入实际流水号', '复核回款', { inputValue: batch.transactionNo })
      actualBankTransactionNo = number.value.trim()
      await ElMessageBox.confirm('已核对凭证图片、银行到账金额及流水号，确认复核通过？', '复核回款', { type: 'warning' })
    }
  } catch { return }
  submitting.value = true
  try {
    await apiRequest(`/api/receipt-batches/${encodeURIComponent(batch.id)}/review`, { method: 'POST',
      body: JSON.stringify({ decision, reason: reasonText, actualBankCents, actualBankTransactionNo }) })
    ElMessage.success(decision === '通过' ? '复核通过' : '已驳回')
    await refresh()
    emit('updated')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '复核失败') }
  finally { submitting.value = false }
}

async function openProof(assetId: string) {
  try {
    const token = readAccessToken()
    const response = await fetch(`/api/files/${encodeURIComponent(assetId)}/content`, {
      credentials: 'same-origin', headers: token ? { Authorization: `Bearer ${token}` } : undefined
    })
    if (!response.ok) throw new Error('凭证读取失败，请刷新登录后重试')
    const url = URL.createObjectURL(await response.blob())
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '凭证读取失败') }
}

async function registerDifference() {
  if (!projectId.value || !props.canRegisterDifference || submitting.value) return
  const amountCents = Math.round((differenceAmount.value ?? 0) * 100)
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > (summary.value?.unresolvedCents ?? 0)) {
    ElMessage.warning('登记金额须在待处理差异范围内'); return
  }
  submitting.value = true
  try {
    await apiRequest(`/api/projects/${encodeURIComponent(projectId.value)}/receipt-differences`, {
      method: 'POST', body: JSON.stringify({ amountCents, destination: differenceDestination.value,
        reason: differenceReason.value.trim(), refundTransactionNo: differenceDestination.value === '退回客户'
          ? refundTransactionNo.value.trim() : undefined })
    })
    ElMessage.success('差异去向已登记')
    differenceAmount.value = undefined
    differenceReason.value = ''
    refundTransactionNo.value = ''
    await refresh()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '差异登记失败') }
  finally { submitting.value = false }
}
</script>

<template>
  <div>
    <header class="page-head"><div><h1>客户回款</h1><p>分批登记客户回款与公司补款，复核后计入资金台账。</p></div></header>
    <section class="panel">
      <div class="filters">
        <el-select v-model="projectId" filterable clearable placeholder="全部众筹单"><el-option v-for="item in eligible" :key="item.id" :value="item.id" :label="`${item.title} · ${item.id}`" /></el-select>
        <el-select v-model="filterKind" clearable placeholder="全部类型"><el-option value="客户回款" label="客户回款" /><el-option value="公司补款" label="公司补款" /></el-select>
        <el-select v-model="filterStatus" clearable placeholder="全部状态"><el-option value="待复核" label="待复核" /><el-option value="已通过" label="已通过" /><el-option value="已驳回" label="已驳回" /></el-select>
        <el-button @click="refresh">查询</el-button>
      </div>
      <div v-if="summary" class="summary">
        <div>应收 <strong>{{ money(summary.receivableCents) }}</strong></div>
        <div>累计已复核 <strong>{{ money(summary.distributableCents) }}</strong></div>
        <div>缺口 <strong>{{ money(summary.gapCents) }}</strong></div>
        <div>公司补款余额 <strong>{{ money(summary.companyBalanceCents) }}</strong></div>
        <div>超额差异 <strong>{{ money(summary.excessCents) }}</strong></div>
        <div>待处理差异 <strong>{{ money(summary.unresolvedCents) }}</strong></div>
      </div>
      <el-table :data="items" v-loading="loading" empty-text="暂无回款记录" style="width: 100%">
        <el-table-column label="众筹单 / 本笔金额" min-width="220"><template #default="scope"><div v-for="line in scope.row.lines" :key="line.projectId">{{ line.projectId }} · {{ money(line.amountCents) }}</div></template></el-table-column>
        <el-table-column prop="kind" label="类型" width="100" /><el-table-column prop="transactionNo" label="流水号" min-width="150" />
        <el-table-column prop="bookedAt" label="到账时间" min-width="170" /><el-table-column prop="status" label="状态" width="90" />
        <el-table-column label="凭证 / 复核" min-width="190"><template #default="scope"><div v-for="assetId in scope.row.proofAssetIds" :key="assetId"><el-button link type="primary" @click="openProof(assetId)">查看凭证</el-button></div><small>{{ scope.row.note }}</small><div v-if="scope.row.returns?.length">自动补款返还 {{ money(scope.row.returns.reduce((sum: number, line: Line) => sum + line.amountCents, 0)) }}</div><div v-if="scope.row.rejectReason">驳回：{{ scope.row.rejectReason }}</div><div v-if="canReviewBatch(scope.row)"><el-button size="small" type="primary" :disabled="submitting" @click="review(scope.row, '通过')">通过</el-button><el-button size="small" :disabled="submitting" @click="review(scope.row, '驳回')">驳回</el-button></div></template></el-table-column>
      </el-table>
      <el-pagination v-model:current-page="page" layout="prev, pager, next, total" :total="total" :page-size="10" @current-change="refresh" />
    </section>
    <section v-if="summary?.excessCents" class="panel">
      <h2>差异去向</h2>
      <el-table :data="summary.differences" empty-text="暂无差异去向登记">
        <el-table-column prop="destination" label="去向" width="110" />
        <el-table-column label="金额" width="140"><template #default="scope">{{ money(scope.row.amountCents) }}</template></el-table-column>
        <el-table-column prop="refundTransactionNo" label="退款流水号" min-width="160" />
        <el-table-column prop="reason" label="说明" min-width="200" />
      </el-table>
      <el-form v-if="role === 'finance' && canRegisterDifference && summary.unresolvedCents > 0" label-width="125px" class="register-form">
        <el-form-item label="登记金额" required><el-input-number v-model="differenceAmount" :precision="2" :min="0.01" :max="summary.unresolvedCents / 100" /></el-form-item>
        <el-form-item label="去向" required><el-radio-group v-model="differenceDestination"><el-radio-button value="退回客户">退回客户</el-radio-button><el-radio-button value="计入公司">计入公司</el-radio-button></el-radio-group></el-form-item>
        <el-form-item v-if="differenceDestination === '退回客户'" label="退款流水号" required><el-input v-model="refundTransactionNo" maxlength="64" /></el-form-item>
        <el-form-item label="去向说明" required><el-input v-model="differenceReason" type="textarea" maxlength="200" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="submitting" @click="registerDifference">登记差异去向</el-button></el-form-item>
      </el-form>
    </section>
    <section v-if="role === 'finance' && canRegister" class="panel">
      <h2>登记回款</h2>
      <el-alert title="目前无法可信识别凭证上的完整金额、流水号与到账时间；请人工核对银行流水并填写说明，复核时须再次核对。" type="warning" :closable="false" />
      <el-form label-width="125px" class="register-form">
        <el-form-item label="回款类型"><el-radio-group v-model="kind"><el-radio-button value="客户回款">客户回款</el-radio-button><el-radio-button value="公司补款">公司补款</el-radio-button></el-radio-group></el-form-item>
        <el-form-item v-for="(line, index) in lines" :key="index" :label="`众筹单 ${index + 1}`">
          <div class="line"><el-select v-model="line.projectId" filterable placeholder="选择众筹单" @change="index === 0 && (proofs = [])"><el-option v-for="item in eligible" :key="item.id" :value="item.id" :label="`${item.title} · ${item.id}`" /></el-select><el-input-number v-model="line.amount" :precision="2" :min="0.01" /><el-button v-if="lines.length > 1" @click="lines.splice(index, 1)">删除</el-button></div>
        </el-form-item>
        <el-form-item><el-button :disabled="lines.length >= 20" @click="lines.push({ projectId: '', amount: undefined })">添加拆分行</el-button>　合计 {{ money(lineTotal) }}</el-form-item>
        <el-form-item label="银行流水号" required><el-input v-model="transactionNo" maxlength="64" /></el-form-item>
        <el-form-item label="到账时间" required><input v-model="bookedAt" type="datetime-local" /></el-form-item>
        <el-form-item label="回款凭证" required><div><input v-if="canUploadProof" type="file" accept="image/png,image/jpeg,image/webp" multiple :disabled="uploading || !lines[0]?.projectId" @change="uploadProofs" /><div v-for="asset in proofs" :key="asset.id">{{ asset.fileName }}</div><small>先选择首张众筹单；最多 5 张，每张不超过 10 MB。</small></div></el-form-item>
        <el-form-item v-if="kind === '公司补款'" label="补款原因" required><el-input v-model="reason" type="textarea" maxlength="200" /></el-form-item>
        <el-form-item label="人工核对说明" required><el-input v-model="note" type="textarea" maxlength="500" placeholder="说明凭证与银行流水如何核对" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="submitting" :disabled="uploading || !canUploadProof" @click="register">{{ kind === '公司补款' ? '提交公司复核' : '登记回款' }}</el-button></el-form-item>
      </el-form>
    </section>
  </div>
</template>

<style scoped>
.filters,.line { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.filters { margin-bottom:18px; }
.filters .el-select { min-width:180px; }
.line .el-select { width:min(340px, 100%); }
.summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:16px 0; }
.summary > div { padding:14px; background:#f5f7fa; border-radius:8px; }
.summary strong { display:block; margin-top:5px; }
.register-form { margin-top:18px; max-width:900px; }
small { color:#697586; }
</style>
