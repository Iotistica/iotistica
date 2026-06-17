<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { DiscoveryRule, DiscoveryRuleFormData } from '@/types'
import { discoveryRulesApi } from '@/api/discovery'

const PROTOCOLS = ['bacnet', 'modbus', 'opcua', 'mqtt', 'snmp']

const INTERVAL_PRESETS = [
  { label: '5 minutes', value: 300 },
  { label: '15 minutes', value: 900 },
  { label: '1 hour', value: 3600 },
  { label: '6 hours', value: 21600 },
  { label: '24 hours', value: 86400 },
]

const props = defineProps<{
  open: boolean
  editing: DiscoveryRule | null
}>()

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const formRef = ref<FormInstance>()
const saving = ref(false)

// ── Core form ────────────────────────────────────────────────────────────────
const blankForm = (): DiscoveryRuleFormData => ({
  name: '',
  protocol: 'bacnet',
  interval_seconds: 3600,
  enabled: true,
  auto_enable: false,
  target_json: null,
  params_json: null,
})

const form = ref<DiscoveryRuleFormData>(blankForm())

// ── Per-protocol param editors ───────────────────────────────────────────────
interface BACnetParams { targets: string; timeout: number | null; maxDevices: number | null }
interface ModbusParams  { tcpHost: string; tcpPort: number | null; slaveMin: number; slaveMax: number; timeout: number | null }
interface OpcuaParams   { discoveryUrls: string }
interface MqttParams    { brokerUrl: string; topics: string; samplingDurationMs: number | null }

const bacnet = ref<BACnetParams>({ targets: '', timeout: null, maxDevices: null })
const modbus = ref<ModbusParams>({ tcpHost: '', tcpPort: null, slaveMin: 1, slaveMax: 10, timeout: null })
const opcua  = ref<OpcuaParams>({ discoveryUrls: '' })
const mqttP  = ref<MqttParams>({ brokerUrl: '', topics: '', samplingDurationMs: null })

function parseParamsInto(protocol: string, params: Record<string, any> | null): void {
  if (!params) return
  if (protocol === 'bacnet') {
    const targets = params.discoveryTargets
    bacnet.value.targets        = Array.isArray(targets) ? targets.join(', ') : (targets ?? '')
    bacnet.value.timeout        = params.timeout        ?? null
    bacnet.value.maxDevices     = params.maxDevices     ?? null
  } else if (protocol === 'modbus') {
    const range                 = params.slaveIdRange
    modbus.value.tcpHost        = params.tcpHost  ?? ''
    modbus.value.tcpPort        = params.tcpPort  ?? null
    modbus.value.slaveMin       = Array.isArray(range) ? range[0] : 1
    modbus.value.slaveMax       = Array.isArray(range) ? range[1] : 10
    modbus.value.timeout        = params.timeout  ?? null
  } else if (protocol === 'opcua') {
    const urls                  = params.discoveryUrls
    opcua.value.discoveryUrls   = Array.isArray(urls) ? urls.join(', ') : (urls ?? '')
  } else if (protocol === 'mqtt') {
    const topics                = params.topics
    mqttP.value.brokerUrl       = params.brokerUrl          ?? ''
    mqttP.value.topics          = Array.isArray(topics) ? topics.join(', ') : (topics ?? '')
    mqttP.value.samplingDurationMs = params.samplingDurationMs ?? null
  }
}

function resetProtocolParams(protocol: string): void {
  if (protocol === 'bacnet')  bacnet.value = { targets: '', timeout: null, maxDevices: null }
  if (protocol === 'modbus')  modbus.value = { tcpHost: '', tcpPort: null, slaveMin: 1, slaveMax: 10, timeout: null }
  if (protocol === 'opcua')   opcua.value  = { discoveryUrls: '' }
  if (protocol === 'mqtt')    mqttP.value  = { brokerUrl: '', topics: '', samplingDurationMs: null }
}

