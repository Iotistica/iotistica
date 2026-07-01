<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { message } from 'ant-design-vue'
import { CheckCircleOutlined, ThunderboltOutlined, StopOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import type { DiscoveredDevice, DiscoveryRule, Endpoint } from '@/types'
import { discoveryRulesApi } from '@/api/discovery'
import { sourcesApi } from '@/api/sources'
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
const addingAll = ref(false)
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
    existingEndpoints.value = await sourcesApi.getAll().catch(() => existingEndpoints.value)
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

const connParams = computed((): Record<string, any> | null =>
  selectedRule.value?.params_json ?? null,
)

const pendingDevices = computed(() => results.value.filter((d) => !isAlreadyAdded(d)))

async function addAll() {
  addingAll.value = true
  const toAdd = pendingDevices.value
  await Promise.allSettled(toAdd.map((d) => addDevice(d)))
  addingAll.value = false
  if (toAdd.length) message.success(`Added ${toAdd.length} source${toAdd.length !== 1 ? 's' : ''}`)
}

async function addDevice(device: DiscoveredDevice) {
  const key = device.fingerprint
  adding.value = new Set([...adding.value, key])
  try {
    await sourcesApi.create({
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
        sourcesApi.getAll().catch(() => [] as Endpoint[]),
      ])
      existingEndpoints.value = endpoints
      selectedRuleUuid.value = props.preSelectedRuleUuid ?? (rules.value.length === 1 ? rules.value[0].uuid : null)
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
    title="Run Discovery"
    width="640"
    @close="close"
  >

    <!-- Rule picker -->
    <div style="margin-bottom: 20px">
      <div style="font-size: 12px; color: #888; margin-bottom: 6px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em">
        Discovery Rule
      </div>
      <a-select
        v-model:value="selectedRuleUuid"
        placeholder="Select a rule to run…"
        style="width: 100%"
        :disabled="running"
        :options="rules.map(r => ({ value: r.uuid, label: r.name }))"
        :not-found-content="rules.length === 0 ? 'No rules configured — create one on the Discovery page' : undefined"
        allow-clear
      >
        <template #option="{ value: val, label }">
          <div style="display: flex; justify-content: space-between; align-items: center">
            <span>{{ label }}</span>
            <a-tag
              :color="protocolColor(rules.find(r => r.uuid === val)?.protocol ?? '')"
              style="font-size: 11px; margin: 0"
            >
              {{ protocolLabel(rules.find(r => r.uuid === val)?.protocol ?? '') }}
            </a-tag>
          </div>
        </template>
      </a-select>
    </div>

    <!-- Rule details + run controls -->
    <template v-if="selectedRule">
      <a-descriptions :column="2" size="small" style="margin-bottom: 14px">
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
      </a-descriptions>

      <!-- Connection / scan target details -->
      <div class="conn-box" style="margin-bottom: 16px">
        <div class="conn-box-title">Scan Targets</div>

        <!-- BACnet -->
        <template v-if="selectedRule.protocol === 'bacnet'">
          <div class="conn-row">
            <span class="conn-label">Targets</span>
            <span class="conn-value">
              <template v-if="connParams?.discoveryTargets?.length">
                <a-tag
                  v-for="t in (connParams.discoveryTargets as string[])"
                  :key="t"
                  style="font-family: monospace; font-size: 11px; margin-bottom: 2px"
                >{{ t }}</a-tag>
              </template>
              <span v-else class="conn-default">Broadcast — all reachable devices on local network</span>
            </span>
          </div>
          <div v-if="connParams?.timeout" class="conn-row">
            <span class="conn-label">Timeout</span>
            <span class="conn-value">{{ connParams.timeout }} ms</span>
          </div>
          <div v-if="connParams?.maxDevices" class="conn-row">
            <span class="conn-label">Max devices</span>
            <span class="conn-value">{{ connParams.maxDevices }}</span>
          </div>
        </template>

        <!-- Modbus -->
        <template v-else-if="selectedRule.protocol === 'modbus'">
          <div class="conn-row">
            <span class="conn-label">Host</span>
            <span class="conn-value">
              <span v-if="connParams?.tcpHost" class="conn-mono">
                {{ connParams.tcpHost }}{{ connParams.tcpPort ? `:${connParams.tcpPort}` : ':502' }}
              </span>
              <span v-else class="conn-default">Using global Modbus host config</span>
            </span>
          </div>
          <div v-if="connParams?.slaveIdRange" class="conn-row">
            <span class="conn-label">Slave IDs</span>
            <span class="conn-value">{{ (connParams.slaveIdRange as number[])[0] }} – {{ (connParams.slaveIdRange as number[])[1] }}</span>
          </div>
          <div v-if="connParams?.timeout" class="conn-row">
            <span class="conn-label">Timeout</span>
            <span class="conn-value">{{ connParams.timeout }} ms</span>
          </div>
        </template>

        <!-- OPC-UA -->
        <template v-else-if="selectedRule.protocol === 'opcua'">
          <template v-if="connParams?.discoveryUrls?.length">
            <div v-for="url in (connParams.discoveryUrls as string[])" :key="url" class="conn-row">
              <span class="conn-label">URL</span>
              <span class="conn-value conn-mono">{{ url }}</span>
            </div>
          </template>
          <div v-else class="conn-row">
            <span class="conn-label">URLs</span>
            <span class="conn-value conn-default">Local Discovery Server — opc.tcp://localhost:4840</span>
          </div>
        </template>

        <!-- MQTT -->
        <template v-else-if="selectedRule.protocol === 'mqtt'">
          <div class="conn-row">
            <span class="conn-label">Broker</span>
            <span class="conn-value">
              <span v-if="connParams?.brokerUrl" class="conn-mono">{{ connParams.brokerUrl }}</span>
              <span v-else class="conn-default">Using global MQTT broker config</span>
            </span>
          </div>
          <div v-if="connParams?.topics?.length" class="conn-row">
            <span class="conn-label">Topics</span>
            <span class="conn-value">
              <a-tag
                v-for="t in (connParams.topics as string[])"
                :key="t"
                style="font-family: monospace; font-size: 11px; margin-bottom: 2px"
              >{{ t }}</a-tag>
            </span>
          </div>
          <div v-if="connParams?.samplingDurationMs" class="conn-row">
            <span class="conn-label">Sampling</span>
            <span class="conn-value">{{ ((connParams.samplingDurationMs as number) / 1000).toFixed(0) }}s</span>
          </div>
        </template>

        <!-- SNMP / other -->
        <template v-else>
          <span class="conn-default">Using global {{ selectedRule.protocol.toUpperCase() }} defaults</span>
        </template>
      </div>

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

    <!-- No rule selected yet -->
    <a-empty
      v-else-if="rules.length === 0"
      description="No discovery rules configured"
      style="margin: 40px 0"
    >
      <template #extra>
        <span style="color: #888; font-size: 13px">Go to the Discovery page to create a rule first.</span>
      </template>
    </a-empty>

    <!-- ── Results ───────────────────────────────────────────────────── -->
    <template v-if="hasRun">
      <a-divider />
      <div v-if="!results.length" style="color: #999; padding: 24px 0; text-align: center">
        No devices found. Try expanding the scan range or checking network connectivity.
      </div>
      <template v-else>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px">
          <span style="color: #666; font-size: 13px">
            Found {{ results.length }} device{{ results.length !== 1 ? 's' : '' }}
          </span>
          <a-button
            v-if="pendingDevices.length > 0"
            size="small"
            type="primary"
            :loading="addingAll"
            @click="addAll"
          >
            Add All ({{ pendingDevices.length }})
          </a-button>
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

<style scoped>
.conn-box {
  padding: 12px 14px;
  background: #fafafa;
  border: 1px solid #f0f0f0;
  border-radius: 6px;
}

.conn-box-title {
  font-size: 11px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 10px;
}

.conn-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 6px;
  font-size: 13px;
}

.conn-row:last-child {
  margin-bottom: 0;
}

.conn-label {
  width: 84px;
  flex-shrink: 0;
  color: #888;
  font-size: 12px;
  padding-top: 2px;
}

.conn-value {
  flex: 1;
  color: #333;
  line-height: 1.5;
}

.conn-mono {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
}

.conn-default {
  color: #aaa;
  font-style: italic;
}
</style>
