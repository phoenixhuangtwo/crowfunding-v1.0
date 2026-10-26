<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { apiRequest } from '../auth/api-client'

type Values = { paymentHours: number; paymentReminderHours: number; proxyConfirmDays: number;
  receiptWarningDays: number; issueHandlingHours: number }
const props = defineProps<{ canUpdate: boolean }>()
const values = reactive<Values>({ paymentHours: 12, paymentReminderHours: 4, proxyConfirmDays: 7,
  receiptWarningDays: 30, issueHandlingHours: 72 })
const revision = ref(0)
const loading = ref(false)
const saving = ref(false)
const fields: Array<{ key: keyof Values; label: string; min: number; max: number; unit: string }> = [
  { key: 'paymentHours', label: '缴款时限', min: 1, max: 720, unit: '小时' },
  { key: 'paymentReminderHours', label: '缴款提醒提前', min: 1, max: 168, unit: '小时' },
  { key: 'proxyConfirmDays', label: '代确认超期', min: 1, max: 90, unit: '天' },
  { key: 'receiptWarningDays', label: '回款预警', min: 1, max: 365, unit: '天' },
  { key: 'issueHandlingHours', label: '异议处理时限', min: 1, max: 720, unit: '小时' }
]
async function refresh() {
  loading.value = true
  try {
    const result = await apiRequest<{ data: Values & { revision: number } }>('/api/rule-parameters')
    for (const field of fields) values[field.key] = result.data[field.key]
    revision.value = result.data.revision
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '读取规则参数失败') }
  finally { loading.value = false }
}
async function save() {
  if (!props.canUpdate || saving.value) return
  saving.value = true
  try {
    const result = await apiRequest<{ data: Values & { revision: number }; message: string }>('/api/rule-parameters', {
      method: 'POST', body: JSON.stringify({ ...values }) })
    revision.value = result.data.revision
    ElMessage.success(result.message)
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '保存规则参数失败') }
  finally { saving.value = false }
}
onMounted(() => { void refresh() })
</script>

<template>
  <div><header class="page-head"><div><h1>规则参数</h1><p>只影响此后发布的众筹单；已发布项目沿用发布时快照。</p></div></header><section class="panel" v-loading="loading"><p>当前版本：{{ revision || '默认值' }}</p><el-form label-width="150px" class="form"><el-form-item v-for="field in fields" :key="field.key" :label="field.label" required><el-input-number v-model="values[field.key]" :min="field.min" :max="field.max" :step="1" :precision="0" :disabled="!canUpdate" /><span class="unit">{{ field.unit }}，范围 {{ field.min }}–{{ field.max }}</span></el-form-item><el-form-item v-if="canUpdate"><el-button type="primary" :loading="saving" @click="save">保存全部参数</el-button></el-form-item></el-form></section></div>
</template>

<style scoped>
.form { max-width: 650px; margin-top: 20px; }
.unit { margin-left: 12px; color: #667085; }
</style>
