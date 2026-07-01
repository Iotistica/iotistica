<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { CheckCircleOutlined, StopOutlined, DeleteOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { client } from '@/api/client'
import { protocolColor, protocolLabel } from '@/utils/protocol'

interface Device {
  uuid: string
  name: string
  protocol: string
  enabled: boolean
  identifier: string | null
  metadata?: Record<string, any>
  lastSeenAt: string | null
  created_at: string
}

const rows = ref<Device[]>([])
const loading = ref(false)
const activeProtocol = ref('')
let refreshTimer: ReturnType<typeof setInterval> | null = null

const selectedUuids = ref<string[]>([])
const deleting = ref(false)
const bulkEnabling = ref(false)
const bulkDisabling = ref(false)

const rowSelection = computed(() => ({
  selectedRowKeys: selectedUuids.value,
  onChange: (keys: string[]) => { selectedUuids.value = keys },
}))

const protocols = computed(() => {
  const seen = new Set(rows.value.map(d => d.protocol))
  return [...seen].sort()
})

const filtered = computed(() =>
  activeProtocol.value
    ? rows.value.filter(d => d.protocol === activeProtocol.value)
    : rows.value,
)

const columns: TableColumnType[] = [
  { title: 'Name',       key: 'name',       ellipsis: true },
  { title: 'Protocol',   key: 'protocol',   width: 110 },
  { title: 'Identifier', key: 'identifier', width: 160, ellipsis: true },
  { title: 'UUID',       key: 'uuid',       width: 120 },
  { title: 'Last Seen',  key: 'lastSeen',   width: 130 },
  { title: 'Status',     key: 'status',     width: 110 },
]

async function load() {
  loading.value = true
  try {
    const { data } = await client.get<{ devices: Device[] }>('/v1/devices')
    rows.value = data.devices ?? []
  } finally {
    loading.value = false
  }
}

function timeSince(ts: string | null): string {
  if (!ts) return '—'
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (isNaN(diff) || diff < 0) return '—'
  if (diff < 5)    return 'just now'
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function deviceStatus(d: Device): { label: string; color: string } {
  if (!d.enabled) return { label: 'Disabled', color: 'default' }
  if (!d.lastSeenAt) return { label: 'Pending', color: 'gold' }
  const age = (Date.now() - new Date(d.lastSeenAt).getTime()) / 1000
  if (age < 300)  return { label: 'Active',   color: 'green' }
  if (age < 3600) return { label: 'Stale',    color: 'orange' }
  return { label: 'Inactive', color: 'red' }
}

function shortUuid(uuid: string): string {
  return uuid ? uuid.slice(0, 8) : '—'
}

function identifierLabel(d: Device): string {
  if (d.identifier) return d.identifier
  if (d.metadata?.slaveId != null) return `Slave ${d.metadata.slaveId}`
  return '—'
}

function confirmDeleteSelected() {
  const count = selectedUuids.value.length
  Modal.confirm({
    title: `Delete ${count} device${count !== 1 ? 's' : ''}?`,
    content: 'Removed devices will reappear if the endpoint reconnects.',
    okType: 'danger',
    okText: `Delete ${count}`,
    async onOk() {
      deleting.value = true
      try {
        await Promise.allSettled(selectedUuids.value.map((uuid) => client.delete(`/v1/devices/${uuid}`)))
        selectedUuids.value = []
        message.success(`Deleted ${count} device${count !== 1 ? 's' : ''}`)
        await load()
      } finally {
        deleting.value = false
      }
    },
  })
}

async function bulkEnable() {
  const uuids = [...selectedUuids.value]
  bulkEnabling.value = true
  try {
    await Promise.allSettled(uuids.map((uuid) => client.patch(`/v1/devices/${uuid}`, { enabled: true })))
    selectedUuids.value = []
    message.success(`Enabled ${uuids.length} device${uuids.length !== 1 ? 's' : ''}`)
    await load()
  } finally {
    bulkEnabling.value = false
  }
}

async function bulkDisable() {
  const uuids = [...selectedUuids.value]
  bulkDisabling.value = true
  try {
    await Promise.allSettled(uuids.map((uuid) => client.patch(`/v1/devices/${uuid}`, { enabled: false })))
    selectedUuids.value = []
    message.success(`Disabled ${uuids.length} device${uuids.length !== 1 ? 's' : ''}`)
    await load()
  } finally {
    bulkDisabling.value = false
  }
}

onMounted(() => {
  load()
  refreshTimer = setInterval(load, 30_000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <AppLayout>
    <div class="devices-page">
      <div class="page-header">
        <div>
          <h2>Devices</h2>
          <p class="subtitle">Physical and logical devices discovered through protocol endpoints</p>
        </div>
        <a-space>
          <template v-if="selectedUuids.length > 0">
            <span style="font-size: 13px; color: #666">{{ selectedUuids.length }} selected</span>
            <a-button :loading="bulkEnabling" @click="bulkEnable">
              <template #icon><CheckCircleOutlined /></template>
              Enable
            </a-button>
            <a-button :loading="bulkDisabling" @click="bulkDisable">
              <template #icon><StopOutlined /></template>
              Disable
            </a-button>
            <a-button danger :loading="deleting" @click="confirmDeleteSelected">
              <template #icon><DeleteOutlined /></template>
              Delete
            </a-button>
          </template>
          <a-button @click="load" :loading="loading">Refresh</a-button>
        </a-space>
      </div>

      <!-- Protocol filter tabs -->
      <div v-if="protocols.length > 1" class="protocol-tabs">
        <a-radio-group
          v-model:value="activeProtocol"
          button-style="solid"
          size="small"
        >
          <a-radio-button value="">All ({{ rows.length }})</a-radio-button>
          <a-radio-button
            v-for="p in protocols"
            :key="p"
            :value="p"
          >
            {{ protocolLabel(p) }} ({{ rows.filter(d => d.protocol === p).length }})
          </a-radio-button>
        </a-radio-group>
      </div>

      <a-table
        :dataSource="filtered"
        :columns="columns"
        :loading="loading"
        :pagination="{ pageSize: 50, hideOnSinglePage: true }"
        :row-selection="rowSelection"
        row-key="uuid"
        size="small"
      >
        <template #bodyCell="{ column, record }">

          <template v-if="column.key === 'name'">
            <span class="device-name">{{ record.name }}</span>
          </template>

          <template v-else-if="column.key === 'protocol'">
            <a-tag :color="protocolColor(record.protocol)">
              {{ protocolLabel(record.protocol) }}
            </a-tag>
          </template>

          <template v-else-if="column.key === 'identifier'">
            <span class="mono-text">{{ identifierLabel(record) }}</span>
          </template>

          <template v-else-if="column.key === 'uuid'">
            <a-tooltip :title="record.uuid">
              <span class="mono-text uuid-chip">{{ shortUuid(record.uuid) }}</span>
            </a-tooltip>
          </template>

          <template v-else-if="column.key === 'lastSeen'">
            <span :class="['lastseen', record.lastSeenAt ? 'has-time' : 'no-time']">
              {{ timeSince(record.lastSeenAt) }}
            </span>
          </template>

          <template v-else-if="column.key === 'status'">
            <a-badge
              :color="deviceStatus(record).color === 'green' ? '#52c41a' : deviceStatus(record).color === 'orange' ? '#fa8c16' : deviceStatus(record).color === 'red' ? '#ff4d4f' : deviceStatus(record).color === 'gold' ? '#faad14' : '#8c8c8c'"
              :text="deviceStatus(record).label"
            />
          </template>

        </template>

        <template #emptyText>
          <a-empty description="No devices yet">
            <template #description>
              <span>Devices appear here once endpoints connect and report data.</span><br>
              <a-typography-link href="/admin/#/endpoints">Go to Endpoints →</a-typography-link>
            </template>
          </a-empty>
        </template>
      </a-table>
    </div>
  </AppLayout>
</template>

<style scoped>
.devices-page {
  padding: 24px;
  max-width: 1200px;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 20px;
}

.page-header h2 {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 600;
}

.subtitle {
  margin: 0;
  color: #888;
  font-size: 13px;
}

.protocol-tabs {
  margin-bottom: 16px;
}

.device-name {
  font-weight: 500;
}

.mono-text {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  color: #555;
}

.uuid-chip {
  background: #f0f0f0;
  padding: 1px 6px;
  border-radius: 4px;
  cursor: default;
  letter-spacing: 0.03em;
}

.lastseen {
  font-size: 12px;
}

.lastseen.has-time {
  color: #666;
}

.lastseen.no-time {
  color: #bbb;
}
</style>
