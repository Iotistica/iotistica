<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Destination, DestinationFormData } from '@/types'
import { destinationsApi } from '@/api/destinations'
import DestinationConfigFields from './DestinationConfigFields.vue'
import { useProStatus } from '@/composables/useProStatus'

const { proInstalled } = useProStatus()

const props = defineProps<{
  open: boolean
  editing: Destination | null
  provisioned?: boolean
}>()

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const ALL_DESTINATION_TYPES = ['iotistica', 'mqtt', 'influxdb', 'azure', 'aws', 'gcp']
const PRO_DESTINATION_TYPES = new Set(['influxdb', 'azure', 'aws', 'gcp'])
const DESTINATION_TYPES = computed(() =>
  props.provisioned ? ALL_DESTINATION_TYPES : ALL_DESTINATION_TYPES.filter((t) => t !== 'iotistica'),
)
const TESTABLE_TYPES = ['influxdb', 'mqtt']

const CONFIG_TEMPLATES: Record<string, Record<string, unknown>> = {
  azure: {
    provider: 'azure',
    hostName: 'your-hub.azure-devices.net',
    deviceId: 'your-device-id',
    auth: {
      type: 'sas',
      sharedAccessKey: '',
      tokenTtlSeconds: 3600,
    },
  },
  aws: {
    provider: 'aws',
    endpoint: 'xxxxxxxxxxxx.iot.us-east-1.amazonaws.com',
    port: 8883,
    deviceId: 'your-device-id',
    topicTemplate: 'devices/{deviceId}/messages/events/{endpoint}',
    auth: {
      type: 'mtls',
      cert: '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----',
      key: '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----',
      ca: '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----',
    },
  },
  gcp: {
    provider: 'gcp',
    endpoint: 'mqtt.googleapis.com',
    port: 8883,
    clientId: 'projects/{project}/locations/{region}/registries/{registry}/devices/{deviceId}',
    username: 'unused',
    topicTemplate: '/devices/{deviceId}/events/{endpoint}',
    auth: {
      type: 'jwt',
      jwt: '',
    },
    ca: '',
  },
}

function templateFor(type: string): Record<string, unknown> {
  return CONFIG_TEMPLATES[type] ? structuredClone(CONFIG_TEMPLATES[type]) : {}
}

const formRef = ref<FormInstance>()
const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; message?: string; error?: string } | null>(null)

const canTest = computed(() => TESTABLE_TYPES.includes(form.value.type))

const defaultType = computed(() => props.provisioned ? 'iotistica' : 'mqtt')

const form = ref<DestinationFormData>({
  name: '',
  type: defaultType.value,
  config_json: {},
  enabled: true,
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    testResult.value = null
    if (props.editing) {
      form.value = {
        name: props.editing.name,
        type: props.editing.type,
        config_json: props.editing.config_json ?? {},
        enabled: props.editing.enabled,
      }
    } else {
      form.value = { name: '', type: defaultType.value, config_json: templateFor(defaultType.value), enabled: true }
    }
  },
)

function onTypeChange(newType: string) {
  form.value.config_json = templateFor(newType)
  testResult.value = null
}

async function testConnection() {
  testResult.value = null
  testing.value = true
  try {
    const result = await destinationsApi.test({
      type: form.value.type,
      config_json: form.value.config_json ?? {},
    })
    testResult.value = result
  } catch (err: unknown) {
    const e = err as { message?: string }
    testResult.value = { ok: false, error: e?.message ?? 'Test failed' }
  } finally {
    testing.value = false
  }
}

async function submit() {
  await formRef.value?.validate()
  saving.value = true
  try {
    if (props.editing) {
      await destinationsApi.update(props.editing.id, form.value)
      message.success('Destination updated')
    } else {
      await destinationsApi.create(form.value)
      message.success('Destination created')
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
    :title="editing ? 'Edit Destination' : 'New Destination'"
    width="560"
    @close="close"
  >
    <a-form
      ref="formRef"
      :model="form"
      layout="vertical"
      autocomplete="off"
    >
      <a-form-item
        label="Name"
        name="name"
        :rules="[{ required: true, message: 'Name is required' }]"
      >
        <a-input v-model:value="form.name" placeholder="e.g. Cloud MQTT" />
      </a-form-item>

      <a-form-item label="Type" name="type">
        <a-select v-model:value="form.type" @change="onTypeChange">
          <a-select-option
            v-for="t in DESTINATION_TYPES"
            :key="t"
            :value="t"
            :disabled="PRO_DESTINATION_TYPES.has(t) && !proInstalled"
          >
            <a-tooltip
              v-if="PRO_DESTINATION_TYPES.has(t) && !proInstalled"
              title="Requires Pro — install @iotistica/agent-pro to enable"
            >
              <span style="color: #bbb">{{ t }}</span>
              <a-tag color="gold" style="font-size:10px;padding:0 4px;height:16px;line-height:16px;margin-left:4px;border-radius:3px">Pro</a-tag>
            </a-tooltip>
            <template v-else>
              {{ t }}
              <a-tag v-if="PRO_DESTINATION_TYPES.has(t)" color="gold" style="font-size:10px;padding:0 4px;height:16px;line-height:16px;margin-left:4px;border-radius:3px">Pro</a-tag>
            </template>
          </a-select-option>
        </a-select>
      </a-form-item>

      <a-divider orientation="left" orientation-margin="0">Connection</a-divider>

      <DestinationConfigFields
        :type="form.type"
        :model-value="form.config_json ?? {}"
        @update:model-value="form.config_json = $event"
      />

      <a-form-item label="Enabled" name="enabled">
        <a-switch v-model:checked="form.enabled" />
      </a-form-item>

      <a-alert
        v-if="testResult"
        :type="testResult.ok ? 'success' : 'error'"
        :message="testResult.ok ? testResult.message : testResult.error"
        show-icon
        style="margin-top: 4px"
      />
    </a-form>

    <template #footer>
      <a-space style="width: 100%; justify-content: space-between">
        <a-button
          v-if="canTest"
          :loading="testing"
          @click="testConnection"
        >
          Test Connection
        </a-button>
        <span v-else />
        <a-space>
          <a-button @click="close">Cancel</a-button>
          <a-button type="primary" :loading="saving" @click="submit">
            {{ editing ? 'Save' : 'Create' }}
          </a-button>
        </a-space>
      </a-space>
    </template>
  </a-drawer>
</template>
