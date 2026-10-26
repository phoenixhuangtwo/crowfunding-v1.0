<script setup lang="ts">
defineProps<{
  status: 'loading' | 'callback' | 'no-access' | 'unavailable' | 'callback-error'
}>()
const emit = defineEmits<{ retry: []; login: []; exit: [] }>()
</script>

<template>
  <section class="auth-state" role="status" aria-live="polite">
    <template v-if="status === 'loading'">
      <h1>正在验证登录状态</h1>
    </template>
    <template v-else-if="status === 'callback'">
      <h1>正在完成统一登录</h1>
    </template>
    <template v-else-if="status === 'no-access'">
      <h1>暂无众筹系统访问权限</h1>
      <p>请联系管理员在统一身份系统中开通访问权限。</p>
      <button type="button" @click="emit('exit')">退出</button>
    </template>
    <template v-else-if="status === 'unavailable'">
      <h1>统一身份服务暂不可用</h1>
      <p>请稍后重试，当前登录凭证会被保留。</p>
      <button type="button" @click="emit('retry')">重试</button>
    </template>
    <template v-else>
      <h1>授权回调校验失败</h1>
      <p>登录回调无效或已过期，请重新发起统一登录。</p>
      <button type="button" @click="emit('login')">重新登录</button>
    </template>
  </section>
</template>
