<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, PlayCircleOutlined, HistoryOutlined, DeleteOutlined, CheckCircleOutlined, StopOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import DiscoveryRuleDrawer from '@/components/discovery/DiscoveryRuleDrawer.vue'
import DiscoveryDrawer from '@/components/discovery/DiscoveryDrawer.vue'
import DiscoveryRunsDrawer from '@/components/discovery/DiscoveryRunsDrawer.vue'
import type { DiscoveryRule, DiscoveryRun } from '@/types'
import { discoveryRulesApi } from '@/api/discovery'
import { protocolColor, protocolLabel } from '@/utils/protocol'

const STATUS_COLOR: Record<string, string> = {
  idle: 'default',
  running: 'processing',
  ok: 'success',
  error: 'error',
}

const activeTab = ref('rules')

const selectedUuids = ref<string[]>([])
const deleting = ref(false)
const bulkEnabling = ref(false)
const bulkDisabling = ref(false)

const rowSelection = computed(() => ({
  selectedRowKeys: selectedUuids.value,
  onChange: (keys: string[]) => { selectedUuids.value = keys },
}))

const rows = ref<DiscoveryRule[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const drawerOpen = ref(false)
const editing = ref<DiscoveryRule | null>(null)
const scanDrawerOpen = ref(false)
const scanRuleUuid = ref<string | undefined>()
const runsDrawerOpen = ref(false)
const runsDrawerRule = ref<DiscoveryRule | null>(null)
const recentRuns = ref<DiscoveryRun[]>([])
const recentRunsLoading = ref(false)
const runsLoaded = ref(false)

// STATUS_COLOR is shared with discovery rule status (idle/running/ok/error)

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

async function loadRecentRuns() {
  recentRunsLoading.value = true
  try {
    recentRuns.value = await discoveryRulesApi.getRecentRuns(15)
    runsLoaded.value = true
  } catch {
    // non-fatal
  } finally {
    recentRunsLoading.value = false
  }
}

function onTabChange(key: string) {
  activeTab.value = key
  if (key === 'runs' && !runsLoaded.value) loadRecentRuns()
}

function openRunsDrawer(row: DiscoveryRule) {
  runsDrawerRule.value = row
  runsDrawerOpen.value = true
}

const recentRunsColumns: TableColumnType<DiscoveryRun>[] = [
  { title: 'Rule', key: 'rule', ellipsis: true },
  { title: 'Started', key: 'started_at', width: 165 },
  { title: 'Duration', key: 'duration_ms', width: 90 },
  { title: 'Status', key: 'status', width: 90 },
  { title: 'Trigger', key: 'trigger', width: 90 },
  { title: 'Result / Error', key: 'result', ellipsis: true },
]

const columns: TableColumnType<DiscoveryRule>[] = [
  { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true, minWidth: 140 },
  { title: 'Protocol', key: 'protocol', width: 95 },
  { title: 'Interval', key: 'interval_seconds', width: 85 },
  { title: 'Auto-enable', key: 'auto_enable', width: 100 },
  { title: 'Status', key: 'status', width: 95 },
  { title: 'Last run', key: 'last_run_at', width: 140, ellipsis: true },
  { title: 'Last result', key: 'last_result_json', width: 130, ellipsis: true },
  { title: 'Enabled', key: 'enabled', width: 90 },
  { title: 'Actions', key: 'actions', width: 160, fixed: 'right' },
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
  const parts = [`found ${r.found}`]
  if (r.saved > 0) parts.push(`${r.saved} auto-added`)
  if (r.skipped > 0) parts.push(`${r.skipped} skipped`)
  return parts.join(' · ')
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

function confirmDeleteSelected() {
  const count = selectedUuids.value.length
  Modal.confirm({
    title: `Delete ${count} rule${count !== 1 ? 's' : ''}?`,
    okType: 'danger',
    okText: `Delete ${count}`,
    async onOk() {
      deleting.value = true
      try {
        await Promise.allSettled(selectedUuids.value.map((uuid) => discoveryRulesApi.remove(uuid)))
        selectedUuids.value = []
        message.success(`Deleted ${count} rule${count !== 1 ? 's' : ''}`)
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
    await Promise.allSettled(uuids.map((uuid) => discoveryRulesApi.update(uuid, { enabled: true })))
    selectedUuids.value = []
    message.success(`Enabled ${uuids.length} rule${uuids.length !== 1 ? 's' : ''}`)
    await load()
  } finally {
    bulkEnabling.value = false
  }
}

async function bulkDisable() {
  const uuids = [...selectedUuids.value]
  bulkDisabling.value = true
  try {
    await Promise.allSettled(uuids.map((uuid) => discoveryRulesApi.update(uuid, { enabled: false })))
    selectedUuids.value = []
    message.success(`Disabled ${uuids.length} rule${uuids.length !== 1 ? 's' : ''}`)
    await load()
  } finally {
    bulkDisabling.value = false
  }
}

onMounted(load)
</script>

<template>
  <AppLayout title="Discovery">
    <a-tabs :active-key="activeTab" @change="onTabChange">

      <!-- ── Rules tab ───────────────────────────────────────────────────── -->
      <a-tab-pane key="rules" tab="Rules">
        <div class="toolbar">
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
            <span v-else style="color: #888; font-size: 13px">
              Scheduled protocol scans — runs automatically, or trigger manually.
            </span>
          </a-space>
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
          :scroll="{ x: 'max-content' }"
          :row-selection="rowSelection"
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
              <span :style="{ color: record.last_result_json?.error ? '#cf1322' : '#888', fontSize: '12px' }">
                {{ resultSummary(record) }}
              </span>
            </template>

            <template v-else-if="column.key === 'enabled'">
              <a-switch :checked="record.enabled" size="small" @change="toggleEnabled(record)" />
            </template>

            <template v-else-if="column.key === 'actions'">
              <a-space>
                <a-button size="small" title="Run and review results" @click="openScanDrawer(record)">
                  <template #icon><PlayCircleOutlined /></template>
                </a-button>
                <a-button size="small" title="Run history" @click="openRunsDrawer(record)">
                  <template #icon><HistoryOutlined /></template>
                </a-button>
                <a-button size="small" @click="openEdit(record)">Edit</a-button>
                <a-button size="small" danger @click="confirmDelete(record)">
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </a-space>
            </template>
          </template>
        </a-table>
      </a-tab-pane>

      <!-- ── Recent runs tab ────────────────────────────────────────────── -->
      <a-tab-pane key="runs" tab="Recent Runs">
        <div style="display: flex; justify-content: flex-end; margin-bottom: 12px">
          <a-button size="small" :loading="recentRunsLoading" @click="loadRecentRuns">
            Refresh
          </a-button>
        </div>

        <a-table
          :columns="recentRunsColumns"
          :data-source="recentRuns"
          :loading="recentRunsLoading"
          :pagination="{ pageSize: 20, showSizeChanger: false }"
          row-key="id"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'rule'">
              <span style="font-size: 12px">{{ record.rule_name }}</span>
              <a-tag :color="protocolColor(record.protocol)" style="margin-left: 6px; font-size: 11px">
                {{ record.protocol }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'started_at'">
              <span style="font-size: 12px; color: #888">{{ fmtDate(record.started_at) }}</span>
            </template>
            <template v-else-if="column.key === 'duration_ms'">
              <span style="font-size: 12px; color: #888">{{ fmtDuration(record.duration_ms) }}</span>
            </template>
            <template v-else-if="column.key === 'status'">
              <a-badge :status="STATUS_COLOR[record.status]" :text="record.status" />
            </template>
            <template v-else-if="column.key === 'trigger'">
              <a-tag :color="record.trigger === 'manual' ? 'blue' : 'default'" style="font-size: 11px">
                {{ record.trigger }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'result'">
              <span v-if="record.error" style="font-size: 11px; color: #cf1322">{{ record.error }}</span>
              <span v-else style="font-size: 12px; color: #888">
                found {{ record.found }}
                <template v-if="record.saved > 0"> · {{ record.saved }} auto-added</template>
                <template v-if="record.skipped > 0"> · {{ record.skipped }} skipped</template>
              </span>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
              No runs yet — rules will appear here once they execute.
            </div>
          </template>
        </a-table>
      </a-tab-pane>

    </a-tabs>

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

    <DiscoveryRunsDrawer
      v-model:open="runsDrawerOpen"
      :rule="runsDrawerRule"
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
