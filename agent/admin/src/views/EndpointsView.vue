<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, EditOutlined, DeleteOutlined, RadarChartOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import EndpointDrawer from '@/components/endpoints/EndpointDrawer.vue'
import DiscoveryDrawer from '@/components/discovery/DiscoveryDrawer.vue'
import type { Endpoint, EndpointCreateData } from '@/types'
import { endpointsApi } from '@/api/endpoints'
import { protocolColor } from '@/utils/protocol'

const rows = ref<Endpoint[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const activeProtocol = ref('all')
const drawerOpen = ref(false)
const discoveryOpen = ref(false)
const editing = ref<Endpoint | null>(null)
const prefill = ref<EndpointCreateData | null>(null)

const filteredRows = computed(() =>
  activeProtocol.value === 'all'
    ? rows.value
    : rows.value.filter((r) => r.protocol === activeProtocol.value),
)

const columns: TableColumnType<Endpoint>[] = [
  { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true },
  { title: 'Protocol', key: 'protocol', width: 110 },
  { title: 'Connection', key: 'connection', ellipsis: true },
  { title: 'Enabled', key: 'enabled', width: 90 },
  { title: 'Poll', key: 'poll_interval', width: 80 },
  { title: 'Actions', key: 'actions', width: 100, fixed: 'right' },
]

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

async function load() {
  loading.value = true
  error.value = null
  try {
    rows.value = await endpointsApi.getAll()
  } catch (err: unknown) {
    const e = err as { message?: string }
    error.value = e?.message ?? 'Failed to load endpoints'
  } finally {
    loading.value = false
  }
}

async function toggleEnabled(row: Endpoint) {
  try {
    await endpointsApi.update(row.uuid, { enabled: !row.enabled })
    await load()
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
    content: 'This will remove the endpoint and stop data collection from it.',
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      await endpointsApi.remove(row.uuid)
      message.success('Deleted')
      await load()
    },
  })
}

// Reload the list whenever the discovery drawer closes so newly added endpoints always appear
watch(discoveryOpen, (isOpen) => { if (!isOpen) load() })

onMounted(load)
</script>

<template>
  <AppLayout title="Endpoints">
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
        <a-button @click="discoveryOpen = true">
          <template #icon><RadarChartOutlined /></template>
          Discover
        </a-button>
        <a-button type="primary" @click="openCreate">
          <template #icon><PlusOutlined /></template>
          Add Endpoint
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
      row-key="uuid"
      size="middle"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'protocol'">
          <a-tag :color="protocolColor(record.protocol)">
            {{ record.protocol === 'opcua' ? 'OPC-UA' : record.protocol }}
          </a-tag>
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

    <EndpointDrawer
      v-model:open="drawerOpen"
      :editing="editing"
      :prefill="prefill"
      @saved="load"
    />

    <DiscoveryDrawer
      v-model:open="discoveryOpen"
      :existing-endpoints="rows"
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
</style>
