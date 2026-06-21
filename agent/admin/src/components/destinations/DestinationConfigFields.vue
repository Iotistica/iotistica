<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  type: string
  modelValue: Record<string, unknown>
}>()

const emit = defineEmits<{
  'update:modelValue': [val: Record<string, unknown>]
}>()

const cfg = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val),
})

function set(key: string, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
</script>

<template>
  <!-- MQTT destination -->
  <template v-if="type === 'mqtt'">
    <a-form-item label="Host" :name="['config_json', 'host']" :rules="[{ required: true, message: 'Host is required' }]">
      <a-input :value="(cfg.host as string) ?? ''" placeholder="e.g. 192.168.1.100" @update:value="set('host', $event)" />
    </a-form-item>
    <a-form-item label="Port" :name="['config_json', 'port']">
      <a-input-number :value="(cfg.port as number) ?? 1883" :min="1" :max="65535" style="width: 100%" @update:value="set('port', $event)" />
    </a-form-item>
    <a-form-item label="Username" :name="['config_json', 'username']">
      <a-input :value="(cfg.username as string) ?? ''" autocomplete="off" @update:value="set('username', $event)" />
    </a-form-item>
    <a-form-item label="Password" :name="['config_json', 'password']">
      <a-input-password :value="(cfg.password as string) ?? ''" autocomplete="new-password" @update:value="set('password', $event)" />
    </a-form-item>
    <a-form-item label="Client ID" :name="['config_json', 'clientId']">
      <a-input :value="(cfg.clientId as string) ?? ''" placeholder="Optional — auto-generated if empty" @update:value="set('clientId', $event)" />
    </a-form-item>
    <a-form-item label="Topic prefix" :name="['config_json', 'topicPrefix']">
      <a-input :value="(cfg.topicPrefix as string) ?? ''" placeholder="e.g. edge/device01" @update:value="set('topicPrefix', $event)" />
    </a-form-item>
  </template>

  <!-- Iotistica cloud destination -->
  <template v-else-if="type === 'iotistica'">
    <a-form-item label="API URL" :name="['config_json', 'apiUrl']">
      <a-input :value="(cfg.apiUrl as string) ?? ''" placeholder="https://api.iotistica.com" @update:value="set('apiUrl', $event)" />
    </a-form-item>
    <a-form-item label="API Key" :name="['config_json', 'apiKey']">
      <a-input-password :value="(cfg.apiKey as string) ?? ''" autocomplete="new-password" @update:value="set('apiKey', $event)" />
    </a-form-item>
  </template>

  <!-- InfluxDB 2.x destination -->
  <template v-else-if="type === 'influxdb'">
    <a-form-item label="URL" :name="['config_json', 'url']" :rules="[{ required: true, message: 'URL is required' }]">
      <a-input :value="(cfg.url as string) ?? ''" placeholder="http://influx:8086" @update:value="set('url', $event)" />
    </a-form-item>
    <a-form-item label="Org" :name="['config_json', 'org']" :rules="[{ required: true, message: 'Org is required' }]">
      <a-input :value="(cfg.org as string) ?? ''" placeholder="e.g. MyOrg" @update:value="set('org', $event)" />
    </a-form-item>
    <a-form-item label="Bucket" :name="['config_json', 'bucket']" :rules="[{ required: true, message: 'Bucket is required' }]">
      <a-input :value="(cfg.bucket as string) ?? ''" placeholder="e.g. sensors" @update:value="set('bucket', $event)" />
    </a-form-item>
    <a-form-item label="Token" :name="['config_json', 'token']" :rules="[{ required: true, message: 'Token is required' }]">
      <a-input-password :value="(cfg.token as string) ?? ''" autocomplete="new-password" @update:value="set('token', $event)" />
    </a-form-item>
    <a-form-item label="Batch size" :name="['config_json', 'batchSize']">
      <a-input-number
        :value="(cfg.batchSize as number) ?? 1000"
        :min="1"
        :max="10000"
        style="width: 100%"
        @update:value="set('batchSize', $event)"
      />
      <div style="color: #999; font-size: 12px; margin-top: 4px">Points buffered before auto-flush (default: 1000)</div>
    </a-form-item>
    <a-form-item label="Flush interval (ms)" :name="['config_json', 'flushInterval']">
      <a-input-number
        :value="(cfg.flushInterval as number) ?? 10000"
        :min="1000"
        :max="300000"
        :step="1000"
        style="width: 100%"
        @update:value="set('flushInterval', $event)"
      />
      <div style="color: #999; font-size: 12px; margin-top: 4px">Max ms between flushes (default: 10 000)</div>
    </a-form-item>
    <a-form-item label="Timeout (ms)" :name="['config_json', 'timeout']">
      <a-input-number
        :value="(cfg.timeout as number) ?? 10000"
        :min="1000"
        :max="120000"
        :step="1000"
        style="width: 100%"
        @update:value="set('timeout', $event)"
      />
    </a-form-item>
    <a-form-item label="Verify TLS certificate" :name="['config_json', 'rejectUnauthorized']">
      <a-switch :checked="(cfg.rejectUnauthorized as boolean) !== false" @change="set('rejectUnauthorized', $event)" />
    </a-form-item>
  </template>

  <!-- Azure / AWS / GCP — raw JSON for now -->
  <template v-else-if="['azure', 'aws', 'gcp'].includes(type)">
    <a-form-item label="Configuration (JSON)" name="config_json_raw">
      <a-textarea
        :value="JSON.stringify(cfg, null, 2)"
        :rows="8"
        placeholder="{}"
        @update:value="(v: string) => { try { emit('update:modelValue', JSON.parse(v)) } catch {} }"
      />
      <div style="color: #999; font-size: 12px; margin-top: 4px">
        Enter the connection configuration as a JSON object.
      </div>
    </a-form-item>
  </template>

  <!-- Unknown / custom type -->
  <template v-else>
    <a-form-item label="Configuration (JSON)" name="config_json_raw">
      <a-textarea
        :value="JSON.stringify(cfg, null, 2)"
        :rows="6"
        placeholder="{}"
        @update:value="(v: string) => { try { emit('update:modelValue', JSON.parse(v)) } catch {} }"
      />
    </a-form-item>
  </template>
</template>