function buildParamsJson(protocol: string): Record<string, any> | null {
  if (protocol === 'bacnet') {
    const p: Record<string, any> = {}
    const targets = bacnet.value.targets.split(',').map(s => s.trim()).filter(Boolean)
    if (targets.length)              p.discoveryTargets = targets
    if (bacnet.value.timeout)        p.timeout          = bacnet.value.timeout
    if (bacnet.value.maxDevices)     p.maxDevices       = bacnet.value.maxDevices
    return Object.keys(p).length ? p : null
  }
  if (protocol === 'modbus') {
    const p: Record<string, any> = {}
    if (modbus.value.tcpHost)        p.tcpHost          = modbus.value.tcpHost
    if (modbus.value.tcpPort)        p.tcpPort          = modbus.value.tcpPort
    p.slaveIdRange = [modbus.value.slaveMin, modbus.value.slaveMax]
    if (modbus.value.timeout)        p.timeout          = modbus.value.timeout
    return Object.keys(p).length ? p : null
  }
  if (protocol === 'opcua') {
    const urls = opcua.value.discoveryUrls.split(',').map(s => s.trim()).filter(Boolean)
    return urls.length ? { discoveryUrls: urls } : null
  }
  if (protocol === 'mqtt') {
    const p: Record<string, any> = {}
    if (mqttP.value.brokerUrl)               p.brokerUrl          = mqttP.value.brokerUrl
    const topics = mqttP.value.topics.split(',').map(s => s.trim()).filter(Boolean)
    if (topics.length)                        p.topics             = topics
    if (mqttP.value.samplingDurationMs)       p.samplingDurationMs = mqttP.value.samplingDurationMs
    return Object.keys(p).length ? p : null
  }
  return null
}

const hasParamFields = computed(() => ['bacnet', 'modbus', 'opcua', 'mqtt'].includes(form.value.protocol))

// flush: 'sync' fires the callback immediately (synchronously) when the protocol
// changes, so the param fields are cleared before parseParamsInto repopulates them.
watch(() => form.value.protocol, (protocol) => {
  resetProtocolParams(protocol)
}, { flush: 'sync' })

watch(
  () => props.open,
  (open) => {
    if (!open) return
    if (props.editing) {
      form.value = {
        name:             props.editing.name,
        protocol:         props.editing.protocol,
        interval_seconds: props.editing.interval_seconds,
        enabled:          props.editing.enabled,
        auto_enable:      props.editing.auto_enable,
        target_json:      props.editing.target_json,
        params_json:      props.editing.params_json,
      }
      // The flush:'sync' protocol watcher has already reset the param fields
      // for this protocol. Now repopulate from the saved data.
      parseParamsInto(props.editing.protocol, props.editing.params_json)
    } else {
      form.value = blankForm()
      resetProtocolParams('bacnet')
    }
  },
)

async function submit() {
  await formRef.value?.validate()
  saving.value = true
  try {
    const payload: DiscoveryRuleFormData = {
      ...form.value,
      params_json: buildParamsJson(form.value.protocol),
    }
    if (props.editing) {
      await discoveryRulesApi.update(props.editing.uuid, payload)
      message.success('Rule updated')
    } else {
      await discoveryRulesApi.create(payload)
      message.success('Rule created')
    }
    emit('update:open', false)
    emit('saved')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Save failed')
  } finally {
    saving.value = false
  }
}

function close() {
  emit('update:open', false)
}
</script>

