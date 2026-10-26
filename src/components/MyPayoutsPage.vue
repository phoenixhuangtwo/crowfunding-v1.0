<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { apiRequest } from '../auth/api-client'
import { readAccessToken } from '../auth/session'
import { useAuthSession } from '../auth/use-auth-session'
import { canApi } from '../auth/permissions'

type MyPayout = { orderId: string; projectId: string; orderStatus: string;
  line: { participantId: string; principalCents: number; profitCents: number;
    payoutCents: number; status: string; payout?: { transactionNo?: string; paidAt: string;
      proofAssetIds: string[] }; issueReason?: string; issueReply?: string } }
type Agreement = { version: number; title: string; body: string }
type MyExceptionRefund = { fundId: string; projectId?: string; transactionNo: string;
  allocation: { id: string; amountCents: number; status: string; transactionNo?: string;
    paidAt?: string; proofAssetIds?: string[]; reason: string } }
type MyProjectRefund = { id: string; projectId: string; subscriptionId: string;
  amountCents: number; status: string; transactionNo?: string; paidAt?: string;
  proofAssetIds?: string[] }
const authSession = useAuthSession()
const items = ref<MyPayout[]>([])
const exceptionRefunds = ref<MyExceptionRefund[]>([])
const projectRefunds = ref<MyProjectRefund[]>([])
const loading = ref(false)
const submitting = ref(false)
const agreement = ref<Agreement>()
const confirmationTarget = ref<MyPayout>()
const reachedEnd = ref(false)
const checked = ref(false)
const agreementScroll = ref<HTMLElement>()
const money = (cents: number) => `¥ ${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

async function refresh() {
  loading.value = true
  try {
    const result = await apiRequest<{ data: MyPayout[] }>('/api/my-distribution-payouts')
    items.value = result.data
    if (canApi(authSession.permissionInfo.value, 'crowdfunding:exception-fund:my-refunds')) {
      const refunds = await apiRequest<{ data: MyExceptionRefund[] }>('/api/my-exception-refunds')
      exceptionRefunds.value = refunds.data
    }
    if (canApi(authSession.permissionInfo.value, 'crowdfunding:project-refund:my-query')) {
      const refunds = await apiRequest<{ data: MyProjectRefund[] }>('/api/my-project-refunds')
      projectRefunds.value = refunds.data
    }
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '读取我的收益失败') }
  finally { loading.value = false }
}
void refresh()

function checkScroll() {
  const element = agreementScroll.value
  if (element && element.scrollTop + element.clientHeight >= element.scrollHeight - 4) reachedEnd.value = true
}

async function startConfirm(item: MyPayout) {
  try {
    const result = await apiRequest<{ data: Agreement | null }>('/api/agreements/current')
    if (!result.data) { ElMessage.error('暂无生效免责协议，暂不能确认收款'); return }
    agreement.value = result.data
    confirmationTarget.value = item
    reachedEnd.value = false
    checked.value = false
    await nextTick()
    checkScroll()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '读取免责协议失败') }
}

async function submitConfirm() {
  const item = confirmationTarget.value
  if (!item || !agreement.value || !reachedEnd.value || !checked.value || submitting.value) return
  submitting.value = true
  try {
    await apiRequest(`/api/distribution-orders/${encodeURIComponent(item.orderId)}/lines/${encodeURIComponent(item.line.participantId)}/confirm`, {
      method: 'POST', body: JSON.stringify({ decision: '确认', agreementVersion: agreement.value.version,
        agreementsConfirmed: true }) })
    ElMessage.success('已确认收款')
    confirmationTarget.value = undefined
    await refresh()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '确认收款失败') }
  finally { submitting.value = false }
}

async function raiseIssue(item: MyPayout) {
  let reason = ''
  try {
    const result = await ElMessageBox.prompt('请填写 5 至 200 字异议原因', '提出收款异议', { inputType: 'textarea' })
    reason = result.value.trim()
  } catch { return }
  submitting.value = true
  try {
    await apiRequest(`/api/distribution-orders/${encodeURIComponent(item.orderId)}/lines/${encodeURIComponent(item.line.participantId)}/confirm`, {
      method: 'POST', body: JSON.stringify({ decision: '异议', reason }) })
    ElMessage.success('异议已提交')
    await refresh()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '提交异议失败') }
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

async function confirmExceptionRefund(item: MyExceptionRefund) {
  if (!canApi(authSession.permissionInfo.value, 'crowdfunding:exception-fund:refund-confirm') || submitting.value) return
  try {
    await ElMessageBox.confirm(`请先核对实际收到的 ${money(item.allocation.amountCents)}，确认这笔退款已到账？`,
      '确认异常款项退款', { type: 'warning' })
  } catch { return }
  submitting.value = true
  try {
    await apiRequest(`/api/exception-funds/${encodeURIComponent(item.fundId)}/refunds/${encodeURIComponent(item.allocation.id)}/confirm`, {
      method: 'POST', body: JSON.stringify({}) })
    ElMessage.success('退款已确认')
    await refresh()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '确认退款失败') }
  finally { submitting.value = false }
}

async function confirmProjectRefund(item: MyProjectRefund) {
  if (!canApi(authSession.permissionInfo.value, 'crowdfunding:project-refund:confirm') || submitting.value) return
  try {
    await ElMessageBox.confirm(`请核对实际收到的 ${money(item.amountCents)}，确认这笔认购退款已到账？`,
      '确认项目退款', { type: 'warning' })
  } catch { return }
  submitting.value = true
  try {
    await apiRequest(`/api/project-refunds/${encodeURIComponent(item.id)}/confirm`, {
      method: 'POST', body: JSON.stringify({}) })
    ElMessage.success('退款已确认')
    await refresh()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '确认退款失败') }
  finally { submitting.value = false }
}
</script>

<template>
  <div>
    <header class="page-head"><div><h1>我的收益</h1><p>查看自己的分配明细，核对实际到账后确认收款或提出异议。</p></div></header>
    <section class="panel">
      <el-table :data="items" v-loading="loading" empty-text="暂无收益记录" style="width:100%">
        <el-table-column prop="projectId" label="众筹单" min-width="170" />
        <el-table-column label="本金" width="130"><template #default="scope">{{ money(scope.row.line.principalCents) }}</template></el-table-column>
        <el-table-column label="利润" width="130"><template #default="scope">{{ money(scope.row.line.profitCents) }}</template></el-table-column>
        <el-table-column label="应得合计" width="135"><template #default="scope">{{ money(scope.row.line.payoutCents) }}</template></el-table-column>
        <el-table-column label="到账记录" min-width="190"><template #default="scope"><template v-if="scope.row.line.payout"><div>{{ scope.row.line.payout.paidAt }}</div><div>流水：{{ scope.row.line.payout.transactionNo }}</div><el-button v-for="assetId in scope.row.line.payout.proofAssetIds" :key="assetId" link type="primary" @click="openProof(assetId)">查看打款凭证</el-button></template><span v-else>待财务登记</span></template></el-table-column>
        <el-table-column label="状态与操作" min-width="230"><template #default="scope"><div>{{ scope.row.line.status }}</div><div v-if="scope.row.line.issueReason">异议：{{ scope.row.line.issueReason }}</div><div v-if="scope.row.line.issueReply">财务回复：{{ scope.row.line.issueReply }}</div><template v-if="scope.row.line.status === '待员工确认'"><el-button size="small" type="primary" :disabled="submitting" @click="startConfirm(scope.row)">确认收款</el-button><el-button size="small" :disabled="submitting" @click="raiseIssue(scope.row)">提出异议</el-button></template></template></el-table-column>
      </el-table>
    </section>
    <section v-if="canApi(authSession.permissionInfo.value, 'crowdfunding:exception-fund:my-refunds')" class="panel">
      <h2>我的异常款项退款</h2>
      <el-table :data="exceptionRefunds" v-loading="loading" empty-text="暂无退款记录" style="width:100%">
        <el-table-column label="众筹单 / 款项" min-width="180"><template #default="scope">{{ scope.row.projectId || '待核实' }} · {{ scope.row.fundId }}</template></el-table-column>
        <el-table-column label="退回金额" width="140"><template #default="scope">{{ money(scope.row.allocation.amountCents) }}</template></el-table-column>
        <el-table-column label="退回流水 / 时间" min-width="190"><template #default="scope">{{ scope.row.allocation.transactionNo }}<br>{{ scope.row.allocation.paidAt }}</template></el-table-column>
        <el-table-column label="凭证" width="125"><template #default="scope"><el-button v-for="assetId in scope.row.allocation.proofAssetIds" :key="assetId" link type="primary" @click="openProof(assetId)">查看凭证</el-button></template></el-table-column>
        <el-table-column label="状态与操作" min-width="170"><template #default="scope">{{ scope.row.allocation.status }}<div v-if="scope.row.allocation.status === '待确认'"><el-button v-if="canApi(authSession.permissionInfo.value, 'crowdfunding:exception-fund:refund-confirm')" size="small" type="primary" :disabled="submitting" @click="confirmExceptionRefund(scope.row)">确认退款到账</el-button></div></template></el-table-column>
      </el-table>
    </section>
    <section v-if="canApi(authSession.permissionInfo.value, 'crowdfunding:project-refund:my-query')" class="panel">
      <h2>我的认购退款</h2>
      <el-table :data="projectRefunds" v-loading="loading" empty-text="暂无认购退款记录" style="width:100%">
        <el-table-column prop="projectId" label="众筹单" min-width="180" />
        <el-table-column prop="subscriptionId" label="认购编号" min-width="180" />
        <el-table-column label="应退金额" width="140"><template #default="scope">{{ money(scope.row.amountCents) }}</template></el-table-column>
        <el-table-column label="退款流水 / 时间" min-width="190"><template #default="scope">{{ scope.row.transactionNo || '待财务登记' }}<br>{{ scope.row.paidAt }}</template></el-table-column>
        <el-table-column label="凭证" width="125"><template #default="scope"><el-button v-for="assetId in scope.row.proofAssetIds" :key="assetId" link type="primary" @click="openProof(assetId)">查看凭证</el-button></template></el-table-column>
        <el-table-column label="状态与操作" min-width="160"><template #default="scope">{{ scope.row.status }}<div v-if="scope.row.status === '待员工确认'"><el-button v-if="canApi(authSession.permissionInfo.value, 'crowdfunding:project-refund:confirm')" size="small" type="primary" :disabled="submitting" @click="confirmProjectRefund(scope.row)">确认退款到账</el-button></div></template></el-table-column>
      </el-table>
    </section>
    <el-dialog :model-value="Boolean(confirmationTarget)" title="确认收款及免责协议" width="660px" @update:model-value="(value: boolean) => { if (!value) confirmationTarget = undefined }">
      <template v-if="confirmationTarget && agreement"><p>请先核对本人实际收到的 {{ money(confirmationTarget.line.payoutCents) }}，阅读《{{ agreement.title }}》（第 {{ agreement.version }} 版）。</p><div ref="agreementScroll" class="agreement-scroll" @scroll="checkScroll">{{ agreement.body }}</div><el-checkbox v-model="checked" :disabled="!reachedEnd">我已阅读协议并确认该笔分配款实际到账</el-checkbox></template>
      <template #footer><el-button @click="confirmationTarget = undefined">取消</el-button><el-button type="primary" :loading="submitting" :disabled="!reachedEnd || !checked" @click="submitConfirm">确认收款</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.agreement-scroll { max-height:300px; overflow:auto; white-space:pre-wrap; padding:16px; margin:12px 0; background:#f7f9fc; border:1px solid #d8e0ea; border-radius:8px; }
</style>
