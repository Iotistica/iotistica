<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'

const props = defineProps<{
  protocol: string
  modelValue: Record<string, unknown>
}>()

const emit = defineEmits<{
  'update:modelValue': [val: Record<string, unknown>]
}>()

function set(key: string, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

function get<T>(key: string, fallback: T): T {
  return (props.modelValue[key] as T) ?? fallback
}

// ── BACnet vendor/model data ──────────────────────────────────────────────────

interface VendorModel { name: string; type?: string; typeLabel?: string }
interface Vendor { name: string; models: VendorModel[] }

const vendors = ref<Vendor[]>([])
const vendorsLoading = ref(false)
const selectedVendor = ref<string>('')
const selectedModel = ref<string>('')

const vendorOptions = computed(() =>
  vendors.value.map(v => ({ value: v.name, label: v.name }))
)

const modelOptions = computed(() => {
  const v = vendors.value.find(v => v.name === selectedVendor.value)
  if (!v) return []
  return v.models.map(m => ({
    value: m.name,
    label: m.typeLabel ? `${m.name} (${m.typeLabel})` : m.name,
  }))
})

async function loadVendors() {
  if (vendors.value.length || vendorsLoading.value) return
  vendorsLoading.value = true
  try {
    const res = await fetch('https://raw.githubusercontent.com/Iotistica/iot-sims/main/bacnet-simulator/bacnet-vendors.json')
    if (res.ok) {
      const data = await res.json()
      vendors.value = data.vendors ?? []
    }
  } catch {
    // silently fall through — vendor picker is optional
  } finally {
    vendorsLoading.value = false
  }
}

function onVendorChange(name: string) {
  selectedVendor.value = name
  selectedModel.value = ''
}

function filterOption(input: string, opt: { label?: string }) {
  return (opt.label ?? '').toLowerCase().includes(input.toLowerCase())
}

function onModelChange(name: string) {
  selectedModel.value = name
  // Populate displayName with vendor + model if not already set
  if (name && !get('displayName', '')) {
    const label = selectedVendor.value ? `${selectedVendor.value} ${name}` : name
    set('displayName', label)
  }
}

// Load vendor list when BACnet tab becomes active
watch(() => props.protocol, (p) => { if (p === 'bacnet') loadVendors() }, { immediate: true })
onMounted(() => { if (props.protocol === 'bacnet') loadVendors() })
</script>

<template>
  <!-- Modbus -->
  <template v-if="protocol === 'modbus'">
    <a-form-item label="Type" :name="['connection', 'type']">
      <a-select :value="get('type', 'tcp')" @update:value="set('type', $event)">
        <a-select-option value="tcp">TCP</a-select-option>
        <a-select-option value="rtu">RTU (Serial)</a-select-option>
      </a-select>
    </a-form-item>

    <template v-if="get('type', 'tcp') === 'tcp'">
      <a-form-item
        label="Host"
        :name="['connection', 'host']"
        :rules="[{ required: true, message: 'Host is required' }]"
      >
        <a-input
          :value="get('host', '')"
          placeholder="e.g. 192.168.1.100"
          @update:value="set('host', $event)"
        />
      </a-form-item>
      <a-form-item label="Port" :name="['connection', 'port']">
        <a-input-number
          :value="get('port', 502)"
          :min="1"
          :max="65535"
          style="width: 100%"
          @update:value="set('port', $event)"
        />
      </a-form-item>
    </template>

    <template v-else>
      <a-form-item
        label="Serial Port"
        :name="['connection', 'serialPort']"
        :rules="[{ required: true, message: 'Serial port is required' }]"
      >
        <a-input
          :value="get('serialPort', '')"
          placeholder="e.g. /dev/ttyUSB0 or COM3"
          @update:value="set('serialPort', $event)"
        />
      </a-form-item>
      <a-form-item label="Baud Rate" :name="['connection', 'baudRate']">
        <a-select :value="get('baudRate', 9600)" @update:value="set('baudRate', $event)">
          <a-select-option :value="1200">1200</a-select-option>
          <a-select-option :value="2400">2400</a-select-option>
          <a-select-option :value="4800">4800</a-select-option>
          <a-select-option :value="9600">9600</a-select-option>
          <a-select-option :value="19200">19200</a-select-option>
          <a-select-option :value="38400">38400</a-select-option>
          <a-select-option :value="57600">57600</a-select-option>
          <a-select-option :value="115200">115200</a-select-option>
        </a-select>
      </a-form-item>
      <a-form-item label="Parity" :name="['connection', 'parity']">
        <a-select :value="get('parity', 'none')" @update:value="set('parity', $event)">
          <a-select-option value="none">None</a-select-option>
          <a-select-option value="even">Even</a-select-option>
          <a-select-option value="odd">Odd</a-select-option>
        </a-select>
      </a-form-item>
    </template>

    <a-form-item label="Timeout (ms)" :name="['connection', 'timeout']">
      <a-input-number
        :value="get('timeout', 5000)"
        :min="100"
        :step="500"
        style="width: 100%"
        @update:value="set('timeout', $event)"
      />
    </a-form-item>
  </template>

  <!-- OPC-UA -->
  <template v-else-if="protocol === 'opcua'">
    <a-form-item
      label="Endpoint URL"
      :name="['connection', 'endpointUrl']"
      :rules="[{ required: true, message: 'Endpoint URL is required' }]"
    >
      <a-input
        :value="get('endpointUrl', '')"
        placeholder="opc.tcp://192.168.1.100:4840"
        @update:value="set('endpointUrl', $event)"
      />
    </a-form-item>
    <a-form-item label="Security Mode" :name="['connection', 'securityMode']">
      <a-select :value="get('securityMode', 'None')" @update:value="set('securityMode', $event)">
        <a-select-option value="None">None</a-select-option>
        <a-select-option value="Sign">Sign</a-select-option>
        <a-select-option value="SignAndEncrypt">Sign & Encrypt</a-select-option>
      </a-select>
    </a-form-item>
    <a-form-item label="Security Policy" :name="['connection', 'securityPolicy']">
      <a-select :value="get('securityPolicy', 'None')" @update:value="set('securityPolicy', $event)">
        <a-select-option value="None">None</a-select-option>
        <a-select-option value="Basic256Sha256">Basic256Sha256</a-select-option>
        <a-select-option value="Aes128_Sha256_RsaOaep">Aes128_Sha256_RsaOaep</a-select-option>
      </a-select>
    </a-form-item>
    <a-form-item label="Username" :name="['connection', 'username']">
      <a-input
        :value="get('username', '')"
        autocomplete="off"
        @update:value="set('username', $event)"
      />
    </a-form-item>
    <a-form-item label="Password" :name="['connection', 'password']">
      <a-input-password
        :value="get('password', '')"
        autocomplete="new-password"
        @update:value="set('password', $event)"
      />
    </a-form-item>
  </template>

  <!-- MQTT -->
  <template v-else-if="protocol === 'mqtt'">
    <a-form-item
      label="Broker Host"
      :name="['connection', 'host']"
      :rules="[{ required: true, message: 'Broker host is required' }]"
    >
      <a-input
        :value="get('host', '')"
        placeholder="e.g. 192.168.1.100 or mqtt://broker.local"
        @update:value="set('host', $event)"
      />
    </a-form-item>
    <a-form-item label="Port" :name="['connection', 'port']">
      <a-input-number
        :value="get('port', 1883)"
        :min="1"
        :max="65535"
        style="width: 100%"
        @update:value="set('port', $event)"
      />
    </a-form-item>
    <a-form-item label="Username" :name="['connection', 'username']">
      <a-input
        :value="get('username', '')"
        autocomplete="off"
        @update:value="set('username', $event)"
      />
    </a-form-item>
    <a-form-item label="Password" :name="['connection', 'password']">
      <a-input-password
        :value="get('password', '')"
        autocomplete="new-password"
        @update:value="set('password', $event)"
      />
    </a-form-item>
    <a-form-item label="Topic" :name="['connection', 'topic']">
      <a-input
        :value="get('topic', '')"
        placeholder="e.g. sensors/# (optional)"
        @update:value="set('topic', $event)"
      />
    </a-form-item>
  </template>

  <!-- BACnet -->
  <template v-else-if="protocol === 'bacnet'">
    <!-- Vendor / Model pickers (optional, for reference) -->
    <a-form-item label="Vendor">
      <a-select
        v-model:value="selectedVendor"
        show-search
        allow-clear
        placeholder="Search vendor…"
        :options="vendorOptions"
        :loading="vendorsLoading"
        :filter-option="filterOption"
        @change="onVendorChange"
      />
    </a-form-item>

    <a-form-item v-if="selectedVendor" label="Model">
      <a-select
        v-model:value="selectedModel"
        show-search
        allow-clear
        placeholder="Select model…"
        :options="modelOptions"
        :filter-option="filterOption"
        @change="onModelChange"
      />
    </a-form-item>

    <a-divider v-if="selectedVendor" style="margin: 12px 0" />

    <!-- Connection fields -->
    <a-form-item
      label="IP Address"
      :name="['connection', 'ipAddress']"
      :rules="[{ required: true, message: 'IP address is required' }]"
    >
      <a-input
        :value="get('ipAddress', '')"
        placeholder="e.g. 192.168.1.50"
        @update:value="set('ipAddress', $event)"
      />
    </a-form-item>

    <a-form-item label="Port" :name="['connection', 'port']">
      <a-input-number
        :value="get('port', 47808)"
        :min="1"
        :max="65535"
        style="width: 100%"
        @update:value="set('port', $event)"
      />
    </a-form-item>

    <a-form-item
      label="Device Instance"
      :name="['connection', 'deviceInstance']"
      :rules="[{ required: true, message: 'Device instance is required' }]"
      extra="BACnet device identifier (0 – 4194303)"
    >
      <a-input-number
        :value="get('deviceInstance', undefined)"
        :min="0"
        :max="4194303"
        style="width: 100%"
        placeholder="e.g. 1001"
        @update:value="set('deviceInstance', $event)"
      />
    </a-form-item>

    <a-form-item
      label="Display Name"
      :name="['connection', 'displayName']"
      extra="Optional label shown in place of the auto-discovered BACnet objectName"
    >
      <a-input
        :value="get('displayName', '')"
        placeholder="e.g. AHU-1 Siemens PXC50"
        @update:value="set('displayName', $event)"
      />
    </a-form-item>
  </template>

  <!-- Fallback for unknown protocols -->
  <template v-else>
    <a-form-item label="Configuration (JSON)" name="connection_raw">
      <a-textarea
        :value="JSON.stringify(modelValue, null, 2)"
        :rows="6"
        placeholder="{}"
        @update:value="(v: string) => { try { emit('update:modelValue', JSON.parse(v)) } catch {} }"
      />
    </a-form-item>
  </template>
</template>
