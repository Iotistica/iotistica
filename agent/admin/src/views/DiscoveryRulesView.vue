<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, PlayCircleOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import DiscoveryRuleDrawer from '@/components/discovery/DiscoveryRuleDrawer.vue'
import DiscoveryDrawer from '@/components/discovery/DiscoveryDrawer.vue'
import type { DiscoveryRule } from '@/types'
import { discoveryRulesApi } from '@/api/discovery'
import { protocolColor, protocolLabel } from '@/utils/protocol'

const STATUS_COLOR: Record<string, string> = {
  idle: 'default',
  running: 'processing',
  ok: 'success',
  error: 'error',
}

const rows = ref<DiscoveryRule[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const drawerOpen = ref(false)
const editing = ref<DiscoveryRule | null>(null)
const scanDrawerOpen = ref(false)
const scanRuleUuid = ref<string | undefined>()

const columns: TableColumnType<DiscoveryRule>[] = [
  { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true },
  { title: 'Protocol', key: 'protocol', width: 100 },
  { title: 'Interval', key: 'interval_seconds', width: 110 },
  { title: 'Auto-enable', key: 'auto_enable', width: 110 },
  { title: 'Status', key: 'status', width: 110 },
  { title: 'Last run', key: 'last_run_at', width: 150, ellipsis: true },
  { title: 'Last result', key: 'last_result_json', width: 150, ellipsis: true },
  { title: 'Enabled', key: 'enabled', width: 90 },
  { title: 'Actions', key: 'actions', width: 120, fixed: 'right' },
]

function fmtInterval(s: number): string {
  if (s >= 86400) return `${s / 86400}d`
  if (s >= 3600) return `${s / 3600}h`
  if (s >= 60) return `${s / 60}m`
  return `${s}s`
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function resultSummary(rule: DiscoveryRule): string {
  const r = rule.last_result_json
  if (!r) return '—'
  if (r.error) return `Error: ${r.error.slice(0, 40)}`
  return `found ${r.found}, saved ${r.saved}`
}

async function load() {
  loading.value = true
  error.value = null
  try {
    rows.value = await discoveryRulesApi.getAll()
  } catch (err: unknown) {
    const e = err as { message?: string }
    error.value = e?.message ?? 'Failed to load discovery rules'
  } finally {
    loading.value = false
  }
}

async function toggleEnabled(row: DiscoveryRule) {
  try {
    await discoveryRulesApi.update(row.uuid, { enabled: !row.enabled })
    await load()
  } catch {
    message.error('Failed to update')
  }
}

function openScanDrawer(row: DiscoveryRule) {
  scanRuleUuid.value = row.uuid
  scanDrawerOpen.value = true
}

function openCreate() {
  editing.value = null
  drawerOpen.value = true
}

function openEdit(row: DiscoveryRule) {
  editing.value = row
  drawerOpen.value = true
}

function confirmDelete(row: DiscoveryRule) {
  Modal.confirm({
    title: `Delete "${row.name}"?`,
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      await discoveryRulesApi.remove(row.uuid)
      message.success('Deleted')
      await load()
    },
  })
}

onMounted(load)
</script>

<template>
  <AppLayout title="Discovery Rules">
    <div class="toolbar">
      <span style="color: #888; font-size: 13px">
        Scheduled protocol scans — runs automatically, or trigger manually.
      </span>
      <a-button type="primary" @click="openCreate">
        <template #icon><PlusOutlined /></template>
        New Rule
      </a-button>
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
      :data-source="rows"
      :loading="loading"
      :pagination="false"
      row-key="uuid"
      size="middle"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'protocol'">
          <a-tag :color="protocolColor(record.protocol)">{{ protocolLabel(record.protocol) }}</a-tag>
        </template>

        <template v-else-if="column.key === 'interval_seconds'">
          <span style="color: #888; font-size: 12px">{{ fmtInterval(record.interval_seconds) }}</span>
        </template>

        <template v-else-if="column.key === 'auto_enable'">
          <a-tag :color="record.auto_enable ? 'green' : 'default'">
            {{ record.auto_enable ? 'yes' : 'no' }}
          </a-tag>
        </template>

        <template v-else-if="column.key === 'status'">
          <a-badge :status="STATUS_COLOR[record.status]" :text="record.status" />
        </template>

        <template v-else-if="column.key === 'last_run_at'">
          <span style="color: #888; font-size: 12px">{{ fmtDate(record.last_run_at) }}</span>
        </template>

        <template v-else-if="column.key === 'last_result_json'">
          <span
            :style="{ color: record.last_result_json?.error ? '#cf1322' : '#888', fontSize: '12px' }"
          >{{ resultSummary(record) }}</span>
        </template>

        <template v-else-if="column.key === 'enabled'">
          <a-switch :checked="record.enabled" size="small" @change="toggleEnabled(record)" />
        </template>

        <template v-else-if="column.key === 'actions'">
          <a-space>
            <a-button
              size="small"
              title="Run and review results"
              @click="openScanDrawer(record)"
            >
              <template #icon><PlayCircleOutlined /></template>
            </a-button>
            <a-button size="small" @click="openEdit(record)">Edit</a-button>
            <a-button size="small" danger @click="confirmDelete(record)">Del</a-button>
          </a-space>
        </template>
      </template>
    </a-table>

    <DiscoveryRuleDrawer
      v-model:open="drawerOpen"
      :editing="editing"
      @saved="load"
    />

    <DiscoveryDrawer
      v-model:open="scanDrawerOpen"
      :pre-selected-rule-uuid="scanRuleUuid"
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
  gap: 8px;
}
</style>
