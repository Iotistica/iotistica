<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { message } from 'ant-design-vue'
import { CheckCircleOutlined, ThunderboltOutlined, StopOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import type { DiscoveredDevice, DiscoveryRule, Endpoint } from '@/types'
import { discoveryRulesApi } from '@/api/discovery'
import { endpointsApi } from '@/api/endpoints'
import { protocolColor, protocolLabel } from '@/utils/protocol'

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const props = withDefaults(
  defineProps<{ open: boolean; preSelectedRuleUuid?: string }>(),
  { preSelectedRuleUuid: undefined },
)

const CONFIDENCE_COLORS: Record<string, string> = { high: 'success', medium: 'warning', low: 'error' }

// ── Rule ─────────────────────────────────────────────────────────────────────
const rules = ref<DiscoveryRule[]>([])
const selectedRuleUuid = ref<string | null>(null)

// ── Existing endpoints (loaded on open for "already added" check) ─────────────
const existingEndpoints = ref<Endpoint[]>([])

const selectedRule = computed(() =>
  rules.value.find((r) => r.uuid === selectedRuleUuid.value) ?? null,
)

async function loadRules() {
  try {
    rules.value = await discoveryRulesApi.getAll()
  } catch {
    // non-fatal
  }
}

// ── Scan state ───────────────────────────────────────────────────────────────
const running = ref(false)
const results = ref<DiscoveredDevice[]>([])
const hasRun = ref(false)
const adding = ref<Set<string>>(new Set())
const addedThisSession = ref<Set<string>>(new Set())
let abortController: AbortController | null = null

function stopScan() {
  abortController?.abort()
  abortController = null
  running.value = false
}

function isAlreadyAdded(device: DiscoveredDevice): boolean {
  if (addedThisSession.value.has(device.fingerprint)) return true
  return existingEndpoints.value.some((ep: Endpoint) =>
    (ep.fingerprint && ep.fingerprint === device.fingerprint) ||
    ep.name === device.name,
  )
}

const columns: TableColumnType<DiscoveredDevice>[] = [
  { title: 'Protocol', key: 'protocol', width: 100 },
  { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true },
  { title: 'Connection', key: 'connection', ellipsis: true },
  { title: 'Confidence', key: 'confidence', width: 100 },
  { title: '', key: 'actions', width: 80, fixed: 'right' },
]

function connSummary(d: DiscoveredDevice): string {
  const c = d.connection
  if (!c) return '—'
  if (d.protocol === 'modbus') {
    return c.type === 'rtu' ? String(c.serialPort ?? '') : `${c.host ?? ''}:${c.port ?? 502}`
  }
  if (d.protocol === 'opcua') return String(c.endpointUrl ?? '')
  if (d.protocol === 'mqtt') return String(c.host ?? c.url ?? '')
  return JSON.stringify(c).slice(0, 50)
}

function fmtInterval(s: number): string {
  if (s >= 86400) return `${s / 86400}d`
  if (s >= 3600) return `${s / 3600}h`
  if (s >= 60) return `${s / 60}m`
  return `${s}s`
}

async function runRuleScan() {
  if (!selectedRule.value) return
  const rule = selectedRule.value
  abortController = new AbortController()
  running.value = true
  results.value = []
  hasRun.value = false
  addedThisSession.value = new Set()
  try {
    const { devices } = await discoveryRulesApi.run(rule.uuid, abortController.signal)
    results.value = devices
    existingEndpoints.value = await endpointsApi.getAll().catch(() => existingEndpoints.value)
    hasRun.value = true
    emit('saved')
  } catch (err: unknown) {
    if ((err as any)?.code === 'ERR_CANCELED' || (err as any)?.name === 'AbortError') {
      emit('saved')
      return
    }
    const e = err as { message?: string }
    message.error(e?.message ?? 'Discovery failed')
    emit('saved')
  } finally {
    abortController = null
    running.value = false
  }
}

async function addDevice(device: DiscoveredDevice) {
  const key = device.fingerprint
  adding.value = new Set([...adding.value, key])
  try {
    await endpointsApi.create({
      name: device.name,
      protocol: device.protocol,
      connection: device.connection,
      data_points: device.dataPoints,
      metadata: device.metadata,
      fingerprint: device.fingerprint,
      poll_interval: 5000,
      enabled: true,
    })
    addedThisSession.value = new Set([...addedThisSession.value, key])
    message.success(`Added "${device.name}"`)
    emit('saved')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Failed to add endpoint')
  } finally {
    const next = new Set(adding.value)
    next.delete(key)
    adding.value = next
  }
}

function close() {
  if (running.value) stopScan()
  results.value = []
  hasRun.value = false
  emit('update:open', false)
}

// When opened, load rules + existing endpoints, select the pre-selected rule — do NOT auto-run
watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      const [, endpoints] = await Promise.all([
        loadRules(),
        endpointsApi.getAll().catch(() => [] as Endpoint[]),
      ])
      existingEndpoints.value = endpoints
      selectedRuleUuid.value = props.preSelectedRuleUuid ?? null
      results.value = []
      hasRun.value = false
      addedThisSession.value = new Set()
    }
  },
)
</script>

