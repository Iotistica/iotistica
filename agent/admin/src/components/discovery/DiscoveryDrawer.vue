<script setup lang="ts">
import { ref } from 'vue'
import { message } from 'ant-design-vue'
import { SearchOutlined, CheckCircleOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import type { DiscoveredDevice, Endpoint } from '@/types'
import { discoveryApi } from '@/api/discovery'
import { endpointsApi } from '@/api/endpoints'

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const props = withDefaults(defineProps<{ open: boolean; existingEndpoints?: Endpoint[] }>(), {
  existingEndpoints: () => [],
})

const PROTOCOLS = ['modbus', 'opcua', 'mqtt', 'bacnet']
const CONFIDENCE_COLORS: Record<string, string> = { high: 'success', medium: 'warning', low: 'error' }
const PROTOCOL_LABELS: Record<string, string> = { opcua: 'OPC-UA', modbus: 'Modbus', mqtt: 'MQTT', bacnet: 'BACnet' }

const activeProtocol = ref('all')
const validate = ref(false)
const running = ref(false)
const results = ref<DiscoveredDevice[]>([])
const hasRun = ref(false)
const adding = ref<Set<string>>(new Set())
const addedThisSession = ref<Set<string>>(new Set())

function isAlreadyAdded(device: DiscoveredDevice): boolean {
  if (addedThisSession.value.has(device.fingerprint)) return true
  return props.existingEndpoints.some(
    (ep) => ep.name === device.name || (device.fingerprint && ep.uuid === device.fingerprint),
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

async function runDiscovery() {
  running.value = true
  results.value = []
  hasRun.value = false
  addedThisSession.value = new Set()
  try {
    results.value = await discoveryApi.run({
      protocols: activeProtocol.value === 'all' ? [...PROTOCOLS] : [activeProtocol.value],
      validate: validate.value,
      forceRun: true,
    })
    hasRun.value = true
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Discovery failed')
  } finally {
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
  emit('update:open', false)
}
</script>

<template>
  <a-drawer
    :open="open"
    title="Discover Endpoints"
    width="640"
    @close="close"
  >
    <div class="options">
      <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
        <a-radio-group v-model:value="activeProtocol" button-style="solid" size="small">
          <a-radio-button value="all">All</a-radio-button>
          <a-radio-button v-for="p in PROTOCOLS" :key="p" :value="p">
            {{ PROTOCOL_LABELS[p] ?? p }}
          </a-radio-button>
        </a-radio-group>
        <a-checkbox v-model:checked="validate" style="font-size: 13px">
          Validate
        </a-checkbox>
      </div>
      <a-button
        type="primary"
        :loading="running"
        style="margin-top: 12px"
        @click="runDiscovery"
      >
        <template #icon><SearchOutlined /></template>
        {{ running ? 'Scanning…' : hasRun ? 'Scan Again' : 'Run Discovery' }}
      </a-button>
    </div>

    <a-divider v-if="hasRun" />

    <template v-if="hasRun">
      <div v-if="!results.length" style="color: #999; padding: 24px 0; text-align: center">
        No devices found. Try enabling more protocols or expanding the scan range.
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
              <a-tag>{{ PROTOCOL_LABELS[record.protocol] ?? record.protocol }}</a-tag>
            </template>

            <template v-else-if="column.key === 'connection'">
              <span style="font-size: 12px; color: #555">{{ connSummary(record) }}</span>
            </template>

            <template v-else-if="column.key === 'confidence'">
              <a-tag :color="CONFIDENCE_COLORS[record.confidence]">
                {{ record.confidence }}
              </a-tag>
            </template>

            <template v-else-if="column.key === 'actions'">
              <a-button
                v-if="isAlreadyAdded(record)"
                size="small"
                disabled
              >
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
.options {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
