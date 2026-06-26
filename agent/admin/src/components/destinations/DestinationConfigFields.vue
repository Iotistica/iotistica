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

function setIn(outer: string, key: string, value: unknown) {
  const parent = (props.modelValue[outer] as Record<string, unknown>) ?? {}
  emit('update:modelValue', { ...props.modelValue, [outer]: { ...parent, [key]: value } })
}

function auth(key: string): unknown {
  return (props.modelValue.auth as Record<string, unknown>)?.[key]
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

  <!-- Iotistica cloud destination — uses provisioned credentials, no extra config needed -->
  <template v-else-if="type === 'iotistica'">
    <a-alert
      type="info"
      show-icon
      message="No configuration required"
      description="This destination publishes to Iotistica Cloud using the credentials established during provisioning. No additional fields are needed."
      style="margin-bottom: 8px"
    />
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

  <!-- Azure IoT Hub -->
  <template v-else-if="type === 'azure'">
    <a-form-item label="Hub Hostname" :rules="[{ required: true, message: 'Required' }]">
      <a-input
        :value="(cfg.hostName as string) ?? ''"
        placeholder="your-hub.azure-devices.net"
        @update:value="set('hostName', $event)"
      />
    </a-form-item>
    <a-form-item label="Device ID" :rules="[{ required: true, message: 'Required' }]">
      <a-input
        :value="(cfg.deviceId as string) ?? ''"
        placeholder="your-device-id"
        @update:value="set('deviceId', $event)"
      />
    </a-form-item>
    <a-divider orientation="left" orientation-margin="0" style="font-size: 12px; color: #888">Authentication (SAS)</a-divider>
    <a-form-item label="Shared Access Key" :rules="[{ required: true, message: 'Required' }]">
      <a-input-password
        :value="(auth('sharedAccessKey') as string) ?? ''"
        placeholder="Base64-encoded primary key from Azure portal"
        autocomplete="new-password"
        @update:value="setIn('auth', 'sharedAccessKey', $event)"
      />
    </a-form-item>
    <a-form-item label="Token TTL (seconds)">
      <a-input-number
        :value="(auth('tokenTtlSeconds') as number) ?? 3600"
        :min="300"
        :max="86400"
        :step="300"
        style="width: 100%"
        @update:value="setIn('auth', 'tokenTtlSeconds', $event)"
      />
      <div style="color: #999; font-size: 12px; margin-top: 4px">SAS token lifetime — agent auto-renews at 80% (default: 3600s)</div>
    </a-form-item>
  </template>

  <!-- AWS IoT Core -->
  <template v-else-if="type === 'aws'">
    <a-form-item label="Device Data Endpoint" :rules="[{ required: true, message: 'Required' }]">
      <a-input
        :value="(cfg.endpoint as string) ?? ''"
        placeholder="xxxxxxxxxxxx.iot.us-east-1.amazonaws.com"
        @update:value="set('endpoint', $event)"
      />
    </a-form-item>
    <a-form-item label="Port">
      <a-input-number
        :value="(cfg.port as number) ?? 8883"
        :min="1"
        :max="65535"
        style="width: 100%"
        @update:value="set('port', $event)"
      />
    </a-form-item>
    <a-form-item label="Device ID">
      <a-input
        :value="(cfg.deviceId as string) ?? ''"
        placeholder="Leave blank to use the agent UUID"
        @update:value="set('deviceId', $event)"
      />
    </a-form-item>
    <a-form-item label="Topic Template">
      <a-input
        :value="(cfg.topicTemplate as string) ?? 'devices/{deviceId}/messages/events/{endpoint}'"
        @update:value="set('topicTemplate', $event)"
      />
      <div style="color: #999; font-size: 12px; margin-top: 4px">Supports <code>{deviceId}</code> and <code>{endpoint}</code> placeholders</div>
    </a-form-item>
    <a-divider orientation="left" orientation-margin="0" style="font-size: 12px; color: #888">Authentication (mTLS)</a-divider>
    <a-form-item label="Client Certificate (PEM)" :rules="[{ required: true, message: 'Required' }]">
      <a-textarea
        :value="(auth('cert') as string) ?? ''"
        :rows="5"
        style="font-family: monospace; font-size: 11px"
        placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
        @update:value="setIn('auth', 'cert', $event)"
      />
    </a-form-item>
    <a-form-item label="Private Key (PEM)" :rules="[{ required: true, message: 'Required' }]">
      <a-textarea
        :value="(auth('key') as string) ?? ''"
        :rows="5"
        style="font-family: monospace; font-size: 11px"
        placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"
        @update:value="setIn('auth', 'key', $event)"
      />
    </a-form-item>
    <a-form-item label="CA Certificate (PEM)">
      <a-textarea
        :value="(auth('ca') as string) ?? ''"
        :rows="4"
        style="font-family: monospace; font-size: 11px"
        placeholder="Optional — Amazon Root CA (leave blank to use system roots)"
        @update:value="setIn('auth', 'ca', $event)"
      />
    </a-form-item>
  </template>

  <!-- GCP IoT Core -->
  <template v-else-if="type === 'gcp'">
    <a-form-item label="MQTT Endpoint">
      <a-input
        :value="(cfg.endpoint as string) ?? 'mqtt.googleapis.com'"
        @update:value="set('endpoint', $event)"
      />
    </a-form-item>
    <a-form-item label="Port">
      <a-input-number
        :value="(cfg.port as number) ?? 8883"
        :min="1"
        :max="65535"
        style="width: 100%"
        @update:value="set('port', $event)"
      />
    </a-form-item>
    <a-form-item label="Client ID" :rules="[{ required: true, message: 'Required' }]">
      <a-input
        :value="(cfg.clientId as string) ?? ''"
        placeholder="projects/{project}/locations/{region}/registries/{registry}/devices/{deviceId}"
        @update:value="set('clientId', $event)"
      />
      <div style="color: #999; font-size: 12px; margin-top: 4px">Full GCP resource path for the device</div>
    </a-form-item>
    <a-form-item label="Topic Template">
      <a-input
        :value="(cfg.topicTemplate as string) ?? '/devices/{deviceId}/events/{endpoint}'"
        @update:value="set('topicTemplate', $event)"
      />
      <div style="color: #999; font-size: 12px; margin-top: 4px">Supports <code>{deviceId}</code> and <code>{endpoint}</code> placeholders</div>
    </a-form-item>
    <a-divider orientation="left" orientation-margin="0" style="font-size: 12px; color: #888">Authentication (JWT)</a-divider>
    <a-form-item label="JWT Token" :rules="[{ required: true, message: 'Required' }]">
      <a-textarea
        :value="(auth('jwt') as string) ?? ''"
        :rows="4"
        style="font-family: monospace; font-size: 11px"
        placeholder="eyJ..."
        @update:value="setIn('auth', 'jwt', $event)"
      />
      <div style="color: #999; font-size: 12px; margin-top: 4px">RS256 or ES256 signed JWT — must be renewed manually when it expires</div>
    </a-form-item>
    <a-form-item label="CA Certificate (PEM)">
      <a-textarea
        :value="(cfg.ca as string) ?? ''"
        :rows="4"
        style="font-family: monospace; font-size: 11px"
        placeholder="Optional — GCP root CA (leave blank to use system roots)"
        @update:value="set('ca', $event)"
      />
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