<template>
  <a-drawer
    :open="open"
    :title="selectedRule ? selectedRule.name : 'Run Discovery Rule'"
    width="640"
    @close="close"
  >

    <!-- Rule details -->
    <template v-if="selectedRule">
      <a-descriptions :column="2" size="small" style="margin-bottom: 16px">
        <a-descriptions-item label="Protocol">
          <a-tag :color="protocolColor(selectedRule.protocol)">
            {{ protocolLabel(selectedRule.protocol) }}
          </a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="Interval">
          {{ fmtInterval(selectedRule.interval_seconds) }}
        </a-descriptions-item>
        <a-descriptions-item label="Auto-enable">
          {{ selectedRule.auto_enable ? 'Yes' : 'No' }}
        </a-descriptions-item>
        <a-descriptions-item label="Status">
          <a-badge
            :status="selectedRule.status === 'ok' ? 'success' : selectedRule.status === 'running' ? 'processing' : selectedRule.status === 'error' ? 'error' : 'default'"
            :text="selectedRule.status"
          />
        </a-descriptions-item>
        <a-descriptions-item v-if="selectedRule.params_json" label="Targets" :span="2">
          <a-tag color="blue" style="font-size: 11px">custom targets configured</a-tag>
        </a-descriptions-item>
      </a-descriptions>

      <div style="display: flex; gap: 8px; align-items: center">
        <a-button
          type="primary"
          :loading="running"
          :disabled="running"
          @click="runRuleScan"
        >
          <template #icon><ThunderboltOutlined /></template>
          {{ running ? 'Scanning…' : hasRun ? 'Run Again' : 'Run Scan' }}
        </a-button>
        <a-button v-if="running" danger @click="stopScan">
          <template #icon><StopOutlined /></template>
          Stop
        </a-button>
        <span style="color: #aaa; font-size: 12px; margin-left: 4px">
          Results are shown below — endpoints are not added automatically.
        </span>
      </div>
    </template>

    <!-- Fallback if no rule resolved -->
    <a-empty v-else description="No rule selected" style="margin: 40px 0" />

    <!-- ── Results ───────────────────────────────────────────────────── -->
    <template v-if="hasRun">
      <a-divider />
      <div v-if="!results.length" style="color: #999; padding: 24px 0; text-align: center">
        No devices found. Try expanding the scan range or checking network connectivity.
      </div>
      <template v-else>
        <div style="margin-bottom: 12px; color: #666; font-size: 13px">
          Found {{ results.length }} device{{ results.length !== 1 ? 's' : '' }}
        </div>
        <a-table
          :columns="columns"
          :data-source="results"
          :pagination="false"
          row-key="fingerprint"
          size="small"
          :scroll="{ x: true }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'protocol'">
              <a-tag :color="protocolColor(record.protocol)">{{ protocolLabel(record.protocol) }}</a-tag>
            </template>
            <template v-else-if="column.key === 'connection'">
              <span style="font-size: 12px; color: #555">{{ connSummary(record) }}</span>
            </template>
            <template v-else-if="column.key === 'confidence'">
              <a-tag :color="CONFIDENCE_COLORS[record.confidence]">{{ record.confidence }}</a-tag>
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-button v-if="isAlreadyAdded(record)" size="small" disabled>
                <template #icon><CheckCircleOutlined style="color: #52c41a" /></template>
              </a-button>
              <a-button
                v-else
                size="small"
                type="primary"
                ghost
                :loading="adding.has(record.fingerprint)"
                @click="addDevice(record)"
              >
                Add
              </a-button>
            </template>
          </template>
        </a-table>
      </template>
    </template>

    <template #footer>
      <a-button @click="close">Close</a-button>
    </template>
  </a-drawer>
</template>
