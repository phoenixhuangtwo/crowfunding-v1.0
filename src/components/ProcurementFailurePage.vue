<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { apiRequest } from '../auth/api-client'
import { readAccessToken } from '../auth/session'

type Project = { id: string; title: string; status: string }
type FailureRequest = { id: string; projectId: string; reason: string; status: string; requestedAt: string; reviewReason?: string }
type SupplierRefund = { id: string; projectId: string; amountCents: number; transactionNo: string; refundedAt: string; proofAssetIds: string[] }
const props = defineProps<{ projects: Project[]; role: 'admin' | 'finance' | 'super_admin'; canQueryRequests: boolean;
  canReview: boolean; canQueryRefunds: boolean; canRegisterRefund: boolean; canUploadProof: boolean; canFinish: boolean }>()
const emit = defineEmits<{ updated: [] }>()
const projectId = ref('')
const requests = ref<FailureRequest[]>([])
const refunds = ref<SupplierRefund[]>([])
const amount = ref<number>()
const transactionNo = ref('')
const refundedAt = ref('')
const manualVerificationNote = ref('')
const proofs = ref<Array<{ id: string; fileName: string }>>([])
const busy = ref(false)
const selectedProject = computed(() => props.projects.find(item => item.id === projectId.value))
const terminating = computed(() => selectedProject.value?.status === '采购失败终止中')
const money = (cents: number) => `¥ ${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

watch([projectId, () => props.role], () => { void refresh() }, { immediate: true })
async function refresh() {
  try {
    if (props.canQueryRequests) {
      const query = projectId.value ? `?projectId=${encodeURIComponent(projectId.value)}` : ''
      const result = await apiRequest<{ data: FailureRequest[] }>(`/api/procurement-failure-requests${query}`)
      requests.value = result.data
    }
    if (props.canQueryRefunds) {
      const query = projectId.value ? `?projectId=${encodeURIComponent(projectId.value)}` : ''
      const result = await apiRequest<{ data: SupplierRefund[] }>(`/api/supplier-refunds${query}`)
      refunds.value = result.data
    }
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '读取采购失败事项失败') }
}
async function review(item: FailureRequest, action: 'approve' | 'reject') {
  let reason = ''
  try {
    if (action === 'approve') await ElMessageBox.confirm('通过后将为已生效缴款的员工生成足额退款事项。确认通过？', '复核采购失败终止', { type: 'warning' })
    else reason = (await ElMessageBox.prompt('请输入 5 至 200 字驳回原因', '驳回申请', { inputType: 'textarea' })).value.trim()
  } catch { return }
  if (action === 'reject' && (reason.length < 5 || reason.length > 200)) { ElMessage.warning('驳回原因须为 5 至 200 字'); return }
  busy.value = true
  try {
    const result = await apiRequest<{ message: string }>(`/api/procurement-failure-requests/${encodeURIComponent(item.id)}/review`, {
      method: 'POST', body: JSON.stringify({ action, reason }) })
    ElMessage.success(result.message); await refresh(); emit('updated')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '复核失败') }
  finally { busy.value = false }
}
async function uploadProofs(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!projectId.value || proofs.value.length + files.length > 5) { ElMessage.warning('请先选择众筹单，且最多上传 5 张凭证'); return }
  busy.value = true
  try {
    for (const file of files) {
      const form = new FormData(); form.set('image', file)
      const result = await apiRequest<{ data: { id: string; fileName: string } }>(
        `/api/projects/${encodeURIComponent(projectId.value)}/supplier-refund-proofs`, { method: 'POST', body: form })
      proofs.value.push(result.data)
    }
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '上传凭证失败') }
  finally { busy.value = false }
}
async function registerRefund() {
  if (!projectId.value || !amount.value || !refundedAt.value || !proofs.value.length || manualVerificationNote.value.trim().length < 5) {
    ElMessage.warning('请填写退款金额、时间、核验说明并上传凭证'); return
  }
  busy.value = true
  try {
    const result = await apiRequest<{ message: string }>(`/api/projects/${encodeURIComponent(projectId.value)}/supplier-refunds`, {
      method: 'POST', body: JSON.stringify({ amountCents: Math.round(amount.value * 100),
        transactionNo: transactionNo.value.trim(), refundedAt: new Date(refundedAt.value).toISOString(),
        proofAssetIds: proofs.value.map(item => item.id), manualVerificationNote: manualVerificationNote.value.trim() }) })
    ElMessage.success(result.message)
    amount.value = undefined; transactionNo.value = ''; refundedAt.value = ''; proofs.value = []; manualVerificationNote.value = ''
    await refresh(); emit('updated')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '登记供应商退款失败') }
  finally { busy.value = false }
}
async function finish() {
  if (!projectId.value) return
  try { await ElMessageBox.confirm('请确认供应商退款已最终核实（包括未退或少退）、员工已足额退款并确认、客户回款及异常款项已处理。系统将核对资金台账。', '完成采购失败终止', { type: 'warning' }) }
  catch { return }
  busy.value = true
  try {
    const result = await apiRequest<{ message: string }>(`/api/projects/${encodeURIComponent(projectId.value)}/finish-procurement-failure`, {
      method: 'POST', body: JSON.stringify({ supplierRefundFinalConfirmed: true }) })
    ElMessage.success(result.message); await refresh(); emit('updated')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '终止前对账未通过') }
  finally { busy.value = false }
}
async function openProof(assetId: string) {
  try {
    const token = readAccessToken()
    const response = await fetch(`/api/files/${encodeURIComponent(assetId)}/content`, {
      credentials: 'same-origin', headers: token ? { Authorization: `Bearer ${token}` } : undefined })
    if (!response.ok) throw new Error('凭证读取失败')
    const url = URL.createObjectURL(await response.blob())
    window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '凭证读取失败') }
}
</script>

<template>
  <div>
    <header class="page-head"><div><h1>采购失败终止</h1><p>公司复核申请，财务登记供应商退款并在员工退款确认后完成对账。</p></div></header>
    <section class="panel">
      <div class="toolbar"><el-select v-model="projectId" clearable filterable placeholder="全部众筹单"><el-option v-for="project in projects" :key="project.id" :label="`${project.title} · ${project.id}`" :value="project.id" /></el-select><el-button @click="refresh">查询</el-button><el-button v-if="role === 'finance' && canFinish && terminating" type="primary" :loading="busy" @click="finish">核对并完成终止</el-button></div>
      <el-table v-if="canQueryRequests" :data="requests" empty-text="暂无采购失败申请" style="width:100%">
        <el-table-column prop="projectId" label="众筹单" min-width="170" /><el-table-column prop="reason" label="终止原因" min-width="240" /><el-table-column prop="status" label="复核状态" width="120" /><el-table-column prop="reviewReason" label="驳回原因" min-width="150" /><el-table-column label="操作" width="160"><template #default="scope"><template v-if="canReview && scope.row.status === '待公司复核'"><el-button link type="primary" :disabled="busy" @click="review(scope.row, 'approve')">通过</el-button><el-button link type="danger" :disabled="busy" @click="review(scope.row, 'reject')">驳回</el-button></template></template></el-table-column>
      </el-table>
    </section>
    <section v-if="canQueryRefunds" class="panel"><h2>供应商退款记录</h2><el-table :data="refunds" empty-text="暂无供应商退款" style="width:100%"><el-table-column prop="projectId" label="众筹单" min-width="170" /><el-table-column label="退款金额" width="135"><template #default="scope">{{ money(scope.row.amountCents) }}</template></el-table-column><el-table-column prop="transactionNo" label="银行流水号" min-width="160" /><el-table-column prop="refundedAt" label="退回时间" min-width="160" /><el-table-column label="凭证" width="100"><template #default="scope"><el-button v-for="id in scope.row.proofAssetIds" :key="id" link type="primary" @click="openProof(id)">查看</el-button></template></el-table-column></el-table></section>
    <section v-if="role === 'finance' && canRegisterRefund && terminating" class="panel"><h2>登记供应商退款</h2><el-alert type="warning" :closable="false" title="系统仅记录已发生的线下退款，请先核对银行到账与凭证。可分多次登记。" /><el-form label-width="125px" class="form"><el-form-item label="退款金额（元）" required><el-input-number v-model="amount" :min="0.01" :precision="2" :step="0.01" /></el-form-item><el-form-item label="银行流水号" required><el-input v-model="transactionNo" maxlength="64" /></el-form-item><el-form-item label="实际退回时间" required><input v-model="refundedAt" type="datetime-local" /></el-form-item><el-form-item label="退款凭证" required><div><input v-if="canUploadProof" type="file" accept="image/png,image/jpeg,image/webp" multiple :disabled="busy" @change="uploadProofs" /><div v-for="asset in proofs" :key="asset.id">{{ asset.fileName }}</div></div></el-form-item><el-form-item label="人工核验说明" required><el-input v-model="manualVerificationNote" type="textarea" maxlength="200" /></el-form-item><el-form-item><el-button type="primary" :loading="busy" :disabled="!canUploadProof" @click="registerRefund">登记退款</el-button></el-form-item></el-form></section>
  </div>
</template>

<style scoped>
.toolbar { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:18px; }
.toolbar .el-select { min-width:260px; }
.form { max-width:900px; margin-top:18px; }
</style>
