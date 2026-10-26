<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { apiRequest } from '../auth/api-client'

type Case = { id: string; projectId: string; status: string; gapCents: number;
  warningCount: number; lastWarnedAt: string; action?: string; note?: string;
  nextWarningDate?: string; handledAt?: string; procurementFailureRequestId?: string }
type Page = { items: Case[]; total: number; page: number; pageSize: number }
defineProps<{ canResolve: boolean }>()
const page = ref<Page>({ items: [], total: 0, page: 1, pageSize: 10 })
const loading = ref(false)
const saving = ref(false)
const status = ref('')
const current = ref<Case>()
const action = ref<'继续等待' | '公司补款' | '采购失败终止'>('继续等待')
const note = ref('')
const nextWarningDate = ref('')
async function load(pageNumber = page.value.page) {
  loading.value = true
  try {
    const params = new URLSearchParams({ page: String(pageNumber), pageSize: String(page.value.pageSize) })
    if (status.value) params.set('status', status.value)
    page.value = (await apiRequest<{ data: Page }>(`/api/receipt-overdue-cases?${params}`)).data
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '回款超期事项加载失败') }
  finally { loading.value = false }
}
function open(item: Case) {
  current.value = item
  action.value = '继续等待'
  note.value = ''
  nextWarningDate.value = ''
}
async function resolve() {
  if (!current.value || saving.value) return
  saving.value = true
  try {
    const body = { action: action.value, note: note.value, nextWarningDate: nextWarningDate.value }
    await apiRequest(`/api/receipt-overdue-cases/${encodeURIComponent(current.value.id)}/resolve`, {
      method: 'POST', body: JSON.stringify(body) })
    ElMessage.success('处置已记录')
    current.value = undefined
    await load()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '处置失败') }
  finally { saving.value = false }
}
onMounted(() => { void load() })
</script>

<template>
  <div>
    <header class="page-head"><div><h1>回款超期处置</h1><p>采购付款后超过项目预警天数仍未足额回款的事项。</p></div></header>
    <section class="panel" v-loading="loading">
      <div class="filters"><el-select v-model="status" style="width:180px" @change="load(1)">
        <el-option label="全部状态" value="" /><el-option v-for="item in ['待处置', '等待下次预警', '已处置', '已解除']" :key="item" :label="item" :value="item" />
      </el-select><el-button @click="load(1)">刷新</el-button></div>
      <el-table :data="page.items" empty-text="暂无回款超期事项">
        <el-table-column prop="projectId" label="众筹单" min-width="180" />
        <el-table-column label="回款缺口" width="130"><template #default="{ row }">{{ (row.gapCents / 100).toFixed(2) }} 元</template></el-table-column>
        <el-table-column prop="status" label="状态" width="135" />
        <el-table-column prop="warningCount" label="预警次数" width="100" />
        <el-table-column prop="lastWarnedAt" label="最近预警" min-width="190" />
        <el-table-column label="处置记录" min-width="230"><template #default="{ row }">{{ row.action || '-' }}<span v-if="row.nextWarningDate"> · 下次 {{ row.nextWarningDate }}</span><div v-if="row.note">{{ row.note }}</div><div v-if="row.procurementFailureRequestId">终止申请 {{ row.procurementFailureRequestId }}</div></template></el-table-column>
        <el-table-column v-if="canResolve" label="操作" width="100"><template #default="{ row }"><el-button v-if="row.status === '待处置'" link type="primary" @click="open(row)">处置</el-button></template></el-table-column>
      </el-table>
      <el-pagination v-model:current-page="page.page" :page-size="page.pageSize" :total="page.total"
        layout="total, prev, pager, next" @current-change="(value: number) => load(value)" />
    </section>
    <el-dialog :model-value="Boolean(current)" title="处置超期回款" width="570px" @close="current = undefined">
      <p>众筹单 {{ current?.projectId }} · 当前缺口 {{ ((current?.gapCents ?? 0) / 100).toFixed(2) }} 元</p>
      <el-form label-width="110px">
        <el-form-item label="处置方式" required><el-radio-group v-model="action"><el-radio value="继续等待">继续等待</el-radio><el-radio value="公司补款">由公司补款</el-radio><el-radio value="采购失败终止">发起采购失败终止</el-radio></el-radio-group></el-form-item>
        <el-form-item v-if="action === '继续等待'" label="下次预警日期" required><el-date-picker v-model="nextWarningDate" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="处置说明" required><el-input v-model="note" type="textarea" :rows="3" maxlength="200" show-word-limit /></el-form-item>
      </el-form>
      <el-alert v-if="action === '公司补款'" type="info" :closable="false">记录处置决定后，财务仍须登记实际补款并提交公司复核。</el-alert>
      <el-alert v-if="action === '采购失败终止'" type="info" :closable="false">将生成待公司复核的采购失败终止申请；通过后才进入退款流程。</el-alert>
      <template #footer><el-button @click="current = undefined">取消</el-button><el-button type="primary" :loading="saving" @click="resolve">确认处置</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>.filters { margin-bottom: 16px; }</style>
