<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { apiRequest } from '../auth/api-client'

type Project = { id: string; title: string; status: string }
type Funding = {
  purchaseCents: number
  employeeCents: number
  companyCents: number
  pendingReviewCount: number
  differenceCents: number
  balanced: boolean
  companyFundsConfirmed: boolean
  checkedAt: string
}

const props = defineProps<{ projects: Project[]; canRegister: boolean; canUploadProof: boolean }>()
const emit = defineEmits<{ registered: [] }>()
const projectId = ref('')
const funding = ref<Funding>()
const loading = ref(false)
const submitting = ref(false)
const uploading = ref(false)
const error = ref('')
const proofAssets = ref<Array<{ id: string; fileName: string }>>([])
const amount = ref<number>()
const transactionNo = ref('')
const paidAtLocal = ref('')
const companyFundsConfirmed = ref(false)
const note = ref('')
const options = computed(() => props.projects.filter(project => ['已满额', '已截止', '待回款'].includes(project.status)))
const money = (cents: number) => `¥ ${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

watch(options, items => {
  if (!items.some(item => item.id === projectId.value)) projectId.value = items[0]?.id ?? ''
}, { immediate: true })
watch(projectId, () => {
  funding.value = undefined
  proofAssets.value = []
  error.value = ''
  if (projectId.value) void refreshFunding()
}, { immediate: true })

async function refreshFunding() {
  if (!projectId.value) return
  const requested = projectId.value
  loading.value = true
  error.value = ''
  try {
    const response = await apiRequest<{ data: Funding }>(`/api/projects/${encodeURIComponent(requested)}/funding-reconciliation`)
    if (projectId.value !== requested) return
    funding.value = response.data
    amount.value = response.data.purchaseCents / 100
  } catch (cause) {
    if (projectId.value === requested) error.value = cause instanceof Error ? cause.message : '对账失败'
  } finally {
    if (projectId.value === requested) loading.value = false
  }
}

async function uploadProofs(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!projectId.value || !files.length || !props.canUploadProof) return
  if (files.length + proofAssets.value.length > 5) { ElMessage.warning('最多上传 5 张付款凭证'); return }
  uploading.value = true
  try {
    for (const file of files) {
      const form = new FormData()
      form.set('image', file)
      const response = await apiRequest<{ data: { id: string; fileName: string } }>(
        `/api/projects/${encodeURIComponent(projectId.value)}/procurement-payment/proofs`, { method: 'POST', body: form })
      proofAssets.value.push(response.data)
    }
    ElMessage.success('付款凭证已保存')
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '上传失败')
  } finally { uploading.value = false }
}

async function registerPayment() {
  if (!projectId.value || !props.canRegister || submitting.value) return
  if (!funding.value?.balanced) { ElMessage.warning('付款前对账未相符，请先核对差额和待复核缴款'); return }
  if (!proofAssets.value.length) { ElMessage.warning('请至少上传 1 张付款凭证'); return }
  if (!paidAtLocal.value || !Number.isFinite(new Date(paidAtLocal.value).getTime())) { ElMessage.warning('请选择付款时间'); return }
  try {
    await ElMessageBox.confirm('登记付款后全部认购单将锁定，确认提交？', '登记采购付款', {
      confirmButtonText: '确认登记', cancelButtonText: '取消', type: 'warning'
    })
  } catch { return }
  submitting.value = true
  try {
    await apiRequest(`/api/projects/${encodeURIComponent(projectId.value)}/procurement-payment`, {
      method: 'POST', body: JSON.stringify({ amountCents: Math.round((amount.value ?? 0) * 100),
        transactionNo: transactionNo.value.trim(), paidAt: new Date(paidAtLocal.value).toISOString(),
        proofAssetIds: proofAssets.value.map(asset => asset.id), recognitionFailed: true,
        companyFundsConfirmed: companyFundsConfirmed.value, note: note.value.trim() })
    })
    ElMessage.success('采购付款登记成功')
    await refreshFunding()
    emit('registered')
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '付款登记失败')
  } finally { submitting.value = false }
}
</script>

<template>
  <div class="procurement-payment">
    <header class="page-head"><div><h1>采购付款登记</h1><p>先核对员工已生效缴款和公司认购承诺，再登记实际向供应商付款。</p></div></header>
    <section class="panel">
      <el-form label-width="126px">
        <el-form-item label="众筹单">
          <el-select v-model="projectId" filterable placeholder="选择待付款众筹单" style="width: 100%">
            <el-option v-for="project in options" :key="project.id" :value="project.id" :label="`${project.title} · ${project.id}`" />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert v-if="!options.length" title="暂无待登记付款的众筹单" type="info" :closable="false" />
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <template v-if="funding">
        <div class="funding-summary">
          <div><span>采购金额</span><strong>{{ money(funding.purchaseCents) }}</strong></div>
          <div><span>员工已生效缴款</span><strong>{{ money(funding.employeeCents) }}</strong></div>
          <div><span>公司认购承诺</span><strong>{{ money(funding.companyCents) }}</strong></div>
          <div><span>差额</span><strong>{{ money(funding.differenceCents) }}</strong></div>
        </div>
        <el-alert :title="`对账${funding.balanced ? '相符' : '不符'}；待复核或部分缴款 ${funding.pendingReviewCount} 笔。公司认购金额须由财务人工确认实际到位。`"
          :type="funding.balanced ? 'success' : 'warning'" :closable="false" />
        <p v-if="funding.companyFundsConfirmed">本项目已登记采购付款，公司出资已由财务确认。</p>
        <template v-else>
          <el-divider>登记付款</el-divider>
          <el-form label-width="126px">
            <el-form-item label="付款金额" required><el-input-number v-model="amount" :min="0.01" :precision="2" /></el-form-item>
            <el-form-item label="银行流水号" required><el-input v-model="transactionNo" maxlength="64" placeholder="6 至 64 字，不可重复" /></el-form-item>
            <el-form-item label="付款时间" required><input v-model="paidAtLocal" type="datetime-local" /></el-form-item>
            <el-form-item label="付款凭证" required>
              <div><input v-if="canUploadProof" type="file" accept="image/png,image/jpeg,image/webp" multiple :disabled="uploading" @change="uploadProofs" />
                <div v-for="asset in proofAssets" :key="asset.id">{{ asset.fileName }}</div>
                <small>最多 5 张，每张不超过 10 MB。</small></div>
            </el-form-item>
            <el-form-item label="识别情况说明" required><el-input v-model="note" type="textarea" :rows="3" placeholder="当前无可信自动识别结果，请说明如何核对付款凭证与银行流水" /></el-form-item>
            <el-form-item label="公司出资已到位" required><el-checkbox v-model="companyFundsConfirmed">已核对公司出资实际到位；为零时在说明中注明“出资为零”</el-checkbox></el-form-item>
            <el-form-item><el-button type="primary" :loading="submitting" :disabled="loading || uploading || !canRegister" @click="registerPayment">登记付款</el-button></el-form-item>
          </el-form>
        </template>
      </template>
    </section>
  </div>
</template>

<style scoped>
.funding-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 20px 0; }
.funding-summary > div { padding: 16px; background: #f5f7fa; border-radius: 8px; }
.funding-summary span { display: block; color: #606a7b; margin-bottom: 8px; }
.funding-summary strong { font-size: 18px; }
@media (max-width: 800px) { .funding-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
