<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import {
  ReloadOutlined,
  DeleteOutlined,
  PlusOutlined,
  SaveOutlined,
} from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { useProStatus } from '@/composables/useProStatus'

const { proInstalled } = useProStatus()
import { methodColor } from '@/utils/protocol'
import { anomalyApi } from '@/api/anomaly'
import { destinationsApi } from '@/api/destinations'
import { sourcesApi } from '@/api/sources'
import type {
  AnomalyBaseline,
  AnomalyConfig,
  AnomalyMetricConfig,
  DetectionMethod,
  Destination,
  EdgeAnomalyEvent,
  EdgeAnomalyIncident,
  EdgeAnomalyAlert,
} from '@/types'

// ── Shared ────────────────────────────────────────────────────────────────────
const activeTab = ref('incidents')

const SEVERITY_TAG_COLOR: Record<string, string> = {
  critical: 'red',
  warning: 'orange',
  info: 'blue',
}

const GUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_/i
function stripGuid(metric: string): string {
  return metric ? metric.replace(GUID_PREFIX, '') : metric
}

function fmtTs(ms: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

function fmtNum(n: number | null | undefined, decimals = 3): string {
  if (n == null || isNaN(n)) return '—'
  return n.toFixed(decimals)
}

// ── Edge: Events ──────────────────────────────────────────────────────────────
const edgeEvents = ref<EdgeAnomalyEvent[]>([])
const edgeEventsTotal = ref(0)
const edgeEventsLoading = ref(false)
const edgeEventsSeverity = ref('')
const edgeEventsPage = ref(1)
const PAGE_SIZE = 50

const edgeEventColumns = [
  { title: 'Severity', key: 'severity', width: 100 },
  { title: 'Metric', dataIndex: 'metric', key: 'metric', ellipsis: true },
  { title: 'Device', dataIndex: 'device_name', key: 'device_name', width: 160, ellipsis: true },
  { title: 'Value', key: 'value', width: 90 },
  { title: 'Score', key: 'score', width: 80 },
  { title: 'Conf', key: 'conf', width: 75 },
  { title: 'Consecutive', key: 'consec', width: 90 },
  { title: 'Time', key: 'time', width: 160 },
]

async function loadEdgeEvents() {
  edgeEventsLoading.value = true
  try {
    const r = await anomalyApi.getEdgeEvents({
      severity: edgeEventsSeverity.value || undefined,
      limit: PAGE_SIZE,
      offset: (edgeEventsPage.value - 1) * PAGE_SIZE,
    })
    edgeEvents.value = r.events
    edgeEventsTotal.value = r.total
  } catch { /* non-fatal */ } finally {
    edgeEventsLoading.value = false
  }
}

// ── Edge: Incidents ───────────────────────────────────────────────────────────
const edgeIncidents = ref<EdgeAnomalyIncident[]>([])
const edgeIncidentsTotal = ref(0)
const edgeIncidentsLoading = ref(false)
const edgeIncidentsStatus = ref('')
const edgeIncidentsPage = ref(1)
const resolvingId = ref<string | null>(null)

const edgeIncidentColumns = [
  { title: 'Severity', key: 'severity', width: 95 },
  { title: 'Metric', dataIndex: 'metric', key: 'metric', ellipsis: true },
  { title: 'Device', dataIndex: 'device_name', key: 'device_name', width: 160, ellipsis: true },
  { title: 'Status', key: 'status', width: 90 },
  { title: 'Events', dataIndex: 'event_count', key: 'event_count', width: 70 },
  { title: 'Score', key: 'score', width: 80 },
  { title: 'First seen', key: 'first_seen', width: 155 },
  { title: 'Last seen', key: 'last_seen', width: 155 },
  { title: '', key: 'actions', width: 90, fixed: 'right' },
]

const INCIDENT_STATUS_COLOR: Record<string, string> = { open: 'orange', active: 'red', resolved: 'green' }

async function loadEdgeIncidents() {
  edgeIncidentsLoading.value = true
  try {
    const r = await anomalyApi.getEdgeIncidents({
      status: edgeIncidentsStatus.value || undefined,
      limit: PAGE_SIZE,
      offset: (edgeIncidentsPage.value - 1) * PAGE_SIZE,
    })
    edgeIncidents.value = r.incidents
    edgeIncidentsTotal.value = r.total
  } catch { /* non-fatal */ } finally {
    edgeIncidentsLoading.value = false
  }
}

async function resolveIncident(incident: EdgeAnomalyIncident) {
  Modal.confirm({
    title: `Resolve incident?`,
    content: `Mark "${incident.metric}" on ${incident.device_name} as resolved.`,
    okText: 'Resolve',
    async onOk() {
      resolvingId.value = incident.incident_id
      try {
        await anomalyApi.resolveIncident(incident.incident_id)
        message.success('Incident resolved')
        loadEdgeIncidents()
      } catch (err: unknown) {
        message.error((err as { message?: string })?.message ?? 'Failed to resolve')
      } finally {
        resolvingId.value = null
      }
    },
  })
}

// ── Edge: Alerts ──────────────────────────────────────────────────────────────
const edgeAlerts = ref<EdgeAnomalyAlert[]>([])
const edgeAlertsTotal = ref(0)
const edgeAlertsLoading = ref(false)
const edgeAlertsPage = ref(1)

const edgeAlertColumns = [
  { title: 'Severity', key: 'severity', width: 100 },
  { title: 'Metric', dataIndex: 'metric', key: 'metric', ellipsis: true },
  { title: 'Device', dataIndex: 'device_name', key: 'device_name', width: 160, ellipsis: true },
  { title: 'Score', key: 'score', width: 80 },
  { title: 'Message', dataIndex: 'message', key: 'message', ellipsis: true },
  { title: 'Time', key: 'time', width: 160 },
]

async function loadEdgeAlerts() {
  edgeAlertsLoading.value = true
  try {
    const r = await anomalyApi.getEdgeAlerts({ limit: PAGE_SIZE, offset: (edgeAlertsPage.value - 1) * PAGE_SIZE })
    edgeAlerts.value = r.alerts
    edgeAlertsTotal.value = r.total
  } catch { /* non-fatal */ } finally {
    edgeAlertsLoading.value = false
  }
}

// ── Baselines tab ──────────────────────────────────────────────────────────────
const baselines = ref<AnomalyBaseline[]>([])
const baselinesTotal = ref(0)
const baselinesLoading = ref(false)
const baselinesMetric = ref('')
const baselinesPage = ref(1)
const savingBaselines = ref(false)

const baselineColumns = [
  { title: 'Metric', key: 'metric', ellipsis: true },
  { title: 'Device', key: 'device_id', width: 160, ellipsis: true },
  { title: 'State', dataIndex: 'device_state', key: 'device_state', width: 100 },
  { title: 'Slot', dataIndex: 'time_slot', key: 'time_slot', width: 55 },
  { title: 'Mean', key: 'mean', width: 90 },
  { title: 'Std dev', key: 'std_dev', width: 90 },
  { title: 'Median', key: 'median', width: 90 },
  { title: 'MAD', key: 'mad', width: 90 },
  { title: 'Samples', dataIndex: 'sample_count', key: 'sample_count', width: 80 },
  { title: 'Calculated', key: 'calculated_at', width: 160 },
]

// Maps "endpoint:bacnet-pipe" → "Pioneer Gold 1" for display in the Device column.
// Built lazily from the endpoints list when the baselines tab opens.
const endpointFriendlyNames = ref<Map<string, string>>(new Map())

async function loadBaselines() {
  baselinesLoading.value = true
  try {
    const [r, endpoints] = await Promise.all([
      anomalyApi.getBaselines({
        metric: baselinesMetric.value.trim() || undefined,
        limit: PAGE_SIZE,
      }),
      endpointFriendlyNames.value.size === 0 ? sourcesApi.getAll() : Promise.resolve(null),
    ])
    baselines.value = r.baselines
    baselinesTotal.value = r.total
    if (endpoints) {
      const map = new Map<string, string>()
      for (const ep of endpoints) {
        const displayName = (ep.metadata?.objectName as string | undefined) || ep.name
        map.set(`endpoint:${ep.protocol}-pipe`, displayName)
      }
      endpointFriendlyNames.value = map
    }
  } catch { /* non-fatal */ } finally {
    baselinesLoading.value = false
  }
}

function deviceLabel(deviceId: string): string {
  if (!deviceId || deviceId === 'unknown-device') return '—'
  if (deviceId === 'system-endpoint') return 'System'
  return endpointFriendlyNames.value.get(deviceId) ?? deviceId
}

async function saveBaselines() {
  savingBaselines.value = true
  try {
    await anomalyApi.saveBaselines()
    message.success('Baselines saved')
  } catch (err: unknown) {
    message.error((err as { message?: string })?.message ?? 'Save failed')
  } finally {
    savingBaselines.value = false
  }
}

const clearingBaselines = ref(false)

async function clearAllBaselines() {
  clearingBaselines.value = true
  try {
    const { deleted } = await anomalyApi.clearBaselines()
    message.success(`Cleared ${deleted} baseline${deleted !== 1 ? 's' : ''}`)
    baselines.value = []
    baselinesTotal.value = 0
  } catch (err: unknown) {
    message.error((err as { message?: string })?.message ?? 'Clear failed')
  } finally {
    clearingBaselines.value = false
  }
}

// ── Config tab ─────────────────────────────────────────────────────────────────
const config = ref<AnomalyConfig | null>(null)
const configLoading = ref(false)
const configSaving = ref(false)
const mqttDestinations = ref<Destination[]>([])

const metricDrawerOpen = ref(false)
const editingMetricIdx = ref<number | null>(null)
const metricForm = ref<AnomalyMetricConfig>(blankMetric())
const hasExpectedRange = ref(false)
const expectedMin = ref<number | null>(null)
const expectedMax = ref<number | null>(null)

const DETECTION_METHODS: DetectionMethod[] = [
  'zscore', 'mad', 'iqr', 'expected_range', 'rate_change', 'ewma', 'fusion',
]
const SEASONALITY_OPTIONS = ['none', 'day-night', 'hourly', 'weekly']

// ── Available metric suggestions ───────────────────────────────────────────
type MetricSuggestion = {
  name: string
  score?: number
  deviceState?: string
  unit?: string
  configured: boolean
  endpointName?: string
}
const metricSuggestions = ref<MetricSuggestion[]>([])
const metricSuggestionsLoading = ref(false)

async function loadMetricSuggestions() {
  metricSuggestionsLoading.value = true
  try {
    metricSuggestions.value = await anomalyApi.getMetrics()
  } catch {
    // non-fatal
  } finally {
    metricSuggestionsLoading.value = false
  }
}

const SOURCE_LABEL: Record<string, string> = {
  live: 'Live',
  system: 'System',
  endpoint: 'Endpoint',
}
const SOURCE_COLOR: Record<string, string> = {
  live: 'green',
  system: 'blue',
  endpoint: 'default',
}

// Strip all leading UUID prefixes from canonical metric names so they display readably.
// e.g. "UUID1_UUID2_pioneer_gold_1_coil_temp" → "pioneer_gold_1_coil_temp"
const UUID_PREFIX_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_/gi
function friendlyLabel(name: string | undefined | null): string {
  if (!name) return ''
  return name.replace(UUID_PREFIX_RE, '')
}

// Build flat sorted list of metric suggestions for the autocomplete dropdown.
// Deduplicate by (endpointName, friendlyLabel) so the same metric from two
// different devices shows as two separate entries.
const metricAutocompleteOptions = computed(() => {
  const q = metricForm.value.name.toLowerCase()

  const seen = new Map<string, MetricSuggestion>()
  for (const s of metricSuggestions.value) {
    const friendly = friendlyLabel(s.name)
    if (!friendly.trim()) continue
    const key = `${s.endpointName ?? ''}|${friendly}`
    const existing = seen.get(key)
    if (!existing || (s.score ?? 0) > (existing.score ?? 0)) {
      seen.set(key, s)
    }
  }

  return Array.from(seen.entries())
    .filter(([, s]) => {
      const friendly = friendlyLabel(s.name)
      const label = s.endpointName ? `${s.endpointName} ${friendly}` : friendly
      return !q || label.toLowerCase().includes(q)
    })
    .sort(([, a], [, b]) => {
      const fa = friendlyLabel(a.name)
      const fb = friendlyLabel(b.name)
      return fa.localeCompare(fb) || (a.endpointName ?? '').localeCompare(b.endpointName ?? '')
    })
    .map(([, s]) => {
      const friendly = friendlyLabel(s.name)
      return {
        value: friendly,
        label: s.endpointName ? `${friendly} · ${s.endpointName}` : friendly,
        suggestion: s,
      }
    })
})

function blankMetric(): AnomalyMetricConfig {
  return {
    name: '',
    enabled: true,
    methods: ['mad'],
    threshold: 3.0,
    windowSize: 120,
    minConfidence: 0.7,
    cooldownMs: 300_000,
    seasonality: 'none',
  }
}

const metricColumns: TableColumnType<AnomalyMetricConfig>[] = [
  { title: 'Metric name', key: 'name', ellipsis: true },
  { title: 'Enabled', key: 'enabled', width: 80 },
  { title: 'Methods', key: 'methods', ellipsis: true },
  { title: 'Threshold', dataIndex: 'threshold', key: 'threshold', width: 100 },
  { title: 'Window', dataIndex: 'windowSize', key: 'windowSize', width: 90 },
  { title: 'Seasonality', key: 'seasonality', width: 110 },
  { title: '', key: 'actions', width: 100, fixed: 'right' },
]

async function loadConfig() {
  configLoading.value = true
  try {
    const [cfg, dests] = await Promise.all([
      anomalyApi.getConfig(),
      destinationsApi.getAll(),
    ])
    config.value = cfg
    mqttDestinations.value = dests.filter((d) => d.type === 'mqtt')
  } catch {
    // non-fatal
  } finally {
    configLoading.value = false
  }
}

async function saveConfig() {
  if (!config.value) return
  configSaving.value = true
  try {
    config.value = await anomalyApi.updateConfig(config.value)
    message.success('Configuration saved')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Save failed')
  } finally {
    configSaving.value = false
  }
}

function openAddMetric() {
  editingMetricIdx.value = null
  metricForm.value = blankMetric()
  hasExpectedRange.value = false
  expectedMin.value = null
  expectedMax.value = null
  metricDrawerOpen.value = true
  loadMetricSuggestions()
}

function openEditMetric(metric: AnomalyMetricConfig, idx: number) {
  editingMetricIdx.value = idx
  metricForm.value = { ...metric, methods: [...metric.methods] }
  hasExpectedRange.value = Array.isArray(metric.expectedRange)
  expectedMin.value = metric.expectedRange?.[0] ?? null
  expectedMax.value = metric.expectedRange?.[1] ?? null
  metricDrawerOpen.value = true
  loadMetricSuggestions()
}

async function saveMetric() {
  if (!config.value) return
  if (!metricForm.value.name.trim()) {
    message.error('Metric name is required')
    return
  }
  const entry: AnomalyMetricConfig = {
    ...metricForm.value,
    expectedRange:
      hasExpectedRange.value && expectedMin.value != null && expectedMax.value != null
        ? [expectedMin.value, expectedMax.value]
        : undefined,
  }
  if (editingMetricIdx.value !== null) {
    config.value.metrics[editingMetricIdx.value] = entry
  } else {
    config.value.metrics.push(entry)
  }
  metricDrawerOpen.value = false
  await saveConfig()
}

async function removeMetric(idx: number) {
  if (!config.value) return
  config.value.metrics.splice(idx, 1)
  await saveConfig()
}

async function toggleMetricEnabled(idx: number) {
  if (!config.value) return
  config.value.metrics[idx].enabled = !config.value.metrics[idx].enabled
  await saveConfig()
}

// ── Tab switching ──────────────────────────────────────────────────────────────
function onTabChange(tab: string) {
  activeTab.value = tab
  if (tab === 'events') loadEdgeEvents()
  else if (tab === 'incidents') loadEdgeIncidents()
  else if (tab === 'alerts') loadEdgeAlerts()
  else if (tab === 'baselines') loadBaselines()
  else if (tab === 'config') loadConfig()
  else if (tab === 'rules') { loadConfig(); loadMetricSuggestions() }
}

onMounted(loadEdgeIncidents)
</script>

<template>
  <AppLayout title="Anomalies">
    <a-alert v-if="!proInstalled" type="info" show-icon style="margin-bottom: 16px">
      <template #message>Catch anomalies before they become failures</template>
      <template #description>
        <div style="margin-top: 4px">
          <strong>Iotistica Agent Pro</strong> adds on-device ML anomaly detection — baseline tracking,
          per-metric alert rules, and trend forecasting that runs entirely on the device with no cloud
          round-trip required. Get notified the moment a sensor drifts outside its normal range.
        </div>
        <div style="margin-top: 12px">
          <a-button
            type="primary"
            size="small"
            href="https://iotistica.com/solutions.html"
            target="_blank"
            rel="noopener"
          >Upgrade to Agent Pro →</a-button>
          <a
            href="https://iotistica.com/solutions.html"
            target="_blank"
            rel="noopener"
            style="margin-left: 16px; font-size: 12px"
          >Compare plans</a>
        </div>
      </template>
    </a-alert>
    <a-tabs :active-key="activeTab" @change="onTabChange">

      <!-- ══ EVENTS ═════════════════════════════════════════════════════════ -->
      <a-tab-pane key="events" tab="Events">
        <div class="toolbar">
          <a-space>
            <a-select
              v-model:value="edgeEventsSeverity"
              placeholder="All severities"
              allow-clear
              style="width: 150px"
              @change="() => { edgeEventsPage = 1; loadEdgeEvents() }"
            >
              <a-select-option value="critical">Critical</a-select-option>
              <a-select-option value="warning">Warning</a-select-option>
              <a-select-option value="info">Info</a-select-option>
            </a-select>
            <a-button :loading="edgeEventsLoading" @click="loadEdgeEvents">
              <template #icon><ReloadOutlined /></template>
            </a-button>
          </a-space>
          <span style="color: #888; font-size: 12px">{{ edgeEventsTotal }} total</span>
        </div>
        <a-table
          :columns="edgeEventColumns"
          :data-source="edgeEvents"
          :loading="edgeEventsLoading"
          :pagination="{ current: edgeEventsPage, pageSize: PAGE_SIZE, total: edgeEventsTotal, showSizeChanger: false, onChange: (p: number) => { edgeEventsPage = p; loadEdgeEvents() } }"
          row-key="id"
          size="small"
          :scroll="{ x: true }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'severity'">
              <a-tag :color="SEVERITY_TAG_COLOR[record.severity]" :class="record.severity === 'critical' ? 'severity-critical' : ''" style="font-size: 11px; margin: 0">{{ record.severity }}</a-tag>
            </template>
            <template v-else-if="column.key === 'metric'">
              <span :title="record.metric">{{ stripGuid(record.metric) }}</span>
            </template>
            <template v-else-if="column.key === 'value'">
              <span style="font-variant-numeric: tabular-nums">{{ fmtNum(record.observed_value, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'score'">
              <span style="font-variant-numeric: tabular-nums; font-size: 12px">{{ fmtNum(record.anomaly_score, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'conf'">
              <span style="font-size: 12px">{{ Math.round(record.confidence * 100) }}%</span>
            </template>
            <template v-else-if="column.key === 'consec'">
              <span style="font-size: 12px; color: #888">{{ record.consecutive_count }}×</span>
            </template>
            <template v-else-if="column.key === 'time'">
              <span style="color: #888; font-size: 12px">{{ fmtTs(record.timestamp_ms) }}</span>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
              No anomaly events yet. Events are recorded when the anomaly detection engine triggers.
            </div>
          </template>
        </a-table>
      </a-tab-pane>

      <!-- ══ INCIDENTS ══════════════════════════════════════════════════════ -->
      <a-tab-pane key="incidents" tab="Incidents">
        <div class="toolbar">
          <a-space>
            <a-select
              v-model:value="edgeIncidentsStatus"
              placeholder="All statuses"
              allow-clear
              style="width: 150px"
              @change="() => { edgeIncidentsPage = 1; loadEdgeIncidents() }"
            >
              <a-select-option value="open">Open</a-select-option>
              <a-select-option value="active">Active</a-select-option>
              <a-select-option value="resolved">Resolved</a-select-option>
            </a-select>
            <a-button :loading="edgeIncidentsLoading" @click="loadEdgeIncidents">
              <template #icon><ReloadOutlined /></template>
            </a-button>
          </a-space>
          <span style="color: #888; font-size: 12px">{{ edgeIncidentsTotal }} total</span>
        </div>
        <a-table
          :columns="edgeIncidentColumns"
          :data-source="edgeIncidents"
          :loading="edgeIncidentsLoading"
          :pagination="{ current: edgeIncidentsPage, pageSize: PAGE_SIZE, total: edgeIncidentsTotal, showSizeChanger: false, onChange: (p: number) => { edgeIncidentsPage = p; loadEdgeIncidents() } }"
          row-key="incident_id"
          size="small"
          :scroll="{ x: true }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'severity'">
              <a-tag :color="SEVERITY_TAG_COLOR[record.severity]" :class="record.severity === 'critical' ? 'severity-critical' : ''" style="font-size: 11px; margin: 0">{{ record.severity }}</a-tag>
            </template>
            <template v-else-if="column.key === 'metric'">
              <span :title="record.metric">{{ stripGuid(record.metric) }}</span>
            </template>
            <template v-else-if="column.key === 'status'">
              <a-tag :color="INCIDENT_STATUS_COLOR[record.status]" style="font-size: 11px">{{ record.status }}</a-tag>
            </template>
            <template v-else-if="column.key === 'score'">
              <span style="font-variant-numeric: tabular-nums; font-size: 12px">{{ fmtNum(record.max_anomaly_score, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'first_seen'">
              <span style="color: #888; font-size: 12px">{{ fmtTs(record.first_seen) }}</span>
            </template>
            <template v-else-if="column.key === 'last_seen'">
              <span style="color: #888; font-size: 12px">{{ fmtTs(record.last_seen) }}</span>
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-button
                v-if="record.status !== 'resolved'"
                size="small"
                :loading="resolvingId === record.incident_id"
                @click="resolveIncident(record)"
              >Resolve</a-button>
              <span v-else style="color: #888; font-size: 12px">—</span>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
              No incidents yet. Incidents are created when multiple anomaly events share the same fingerprint.
            </div>
          </template>
        </a-table>
      </a-tab-pane>

      <!-- ══ ALERTS (edge) ══════════════════════════════════════════════════ -->
      <a-tab-pane key="alerts" tab="Alerts">
        <div class="toolbar">
          <a-button :loading="edgeAlertsLoading" @click="loadEdgeAlerts">
            <template #icon><ReloadOutlined /></template>
            Refresh
          </a-button>
          <span style="color: #888; font-size: 12px">{{ edgeAlertsTotal }} total</span>
        </div>
        <a-table
          :columns="edgeAlertColumns"
          :data-source="edgeAlerts"
          :loading="edgeAlertsLoading"
          :pagination="{ current: edgeAlertsPage, pageSize: PAGE_SIZE, total: edgeAlertsTotal, showSizeChanger: false, onChange: (p: number) => { edgeAlertsPage = p; loadEdgeAlerts() } }"
          row-key="alert_id"
          size="small"
          :scroll="{ x: true }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'severity'">
              <a-tag :color="SEVERITY_TAG_COLOR[record.severity]" :class="record.severity === 'critical' ? 'severity-critical' : ''" style="font-size: 11px; margin: 0">{{ record.severity }}</a-tag>
            </template>
            <template v-else-if="column.key === 'metric'">
              <span :title="record.metric">{{ stripGuid(record.metric) }}</span>
            </template>
            <template v-else-if="column.key === 'score'">
              <span style="font-variant-numeric: tabular-nums; font-size: 12px">{{ fmtNum(record.max_anomaly_score, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'time'">
              <span style="color: #888; font-size: 12px">{{ fmtTs(record.created_at) }}</span>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
              No alerts promoted yet. Alerts are raised when an incident accumulates enough events (critical: 1, warning: 3, info: 5).
            </div>
          </template>
        </a-table>
      </a-tab-pane>

      <!-- ══ BASELINES ══════════════════════════════════════════════════════ -->
      <a-tab-pane key="baselines" tab="Baselines">
        <div class="toolbar">
          <a-space>
            <a-input
              v-model:value="baselinesMetric"
              placeholder="Filter by metric…"
              allow-clear
              style="width: 220px"
              @pressEnter="() => { baselinesPage = 1; loadBaselines() }"
              @change="(e: Event) => { if (!(e.target as HTMLInputElement).value) { baselinesPage = 1; loadBaselines() } }"
            />
            <a-button :loading="baselinesLoading" @click="() => { baselinesPage = 1; loadBaselines() }">
              <template #icon><ReloadOutlined /></template>
            </a-button>
          </a-space>
          <a-space>
            <span style="color: #888; font-size: 12px">{{ baselinesTotal }} total</span>
            <a-button :loading="savingBaselines" @click="saveBaselines">
              <template #icon><SaveOutlined /></template>
              Save to disk
            </a-button>
            <a-popconfirm
              title="Delete all baselines? The detection engine will rebuild them from new data."
              ok-text="Clear all"
              ok-type="danger"
              @confirm="clearAllBaselines"
            >
              <a-button danger :loading="clearingBaselines">Clear all</a-button>
            </a-popconfirm>
          </a-space>
        </div>
        <a-table
          :columns="baselineColumns"
          :data-source="baselines"
          :loading="baselinesLoading"
          :pagination="{ current: baselinesPage, pageSize: PAGE_SIZE, total: baselinesTotal, showSizeChanger: false, onChange: (p: number) => { baselinesPage = p; loadBaselines() } }"
          row-key="metric"
          size="small"
          :scroll="{ x: true }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'metric'">
              <span :title="record.metric" style="font-size: 12px">{{ friendlyLabel(record.metric) }}</span>
            </template>
            <template v-else-if="column.key === 'device_id'">
              <span :title="record.device_id" style="font-size: 12px">{{ deviceLabel(record.device_id) }}</span>
            </template>
            <template v-else-if="column.key === 'mean'">
              <span style="font-variant-numeric: tabular-nums; font-size: 12px">{{ fmtNum(record.mean, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'std_dev'">
              <span style="font-variant-numeric: tabular-nums; font-size: 12px">{{ fmtNum(record.std_dev, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'median'">
              <span style="font-variant-numeric: tabular-nums; font-size: 12px">{{ fmtNum(record.median, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'mad'">
              <span style="font-variant-numeric: tabular-nums; font-size: 12px">{{ fmtNum(record.mad, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'calculated_at'">
              <span style="color: #888; font-size: 12px">{{ fmtTs(record.calculated_at) }}</span>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
              No baselines yet — baselines are built up as metric data flows through the anomaly detection engine.
            </div>
          </template>
        </a-table>
      </a-tab-pane>

      <!-- ══ RULES ══════════════════════════════════════════════════════════ -->
      <a-tab-pane key="rules" tab="Rules">
        <a-spin :spinning="configLoading">
          <template v-if="config">
            <div class="toolbar">
              <span style="color: #888; font-size: 13px">
                Per-metric anomaly detection rules — thresholds, methods, and seasonality.
              </span>
              <a-button type="primary" @click="openAddMetric">
                <template #icon><PlusOutlined /></template>
                Add metric
              </a-button>
            </div>

            <a-table
              :columns="metricColumns"
              :data-source="config.metrics"
              :pagination="false"
              row-key="name"
              size="middle"
            >
              <template #bodyCell="{ column, record, index }">
                <template v-if="column.key === 'name'">
                  <span :title="record.name" style="font-size: 12px">{{ friendlyLabel(record.name) }}</span>
                </template>
                <template v-else-if="column.key === 'enabled'">
                  <a-switch
                    :checked="record.enabled"
                    size="small"
                    @change="toggleMetricEnabled(index)"
                  />
                </template>

                <template v-else-if="column.key === 'methods'">
                  <a-tag
                    v-for="m in record.methods"
                    :key="m"
                    :color="methodColor(m)"
                    style="font-size: 11px; margin: 1px"
                  >{{ m }}</a-tag>
                </template>

                <template v-else-if="column.key === 'seasonality'">
                  <span style="color: #888; font-size: 12px">{{ record.seasonality || 'none' }}</span>
                </template>

                <template v-else-if="column.key === 'actions'">
                  <a-space>
                    <a-button size="small" @click="openEditMetric(record, index)">Edit</a-button>
                    <a-button size="small" danger @click="removeMetric(index)">
                      <template #icon><DeleteOutlined /></template>
                    </a-button>
                  </a-space>
                </template>
              </template>
              <template #emptyText>
                <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
                  No metric rules yet — click "Add metric" to define anomaly detection for a metric.
                </div>
              </template>
            </a-table>
          </template>

          <div v-else-if="!configLoading" style="padding: 48px 0; text-align: center; color: #aaa; font-size: 13px">
            No configuration loaded — check the agent connection.
          </div>
        </a-spin>
      </a-tab-pane>

      <!-- ══ CONFIG ══════════════════════════════════════════════════════════ -->
      <a-tab-pane key="config" tab="Configuration">
        <a-spin :spinning="configLoading">
          <template v-if="config">
            <!-- Global settings -->
            <a-card title="Global settings" size="small" style="margin-bottom: 16px">
              <a-alert
                type="info"
                show-icon
                message="Anomaly detection is enabled or disabled in Settings → Features."
                style="margin-bottom: 16px"
              />
              <a-row :gutter="[16, 16]">
                <a-col :span="8">
                  <a-form-item label="Sensitivity (1–10)" style="margin-bottom: 0">
                    <a-slider
                      v-model:value="config.sensitivity"
                      :min="1"
                      :max="10"
                      :marks="{ 1: '1', 5: '5', 10: '10' }"
                    />
                  </a-form-item>
                </a-col>
                <a-col :span="5">
                  <a-form-item label="Warm-up period (ms)" style="margin-bottom: 0">
                    <a-input-number v-model:value="config.warmupPeriodMs" :min="0" :step="60000" style="width: 100%" placeholder="900000" />
                  </a-form-item>
                </a-col>
                <a-col :span="4">
                  <a-form-item label="Min confidence" style="margin-bottom: 0">
                    <a-input-number v-model:value="config.alerts.minConfidence" :min="0" :max="1" :step="0.05" style="width: 100%" />
                  </a-form-item>
                </a-col>
                <a-col :span="5">
                  <a-form-item label="Cooldown (ms)" style="margin-bottom: 0">
                    <a-input-number v-model:value="config.alerts.cooldownMs" :min="0" :step="60000" style="width: 100%" />
                  </a-form-item>
                </a-col>
                <a-col :span="4">
                  <a-form-item label="Max queue size" style="margin-bottom: 0">
                    <a-input-number v-model:value="config.alerts.maxQueueSize" :min="1" style="width: 100%" />
                  </a-form-item>
                </a-col>
              </a-row>
            </a-card>

            <!-- Alert routing -->
            <a-card title="Alert routing" size="small" style="margin-bottom: 16px">
              <a-row :gutter="16" align="bottom">
                <a-col :flex="'80px'">
                  <a-form-item label="MQTT alerts">
                    <a-switch v-model:checked="config.alerts.mqtt" />
                  </a-form-item>
                </a-col>
              </a-row>

              <!-- MQTT destination (standalone / local broker) -->
              <a-divider style="margin: 4px 0 16px" />
              <a-row :gutter="16">
                <a-col :flex="'280px'">
                  <a-form-item
                    label="MQTT destination"
                    extra="Local broker from the Destinations page (standalone mode)."
                  >
                    <a-select
                      :value="config.alerts.alertDestinationId"
                      allow-clear
                      placeholder="None (use cloud MQTT)"
                      style="width: 100%"
                      @change="(v: number | null) => { config!.alerts.alertDestinationId = v ?? undefined }"
                    >
                      <a-select-option v-for="d in mqttDestinations" :key="d.id" :value="d.id">
                        {{ d.name }}
                      </a-select-option>
                    </a-select>
                  </a-form-item>
                </a-col>
                <a-col :flex="'280px'">
                  <a-form-item
                    label="Alert topic"
                    extra="Topic to publish to when a destination is selected."
                  >
                    <a-input
                      :value="config.alerts.alertTopic ?? ''"
                      placeholder="iotistica/alerts/anomaly"
                      @change="(e: Event) => { config!.alerts.alertTopic = (e.target as HTMLInputElement).value || undefined }"
                    />
                  </a-form-item>
                </a-col>
              </a-row>
            </a-card>

            <!-- Storage -->
            <a-card title="Storage" size="small" style="margin-bottom: 16px">
              <a-row :gutter="16" align="bottom">
                <a-col :flex="'none'">
                  <a-form-item label="Retention (days)">
                    <a-input-number
                      :value="config.storage?.retention"
                      :min="1"
                      style="width: 140px"
                      @change="(v: number) => { if (!config!.storage) config!.storage = { retention: v }; else config!.storage.retention = v }"
                    />
                  </a-form-item>
                </a-col>
                <a-col :flex="'none'">
                  <a-form-item label="Baseline max age (days)">
                    <a-input-number
                      :value="config.storage?.baselineMaxAgeDays"
                      :min="1"
                      style="width: 140px"
                      placeholder="7"
                      @change="(v: number) => { if (!config!.storage) config!.storage = { retention: 30, baselineMaxAgeDays: v }; else config!.storage.baselineMaxAgeDays = v }"
                    />
                  </a-form-item>
                </a-col>
                <a-col :flex="'none'">
                  <a-form-item label="Min samples for baseline">
                    <a-input-number
                      :value="config.storage?.minSamples"
                      :min="1"
                      style="width: 140px"
                      placeholder="5"
                      @change="(v: number) => { if (!config!.storage) config!.storage = { retention: 30, minSamples: v }; else config!.storage.minSamples = v }"
                    />
                  </a-form-item>
                </a-col>
              </a-row>
            </a-card>

            <div style="text-align: right">
              <a-button type="primary" :loading="configSaving" @click="saveConfig">
                <template #icon><SaveOutlined /></template>
                Save configuration
              </a-button>
            </div>
          </template>

          <div v-else-if="!configLoading" style="color: #888; padding: 48px 0; text-align: center">
            Configuration not available. Click the tab to load.
          </div>
        </a-spin>
      </a-tab-pane>

    </a-tabs>

    <!-- ── Metric config drawer ─────────────────────────────────────────────── -->
    <a-drawer
      :open="metricDrawerOpen"
      :title="editingMetricIdx !== null ? 'Edit metric rule' : 'Add metric rule'"
      width="480"
      @close="metricDrawerOpen = false"
    >
      <a-form layout="vertical">
        <a-form-item label="Metric name" required>
          <a-auto-complete
            v-model:value="metricForm.name"
            :options="metricAutocompleteOptions"
            placeholder="e.g. cpu_usage, temperature"
            :filter-option="false"
            allow-clear
            style="width: 100%"
          >
            <template #option="{ value: val, suggestion }">
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px">
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ val }}</span>
                <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0">
                  <span
                    v-if="suggestion?.endpointName"
                    style="font-size: 11px; color: #888"
                  >{{ suggestion.endpointName }}</span>
                  <a-tag
                    v-if="suggestion?.configured"
                    color="purple"
                    style="font-size: 10px; line-height: 16px; padding: 0 4px; margin: 0"
                  >configured</a-tag>
                </div>
              </div>
            </template>
          </a-auto-complete>
          <div style="font-size: 11px; color: #888; margin-top: 4px">
            <a-spin v-if="metricSuggestionsLoading" size="small" />
            <template v-else-if="metricSuggestions.length">
              {{ metricSuggestions.length }} metric{{ metricSuggestions.length !== 1 ? 's' : '' }} found —
              type to filter, or enter a custom name
            </template>
            <template v-else>No metrics flowing yet — enter a name manually</template>
          </div>
        </a-form-item>

        <a-form-item label="Device name (optional)" extra="Scopes this rule to a specific device. Leave empty to match all.">
          <a-input v-model:value="metricForm.deviceName" placeholder="e.g. BACnet-Controller-1" />
        </a-form-item>

        <a-form-item label="Seasonality">
          <a-select v-model:value="metricForm.seasonality" style="width: 160px">
            <a-select-option v-for="s in SEASONALITY_OPTIONS" :key="s" :value="s">
              {{ s }}
            </a-select-option>
          </a-select>
        </a-form-item>

        <a-form-item label="Detection methods">
          <a-checkbox-group v-model:value="metricForm.methods" style="display: flex; flex-wrap: wrap; gap: 8px">
            <a-checkbox v-for="m in DETECTION_METHODS" :key="m" :value="m">{{ m }}</a-checkbox>
          </a-checkbox-group>
        </a-form-item>

        <a-row :gutter="12">
          <a-col :span="12">
            <a-form-item label="Threshold (σ / MAD multiplier)">
              <a-input-number
                v-model:value="metricForm.threshold"
                :min="0.1"
                :step="0.5"
                style="width: 100%"
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="Window size (samples)">
              <a-input-number
                v-model:value="metricForm.windowSize"
                :min="5"
                :step="10"
                style="width: 100%"
              />
            </a-form-item>
          </a-col>
        </a-row>

        <a-row :gutter="12">
          <a-col :span="12">
            <a-form-item label="Min confidence (0–1)">
              <a-input-number
                v-model:value="metricForm.minConfidence"
                :min="0"
                :max="1"
                :step="0.05"
                style="width: 100%"
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="Cooldown (ms)">
              <a-input-number
                v-model:value="metricForm.cooldownMs"
                :min="0"
                :step="60000"
                style="width: 100%"
              />
            </a-form-item>
          </a-col>
        </a-row>

        <a-form-item label="Expected range">
          <a-checkbox v-model:checked="hasExpectedRange" style="margin-bottom: 8px">
            Set hard min/max bounds
          </a-checkbox>
          <a-row v-if="hasExpectedRange" :gutter="8">
            <a-col :span="12">
              <a-input-number
                v-model:value="expectedMin"
                placeholder="Min"
                style="width: 100%"
              />
            </a-col>
            <a-col :span="12">
              <a-input-number
                v-model:value="expectedMax"
                placeholder="Max"
                style="width: 100%"
              />
            </a-col>
          </a-row>
        </a-form-item>

        <a-form-item label="Enabled">
          <a-switch v-model:checked="metricForm.enabled" />
        </a-form-item>
      </a-form>

      <template #footer>
        <a-space>
          <a-button @click="metricDrawerOpen = false">Cancel</a-button>
          <a-button type="primary" @click="saveMetric">
            {{ editingMetricIdx !== null ? 'Update' : 'Add' }}
          </a-button>
        </a-space>
      </template>
    </a-drawer>
  </AppLayout>
</template>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  gap: 8px;
  flex-wrap: wrap;
}

@keyframes severity-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.35; }
}

.severity-critical {
  animation: severity-pulse 1.2s ease-in-out infinite;
}
</style>
