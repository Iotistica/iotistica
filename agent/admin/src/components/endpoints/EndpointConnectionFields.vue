<script setup lang="ts">
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

  <!-- BACnet / fallback -->
  <template v-else>
    <a-form-item label="Configuration (JSON)" name="connection_raw">
      <a-textarea
        :value="JSON.stringify(modelValue, null, 2)"
        :rows="6"
        placeholder="{}"
        @update:value="(v: string) => { try { emit('update:modelValue', JSON.parse(v)) } catch {} }"
      />
      <div style="color: #999; font-size: 12px; margin-top: 4px">
        BACnet devices are typically added via discovery. Enter connection config as JSON if needed.
      </div>
    </a-form-item>
  </template>
</template>
