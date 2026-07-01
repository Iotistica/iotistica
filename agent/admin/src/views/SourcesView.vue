<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, EditOutlined, DeleteOutlined, RadarChartOutlined, CheckCircleOutlined, StopOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import SourceDrawer from '@/components/sources/SourceDrawer.vue'
import DiscoveryDrawer from '@/components/discovery/DiscoveryDrawer.vue'
import type { Endpoint, EndpointCommunicationQuality, EndpointCreateData } from '@/types'
import { sourcesApi } from '@/api/sources'
import { protocolColor } from '@/utils/protocol'

const rows = ref<Endpoint[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const activeProtocol = ref('all')
const drawerOpen = ref(false)
const discoveryOpen = ref(false)
const editing = ref<Endpoint | null>(null)
const prefill = ref<EndpointCreateData | null>(null)
const selectedUuids = ref<string[]>([])
const deleting = ref(false)
const bulkEnabling = ref(false)
const bulkDisabling = ref(false)

const rowSelection = computed(() => ({
  selectedRowKeys: selectedUuids.value,
  onChange: (keys: string[]) => { selectedUuids.value = keys },
}))

let refreshTimer: ReturnType<typeof setInterval> | null = null

const filteredRows = computed(() =>
  activeProtocol.value === 'all'
    ? rows.value
    : rows.value.filter((r) => r.protocol === activeProtocol.value),
)

const columns: TableColumnType<Endpoint>[] = [
  { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true },
  { title: 'Protocol', key: 'protocol', width: 110 },
  { title: 'Status', key: 'status', width: 160 },
  { title: 'Connection', key: 'connection', ellipsis: true },
  { title: 'Enabled', key: 'enabled', width: 90 },
  { title: 'Poll', key: 'poll_interval', width: 80 },
  { title: 'Actions', key: 'actions', width: 100, fixed: 'right' },
]

// ── Health helpers ────────────────────────────────────────────────────────────

type QualityMeta = { color: string; dotColor: string; label: string }

const qualityMap: Record<EndpointCommunicationQuality | 'unknown', QualityMeta> = {
  good:     { color: '#52c41a', dotColor: '#52c41a', label: 'Connected'  },
  degraded: { color: '#faad14', dotColor: '#faad14', label: 'Degraded'   },
  poor:     { color: '#ff7a45', dotColor: '#ff7a45', label: 'Poor'       },
  offline:  { color: '#8c8c8c', dotColor: '#8c8c8c', label: 'Offline'    },
  unknown:  { color: '#8c8c8c', dotColor: '#434343', label: 'No data'    },
}

function qualityMeta(ep: Endpoint): QualityMeta {
  if (!ep.enabled) return { color: '#595959', dotColor: '#434343', label: 'Disabled' }
  const q = ep.health?.communicationQuality
  return qualityMap[q ?? 'unknown']
}

function fmtResponseTime(ms: number | null | undefined): string {
  if (ms == null) return ''
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

function timeSince(ts: string | number | null | undefined): string {
  if (!ts) return ''
  const ms = typeof ts === 'string' ? new Date(ts).getTime() : ts
  if (isNaN(ms)) return ''
  const diff = Math.floor((Date.now() - ms) / 1000)
  if (diff < 5)  return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

// ── Connection summary ────────────────────────────────────────────────────────

function fmtInterval(ms: number): string {
  if (ms >= 60_000) return `${ms / 60_000}m`
  if (ms >= 1_000) return `${ms / 1_000}s`
  return `${ms}ms`
}

function connSummary(ep: Endpoint): string {
  const c = ep.connection
  if (!c) return '—'
  if (ep.protocol === 'modbus') {
    return c.type === 'rtu' ? String(c.serialPort ?? '') : `${c.host ?? ''}:${c.port ?? 502}`
  }
  if (ep.protocol === 'opcua') {
    const raw = String(c.endpointUrl ?? '')
    try {
      const u = new URL(raw)
      return `${u.hostname}:${u.port || 4840}`
    } catch {
      return raw
    }
  }
  if (ep.protocol === 'mqtt') {
    const host = String(c.host ?? c.url ?? '')
    const port = c.port ? `:${c.port}` : ''
    return `${host}${port}`
  }
  if (ep.protocol === 'bacnet') {
    const ip = String(c.ipAddress ?? c.host ?? '')
    const instance = c.deviceInstance != null ? ` · #${c.deviceInstance}` : ''
    return `${ip}${instance}`
  }
  return JSON.stringify(c).slice(0, 40)
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function load(showLoader = true) {
  if (showLoader) loading.value = true
  error.value = null
  try {
    rows.value = await sourcesApi.getAll()
  } catch (err: unknown) {
    const e = err as { message?: string }
    error.value = e?.message ?? 'Failed to load sources'
  } finally {
    loading.value = false
  }
}

async function toggleEnabled(row: Endpoint) {
  try {
    await sourcesApi.update(row.uuid, { enabled: !row.enabled })
    await load(false)
  } catch {
    message.error('Failed to update')
  }
}

function openCreate() {
  editing.value = null
  prefill.value = null
  drawerOpen.value = true
}

function openEdit(row: Endpoint) {
  editing.value = row
  prefill.value = null
  drawerOpen.value = true
}

function confirmDelete(row: Endpoint) {
  Modal.confirm({
    title: `Delete "${row.name}"?`,
    content: 'This will remove the source and stop data collection from it.',
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      await sourcesApi.remove(row.uuid)
      message.success('Deleted')
      await load()
    },
  })
}

function confirmDeleteSelected() {
  const count = selectedUuids.value.length
  Modal.confirm({
    title: `Delete ${count} source${count !== 1 ? 's' : ''}?`,
    content: 'This will remove the selected sources and stop data collection from them.',
    okType: 'danger',
    okText: `Delete ${count}`,
    async onOk() {
      deleting.value = true
      try {
        await Promise.allSettled(selectedUuids.value.map((uuid) => sourcesApi.remove(uuid)))
        selectedUuids.value = []
        message.success(`Deleted ${count} source${count !== 1 ? 's' : ''}`)
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
    await Promise.allSettled(uuids.map((uuid) => sourcesApi.update(uuid, { enabled: true })))
    selectedUuids.value = []
    message.success(`Enabled ${uuids.length} source${uuids.length !== 1 ? 's' : ''}`)
    await load()
  } finally {
    bulkEnabling.value = false
  }
}

async function bulkDisable() {
  const uuids = [...selectedUuids.value]
  bulkDisabling.value = true
  try {
    await Promise.allSettled(uuids.map((uuid) => sourcesApi.update(uuid, { enabled: false })))
    selectedUuids.value = []
    message.success(`Disabled ${uuids.length} source${uuids.length !== 1 ? 's' : ''}`)
    await load()
  } finally {
    bulkDisabling.value = false
  }
}

watch(discoveryOpen, (isOpen) => { if (!isOpen) load() })

onMounted(() => {
  load()
  refreshTimer = setInterval(() => load(false), 10_000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <AppLayout title="Sources">
    <div class="toolbar">
      <a-radio-group
        v-model:value="activeProtocol"
        button-style="solid"
        size="small"
      >
        <a-radio-button value="all">All</a-radio-button>
        <a-radio-button value="modbus">Modbus</a-radio-button>
        <a-radio-button value="opcua">OPC-UA</a-radio-button>
        <a-radio-button value="mqtt">MQTT</a-radio-button>
        <a-radio-button value="bacnet">BACnet</a-radio-button>
      </a-radio-group>

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
        <a-button @click="discoveryOpen = true">
          <template #icon><RadarChartOutlined /></template>
          Discover
        </a-button>
        <a-button type="primary" @click="openCreate">
          <template #icon><PlusOutlined /></template>
          Add Source
        </a-button>
      </a-space>
    </div>

    <a-alert
      v-if="error"
      type="error"
      :message="error"
      show-icon
      style="margin-bottom: 16px"
    />

    <a-table
      :columns="columns"
      :data-source="filteredRows"
      :loading="loading"
      :pagination="false"
      :row-selection="rowSelection"
      row-key="uuid"
      size="middle"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'protocol'">
          <a-tag :color="protocolColor(record.protocol)">
            {{ record.protocol === 'opcua' ? 'OPC-UA' : record.protocol }}
          </a-tag>
        </template>

        <template v-else-if="column.key === 'status'">
          <a-tooltip
            :title="record.health?.lastError || undefined"
            :color="record.health?.lastError ? '#ff4d4f' : undefined"
          >
            <div class="status-cell">
              <span
                class="status-dot"
                :style="{ background: qualityMeta(record).dotColor }"
                :class="{ 'status-dot--pulse': record.health?.communicationQuality === 'good' }"
              />
              <span class="status-label" :style="{ color: qualityMeta(record).color }">
                {{ qualityMeta(record).label }}
              </span>
              <span v-if="record.health?.responseTimeMs != null" class="status-rtt">
                {{ fmtResponseTime(record.health.responseTimeMs) }}
              </span>
            </div>
          </a-tooltip>
          <div v-if="record.health?.lastSeen" class="status-lastseen">
            {{ timeSince(record.health.lastSeen) }}
          </div>
        </template>

        <template v-else-if="column.key === 'connection'">
          <span style="font-size: 13px; color: #555">{{ connSummary(record) }}</span>
        </template>

        <template v-else-if="column.key === 'enabled'">
          <a-switch
            :checked="record.enabled"
            size="small"
            @change="toggleEnabled(record)"
          />
        </template>

        <template v-else-if="column.key === 'poll_interval'">
          <span style="color: #888; font-size: 12px">{{ fmtInterval(record.poll_interval) }}</span>
        </template>

        <template v-else-if="column.key === 'actions'">
          <a-space>
            <a-button size="small" @click="openEdit(record)">
              <template #icon><EditOutlined /></template>
            </a-button>
            <a-button size="small" danger @click="confirmDelete(record)">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </a-space>
        </template>
      </template>
    </a-table>

    <SourceDrawer
      v-model:open="drawerOpen"
      :editing="editing"
      :prefill="prefill"
      @saved="load"
    />

    <DiscoveryDrawer
      v-model:open="discoveryOpen"
      @saved="load"
    />
  </AppLayout>
</template>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 8px;
}

.status-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot--pulse {
  box-shadow: 0 0 0 0 currentColor;
  animation: pulse 2.5s ease-out infinite;
}

@keyframes pulse {
  0%   { box-shadow: 0 0 0 0 rgba(82, 196, 26, 0.6); }
  70%  { box-shadow: 0 0 0 6px rgba(82, 196, 26, 0); }
  100% { box-shadow: 0 0 0 0 rgba(82, 196, 26, 0); }
}

.status-label {
  font-size: 13px;
  font-weight: 500;
}

.status-rtt {
  font-size: 11px;
  color: #888;
  margin-left: 2px;
}

.status-lastseen {
  font-size: 11px;
  color: #666;
  margin-top: 2px;
  padding-left: 14px;
}
</style>
