<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { apiRequest } from '../auth/api-client'
import { readAccessToken } from '../auth/session'

type Project = { id: string; title: string; status: string }
type Refund = { id: string; projectId: string; subscriptionId: string; participantId: string;
  amountCents: number; status: string; transactionNo?: string; paidAt?: string;
  proofAssetIds?: string[] }
const props = defineProps<{ projects: Project[]; role: 'finance' | 'super_admin';
  canRegister: boolean; canUploadProof: boolean; canFinishClose: boolean }>()
const emit = defineEmits<{ updated: [] }>()
const closingProjects = computed(() => props.projects.filter(project => project.status === '关闭中'))
const projectId = ref('')
const page = ref(1)
const items = ref<Refund[]>([])
const total = ref(0)
const loading = ref(false)
const submitting = ref(false)
const uploading = ref(false)
const target = ref<Refund>()
const transactionNo = ref('')
const paidAt = ref('')
const manualVerificationNote = ref('')
const proofs = ref<Array<{ id: string; fileName: string }>>([])
const money = (cents: number) => `¥ ${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

watch([projectId, page], () => { void refresh() }, { immediate: true })

async function refresh() {
  loading.value = true
  try {
    const query = new URLSearchParams({ page: String(page.value), pageSize: '10' })
    if (projectId.value) query.set('projectId', projectId.value)
    const result = await apiRequest<{ data: { items: Refund[]; total: number } }>(`/api/project-refunds?${query}`)
    items.value = result.data.items
    total.value = result.data.total
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '读取退款事项失败') }
  finally { loading.value = false }
}

function startPayment(refund: Refund) {
  target.value = refund
  transactionNo.value = ''; paidAt.value = ''; manualVerificationNote.value = ''; proofs.value = []
}

async function uploadProofs(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!target.value || !files.length || !props.canUploadProof) return
  if (proofs.value.length + files.length > 5) { ElMessage.warning('最多上传 5 张退款凭证'); return }
  uploading.value = true
  try {
    for (const file of files) {
      const form = new FormData()
      form.set('image', file)
      const result = await apiRequest<{ data: { id: string; fileName: string } }>(
        `/api/project-refunds/${encodeURIComponent(target.value.id)}/proofs`, { method: 'POST', body: form })
      proofs.value.push(result.data)
    }
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '上传退款凭证失败') }
  finally { uploading.value = false }
}

async function registerPayment() {
  const refund = target.value
  if (!refund || !props.canRegister || submitting.value) return
  if (!paidAt.value || !proofs.value.length || manualVerificationNote.value.trim().length < 5) {
    ElMessage.warning('请填写实际退款时间、人工核验说明并上传凭证'); return
  }
  submitting.value = true
  try {
    await apiRequest(`/api/project-refunds/${encodeURIComponent(refund.id)}/payment`, {
      method: 'POST', body: JSON.stringify({ amountCents: refund.amountCents,
        transactionNo: transactionNo.value.trim(), paidAt: new Date(paidAt.value).toISOString(),
        proofAssetIds: proofs.value.map(item => item.id),
        manualVerificationNote: manualVerificationNote.value.trim() }) })
    ElMessage.success('退款已登记，请等待员工确认')
    target.value = undefined
    await refresh()
    emit('updated')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '登记退款失败') }
  finally { submitting.value = false }
}

async function finishClose() {
  if (!props.canFinishClose || !projectId.value || submitting.value) return
  try { await ElMessageBox.confirm('确认全部员工退款已到账，关闭前资金差额与异常款项已处理？', '完成众筹关闭', { type: 'warning' }) }
  catch { return }
  submitting.value = true
  try {
    await apiRequest(`/api/projects/${encodeURIComponent(projectId.value)}/finish-close`, {
      method: 'POST', body: JSON.stringify({}) })
    ElMessage.success('众筹单已关闭')
    await refresh()
    emit('updated')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '关闭前对账未通过') }
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
    <header class="page-head"><div><h1>项目退款</h1><p>众筹关闭后的员工认购款退款，逐笔登记并由员工确认实际到账。</p></div></header>
    <section class="panel">
      <div class="toolbar"><el-select v-model="projectId" clearable filterable placeholder="全部众筹单"><el-option v-for="project in projects" :key="project.id" :value="project.id" :label="`${project.title} · ${project.id}`" /></el-select><el-button @click="refresh">查询</el-button><el-button v-if="role === 'finance' && canFinishClose && closingProjects.some(project => project.id === projectId)" @click="finishClose">核对并完成关闭</el-button></div>
      <el-table :data="items" v-loading="loading" empty-text="暂无退款事项" style="width:100%">
        <el-table-column prop="subscriptionId" label="认购编号" min-width="175" />
        <el-table-column prop="projectId" label="众筹单编号" min-width="175" />
        <el-table-column prop="participantId" label="员工" width="110" />
        <el-table-column label="应退金额" width="135"><template #default="scope">{{ money(scope.row.amountCents) }}</template></el-table-column>
        <el-table-column prop="status" label="状态" width="125" />
        <el-table-column label="实际退款" min-width="180"><template #default="scope">{{ scope.row.transactionNo || '-' }}<br>{{ scope.row.paidAt }}<div v-for="assetId in scope.row.proofAssetIds" :key="assetId"><el-button link type="primary" @click="openProof(assetId)">查看退款凭证</el-button></div></template></el-table-column>
        <el-table-column label="操作" width="130"><template #default="scope"><el-button v-if="role === 'finance' && canRegister && scope.row.status === '待退款'" size="small" type="primary" @click="startPayment(scope.row)">登记退款</el-button></template></el-table-column>
      </el-table>
      <el-pagination v-model:current-page="page" :page-size="10" :total="total" layout="prev, pager, next, total" />
    </section>
    <section v-if="target && role === 'finance' && canRegister" class="panel">
      <h2>登记退款 · {{ target.subscriptionId }}</h2>
      <el-alert type="warning" :closable="false" title="系统不发起银行退款；请先完成线下付款，并核对实际到账流水与凭证。" />
      <el-form label-width="125px" class="register-form">
        <el-form-item label="退款金额">{{ money(target.amountCents) }}</el-form-item>
        <el-form-item label="退款流水号" required><el-input v-model="transactionNo" maxlength="64" /></el-form-item>
        <el-form-item label="实际退款时间" required><input v-model="paidAt" type="datetime-local" /></el-form-item>
        <el-form-item label="退款凭证" required><div><input v-if="canUploadProof" type="file" accept="image/png,image/jpeg,image/webp" multiple :disabled="uploading" @change="uploadProofs" /><div v-for="asset in proofs" :key="asset.id">{{ asset.fileName }}</div></div></el-form-item>
        <el-form-item label="人工核验说明" required><el-input v-model="manualVerificationNote" type="textarea" maxlength="200" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="submitting" :disabled="uploading || !canUploadProof" @click="registerPayment">登记退款</el-button><el-button @click="target = undefined">取消</el-button></el-form-item>
      </el-form>
    </section>
  </div>
</template>

<style scoped>
.toolbar { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:18px; }
.toolbar .el-select { min-width:260px; }
.register-form { max-width:900px; margin-top:18px; }
</style>
