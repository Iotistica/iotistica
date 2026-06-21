<script setup lang="ts">
import { ref, watch } from 'vue'
import { ReloadOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import type { DiscoveryRule, DiscoveryRun } from '@/types'
import { discoveryRulesApi } from '@/api/discovery'
import { protocolColor } from '@/utils/protocol'

const props = defineProps<{
  open: boolean
  rule: DiscoveryRule | null
}>()

const emit = defineEmits<{ 'update:open': [val: boolean] }>()

const runs = ref<DiscoveryRun[]>([])
const loading = ref(false)

const columns: TableColumnType<DiscoveryRun>[] = [
  { title: 'Started', key: 'started_at', width: 160 },
  { title: 'Duration', key: 'duration_ms', width: 90 },
  { title: 'Status', key: 'status', width: 90 },
  { title: 'Trigger', key: 'trigger', width: 90 },
  { title: 'Found', dataIndex: 'found', key: 'found', width: 70 },
  { title: 'Saved', dataIndex: 'saved', key: 'saved', width: 70 },
  { title: 'Error', key: 'error', ellipsis: true },
]

const STATUS_COLOR: Record<string, string> = {
  running: 'processing',
  ok:      'success',
  error:   'error',
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

async function load() {
  if (!props.rule) return
  loading.value = true
  try {
    runs.value = await discoveryRulesApi.getRuns(props.rule.uuid)
  } catch {
    // non-fatal
  } finally {
    loading.value = false
  }
}

watch(() => props.open, (open) => {
  if (open) load()
  else runs.value = []
})
</script>

<template>
  <a-drawer
    :open="open"
    :title="rule ? `Run history — ${rule.name}` : 'Run history'"
    width="700"
    @close="emit('update:open', false)"
  >
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px">
      <span v-if="rule">
        <a-tag :color="protocolColor(rule.protocol)">{{ rule.protocol }}</a-tag>
        <span style="color: #888; font-size: 12px">Last {{ runs.length }} runs</span>
      </span>
      <a-button size="small" :loading="loading" @click="load">
        <template #icon><ReloadOutlined /></template>
      </a-button>
    </div>

    <a-table
      :columns="columns"
      :data-source="runs"
      :loading="loading"
      :pagination="false"
      row-key="id"
      size="small"
      :scroll="{ y: 520 }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'started_at'">
          <span style="font-size: 12px; color: #555">{{ fmtDate(record.started_at) }}</span>
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

        <template v-else-if="column.key === 'error'">
          <span v-if="record.error" style="font-size: 11px; color: #cf1322">{{ record.error }}</span>
          <span v-else style="color: #ccc">—</span>
        </template>
      </template>

      <template #emptyText>
        <div style="padding: 32px 0; text-align: center; color: #888">
          No runs recorded yet for this rule.
        </div>
      </template>
    </a-table>
  </a-drawer>
</template>
