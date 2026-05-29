<script setup lang="ts">
import AppSidebar from './AppSidebar.vue'

defineProps<{ title: string }>()
</script>

<template>
  <a-layout style="min-height: 100vh">
    <AppSidebar />
    <a-layout>
      <a-layout-header class="page-header">
        <h2>{{ title }}</h2>
      </a-layout-header>
      <a-layout-content class="page-content">
        <slot />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<style scoped>
.page-header {
  background: #fff;
  padding: 0 24px;
  display: flex;
  align-items: center;
  border-bottom: 1px solid #f0f0f0;
  height: 52px;
  line-height: 52px;
}

.page-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.page-content {
  margin: 24px;
  padding: 24px;
  background: #fff;
  border-radius: 8px;
  min-height: 360px;
}
</style>
