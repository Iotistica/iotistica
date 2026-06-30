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
  UserOutlined,
  KeyOutlined,
  QuestionCircleOutlined,
  CustomerServiceOutlined,
  WifiOutlined,
  ApiOutlined,
  ClusterOutlined,
  DatabaseOutlined,
  CodeOutlined,
} from '@ant-design/icons-vue'
import IotisticaLogo from '@/components/IotisticaLogo.vue'

const route = useRoute()
const router = useRouter()

const selectedKey = computed(() => route.path)

const openKeys = computed(() => {
  const keys: string[] = []
  if (route.path.startsWith('/admin')) keys.push('administration')
  if (route.path.startsWith('/user')) keys.push('user-settings')
  return keys
})

function onMenuClick({ key }: { key: string }) {
  if (key === 'help') {
    window.open('https://docs.iotistica.com/docs/intro', '_blank')
    return
  }
  router.push(key)
}
</script>

<template>
  <a-layout-sider
    :width="220"
    theme="dark"
    style="height: 100vh; background: #0a0a0a; display: flex; flex-direction: column; flex-shrink: 0;"
  >
    <div class="logo">
      <IotisticaLogo :size="24" />
      <span>Iotistica</span>
    </div>

    <div class="nav-main">
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

        <a-menu-item key="/devices">
          <template #icon><ClusterOutlined /></template>
          Devices
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
          <a-tag color="gold" class="pro-badge">Pro</a-tag>
        </a-menu-item>

        <a-menu-item key="/mqtt-broker">
          <template #icon><WifiOutlined /></template>
          MQTT
          <a-tag color="gold" class="pro-badge">Pro</a-tag>
        </a-menu-item>

        <a-menu-item key="/terminal">
          <template #icon><CodeOutlined /></template>
          Terminal
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

          <a-menu-item key="/admin/mqtt-users">
            <template #icon><ApiOutlined /></template>
            MQTT Users
          </a-menu-item>

          <a-menu-item key="/admin/backups">
            <template #icon><DatabaseOutlined /></template>
            Backups
          </a-menu-item>
        </a-sub-menu>
      </a-menu>
    </div>

    <div class="nav-bottom">
      <a-menu
        theme="dark"
        mode="inline"
        :selected-keys="[selectedKey]"
        :open-keys="openKeys"
        @click="onMenuClick"
      >
        <a-sub-menu key="user-settings">
          <template #icon><UserOutlined /></template>
          <template #title>User</template>

          <a-menu-item key="/user/profile">
            <template #icon><UserOutlined /></template>
            Profile
          </a-menu-item>

          <a-menu-item key="/user/api-tokens">
            <template #icon><KeyOutlined /></template>
            API Tokens
          </a-menu-item>
        </a-sub-menu>

        <a-menu-item key="help">
          <template #icon><QuestionCircleOutlined /></template>
          Help
        </a-menu-item>

        <a-menu-item key="/support">
          <template #icon><CustomerServiceOutlined /></template>
          Support
          <a-tag color="gold" class="pro-badge">Pro</a-tag>
        </a-menu-item>
      </a-menu>
    </div>

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
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  margin-bottom: 8px;
  flex-shrink: 0;
}

.nav-main {
  flex: 1;
  overflow-y: auto;
  background: #141414;
}

:deep(.ant-menu-dark),
:deep(.ant-menu-dark .ant-menu-sub),
:deep(.ant-menu-dark.ant-menu-inline) {
  background: #141414 !important;
}

.nav-bottom {
  flex-shrink: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 4px;
}

:deep(.ant-layout-sider) {
  background: #0a0a0a !important;
}

:deep(.ant-layout-sider-children) {
  display: flex;
  flex-direction: column;
}


:deep(.ant-menu-dark .ant-menu-item:not(.ant-menu-item-selected):hover) {
  background: #111111 !important;
}

.pro-badge {
  font-size: 10px;
  line-height: 16px;
  padding: 0 4px;
  height: 16px;
  margin-left: 6px;
  vertical-align: middle;
  border-radius: 3px;
}
</style>
