<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { apiRequest } from '../auth/api-client'

type Notice = { id: string; type: string; title: string; content: string;
  targetPage: string; createdAt: string; readAt?: string }
type Page = { items: Notice[]; total: number; unread: number; page: number; pageSize: number }
const emit = defineEmits<{ open: [targetPage: string] }>()
const data = ref<Page>({ items: [], total: 0, unread: 0, page: 1, pageSize: 10 })
const loading = ref(false)
async function load(page = data.value.page, pageSize = data.value.pageSize) {
  loading.value = true
  try {
    data.value = (await apiRequest<{ data: Page }>(`/api/notifications?page=${page}&pageSize=${pageSize}`)).data
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '通知加载失败') }
  finally { loading.value = false }
}
async function markRead(notice: Notice) {
  if (!notice.readAt) {
    try { await apiRequest(`/api/notifications/${encodeURIComponent(notice.id)}/read`, { method: 'POST', body: '{}' }) }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : '标记已读失败'); return }
    await load()
  }
  if (notice.targetPage) emit('open', notice.targetPage)
}
async function readAll() {
  if (!data.value.unread) return
  try {
    await apiRequest('/api/notifications/read-all', { method: 'POST', body: '{}' })
    ElMessage.success('已标记为已读')
    await load()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '标记已读失败') }
}
onMounted(() => { void load() })
</script>

<template>
  <div>
    <header class="page-head"><div><h1>消息中心</h1><p>未读 {{ data.unread }} 条</p></div>
      <el-button :disabled="!data.unread" @click="readAll">全部标记已读</el-button></header>
    <section class="panel" v-loading="loading">
      <el-table :data="data.items" empty-text="暂无通知" @row-click="markRead">
        <el-table-column prop="title" label="通知标题" min-width="140" />
        <el-table-column prop="content" label="通知内容" min-width="340" />
        <el-table-column prop="type" label="通知类型" width="145" />
        <el-table-column prop="createdAt" label="发送时间" width="200" />
        <el-table-column label="状态" width="90"><template #default="{ row }">
          <el-tag :type="row.readAt ? 'info' : 'primary'">{{ row.readAt ? '已读' : '未读' }}</el-tag>
        </template></el-table-column>
      </el-table>
      <el-pagination v-model:current-page="data.page" v-model:page-size="data.pageSize"
        :total="data.total" :page-sizes="[10, 20, 50]" layout="total, sizes, prev, pager, next"
        @current-change="(page: number) => load(page, data.pageSize)" @size-change="(size: number) => load(1, size)" />
    </section>
  </div>
</template>
