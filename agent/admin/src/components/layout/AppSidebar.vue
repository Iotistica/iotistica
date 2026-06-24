<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  DashboardOutlined,
  CloudUploadOutlined,
  PartitionOutlined,
  ApartmentOutlined,
  RadarChartOutlined,
  AlertOutlined,
  FileTextOutlined,
  ContainerOutlined,
  SettingOutlined,
  TeamOutlined,
  SafetyOutlined,
} from '@ant-design/icons-vue'
import IotisticaLogo from '@/components/IotisticaLogo.vue'

const route = useRoute()
const router = useRouter()

const selectedKey = computed(() => route.path)

const openKeys = computed(() =>
  route.path.startsWith('/admin') ? ['administration'] : [],
)

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
      <IotisticaLogo :size="24" />
      <span>Iotistica</span>
    </div>
    <a-menu
      theme="dark"
      mode="inline"
      :selected-keys="[selectedKey]"
      :open-keys="openKeys"
      @click="onMenuClick"
    >
      <a-menu-item key="/dashboard">
        <template #icon><DashboardOutlined /></template>
        Dashboard
      </a-menu-item>

      <a-menu-item key="/endpoints">
        <template #icon><ApartmentOutlined /></template>
        Endpoints
      </a-menu-item>

      <a-menu-item key="/destinations">
        <template #icon><CloudUploadOutlined /></template>
        Destinations
      </a-menu-item>

      <a-menu-item key="/subscriptions">
        <template #icon><PartitionOutlined /></template>
        Subscriptions
      </a-menu-item>

      <a-menu-item key="/discovery-rules">
        <template #icon><RadarChartOutlined /></template>
        Discovery
      </a-menu-item>

      <a-menu-item key="/applications">
        <template #icon><ContainerOutlined /></template>
        Applications
      </a-menu-item>

      <a-menu-item key="/anomaly">
        <template #icon><AlertOutlined /></template>
        Alerts
      </a-menu-item>

      <a-menu-item key="/logs">
        <template #icon><FileTextOutlined /></template>
        Logs
      </a-menu-item>

      <a-menu-item key="/settings">
        <template #icon><SettingOutlined /></template>
        Settings
      </a-menu-item>

      <a-sub-menu key="administration">
        <template #icon><SafetyOutlined /></template>
        <template #title>Administration</template>

        <a-menu-item key="/admin/users">
          <template #icon><TeamOutlined /></template>
          Users
        </a-menu-item>
      </a-sub-menu>
    </a-menu>

  </a-layout-sider>
</template>

<style scoped>
.logo {
  height: 48px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 24px;
  color: rgba(255, 255, 255, 0.85);
  font-size: 16px;
  font-weight: 600;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  margin-bottom: 8px;
}

</style>