<template>
  <a-drawer
    :open="open"
    :title="editing ? 'Edit Discovery Rule' : 'New Discovery Rule'"
    width="500"
    @close="close"
  >
    <a-form ref="formRef" :model="form" layout="vertical">

      <!-- ── Core fields ─────────────────────────────────────────────── -->
      <a-form-item label="Name" name="name" :rules="[{ required: true, message: 'Name is required' }]">
        <a-input v-model:value="form.name" placeholder="e.g. BACnet floor 2 scan" />
      </a-form-item>

      <a-form-item label="Protocol" name="protocol" :rules="[{ required: true }]">
        <a-select v-model:value="form.protocol">
          <a-select-option v-for="p in PROTOCOLS" :key="p" :value="p">{{ p }}</a-select-option>
        </a-select>
      </a-form-item>

      <a-form-item label="Scan interval" name="interval_seconds">
        <a-select v-model:value="form.interval_seconds">
          <a-select-option v-for="p in INTERVAL_PRESETS" :key="p.value" :value="p.value">
            {{ p.label }}
          </a-select-option>
        </a-select>
      </a-form-item>

      <a-row :gutter="16">
        <a-col :span="12">
          <a-form-item label="Enabled" name="enabled">
            <a-switch v-model:checked="form.enabled" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item
            label="Auto-enable found endpoints"
            name="auto_enable"
          >
            <a-switch v-model:checked="form.auto_enable" />
          </a-form-item>
        </a-col>
      </a-row>

      <!-- ── Per-protocol scan targets ──────────────────────────────── -->
      <template v-if="hasParamFields">
        <a-divider orientation="left" style="font-size: 13px; color: #888">Scan targets (optional — uses global config if empty)</a-divider>

        <!-- BACnet -->
        <template v-if="form.protocol === 'bacnet'">
          <a-form-item
            label="Discovery targets"
            extra="IPs, CIDR ranges, or ranges — comma-separated. Empty = broadcast."
          >
            <a-textarea
              v-model:value="bacnet.targets"
              :rows="3"
              placeholder="192.168.1.0/24, 10.0.0.1-10.0.0.20, 172.16.5.100"
            />
          </a-form-item>
          <a-row :gutter="12">
            <a-col :span="12">
              <a-form-item label="Timeout (ms)">
                <a-input-number v-model:value="bacnet.timeout" :min="500" :max="60000" style="width:100%" placeholder="5000" />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item label="Max devices">
                <a-input-number v-model:value="bacnet.maxDevices" :min="1" :max="1000" style="width:100%" placeholder="100" />
              </a-form-item>
            </a-col>
          </a-row>
        </template>

        <!-- Modbus -->
        <template v-else-if="form.protocol === 'modbus'">
          <a-row :gutter="12">
            <a-col :span="16">
              <a-form-item label="TCP host">
                <a-input v-model:value="modbus.tcpHost" placeholder="192.168.1.100" />
              </a-form-item>
            </a-col>
            <a-col :span="8">
              <a-form-item label="Port">
                <a-input-number v-model:value="modbus.tcpPort" :min="1" :max="65535" style="width:100%" placeholder="502" />
              </a-form-item>
            </a-col>
          </a-row>
          <a-form-item label="Slave ID range">
            <a-row :gutter="8" style="align-items:center">
              <a-col :span="10">
                <a-input-number v-model:value="modbus.slaveMin" :min="1" :max="247" style="width:100%" placeholder="1" />
              </a-col>
              <a-col :span="4" style="text-align:center;color:#888">to</a-col>
              <a-col :span="10">
                <a-input-number v-model:value="modbus.slaveMax" :min="1" :max="247" style="width:100%" placeholder="10" />
              </a-col>
            </a-row>
          </a-form-item>
          <a-form-item label="Timeout (ms)">
            <a-input-number v-model:value="modbus.timeout" :min="100" :max="30000" style="width:100%" placeholder="2000" />
          </a-form-item>
        </template>

        <!-- OPC-UA -->
        <template v-else-if="form.protocol === 'opcua'">
          <a-form-item
            label="Discovery URLs"
            extra="OPC-UA server endpoints — comma-separated."
          >
            <a-textarea
              v-model:value="opcua.discoveryUrls"
              :rows="3"
              placeholder="opc.tcp://192.168.1.50:4840, opc.tcp://plc.local:4840"
            />
          </a-form-item>
        </template>

        <!-- MQTT -->
        <template v-else-if="form.protocol === 'mqtt'">
          <a-form-item label="Broker URL">
            <a-input v-model:value="mqttP.brokerUrl" placeholder="mqtt://192.168.1.10:1883" />
          </a-form-item>
          <a-form-item
            label="Root topics"
            extra="Topics to subscribe to during discovery — comma-separated."
          >
            <a-input v-model:value="mqttP.topics" placeholder="sensors/#, devices/#" />
          </a-form-item>
          <a-form-item label="Sampling duration (ms)">
            <a-input-number v-model:value="mqttP.samplingDurationMs" :min="1000" style="width:100%" placeholder="10000" />
          </a-form-item>
        </template>

      </template>

    </a-form>

    <template #footer>
      <a-space>
        <a-button @click="close">Cancel</a-button>
        <a-button type="primary" :loading="saving" @click="submit">
          {{ editing ? 'Save' : 'Create' }}
        </a-button>
      </a-space>
    </template>
  </a-drawer>
</template>
