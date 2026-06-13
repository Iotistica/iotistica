<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  CloudUploadOutlined,
  PartitionOutlined,
  ApartmentOutlined,
} from '@ant-design/icons-vue'

const route = useRoute()
const router = useRouter()

const selectedKey = computed(() => route.path)

const menuItems = [
  {
    key: '/endpoints',
    icon: ApartmentOutlined,
    label: 'Endpoints',
  },
  {
    key: '/destinations',
    icon: CloudUploadOutlined,
    label: 'Destinations',
  },
  {
    key: '/subscriptions',
    icon: PartitionOutlined,
    label: 'Subscriptions',
  },
]

function onMenuClick({ key }: { key: string }) {
  router.push(key)
}
</script>

<template>
  <a-layout-sider
    :width="220"
    theme="dark"
    style="min-height: 100vh"
  >
    <div class="logo">
      <span>Agent Admin</span>
    </div>
    <a-menu
      theme="dark"
      mode="inline"
      :selected-keys="[selectedKey]"
      @click="onMenuClick"
    >
      <a-menu-item v-for="item in menuItems" :key="item.key">
        <template #icon>
          <component :is="item.icon" />
        </template>
        {{ item.label }}
      </a-menu-item>
    </a-menu>
  </a-layout-sider>
</template>

<style scoped>
.logo {
  height: 48px;
  display: flex;
  align-items: center;
  padding: 0 24px;
  color: rgba(255, 255, 255, 0.85);
  font-size: 16px;
  font-weight: 600;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  margin-bottom: 8px;
}
</style>
