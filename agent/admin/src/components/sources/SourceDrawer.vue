<script setup lang="ts">
import { ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Endpoint, EndpointCreateData } from '@/types'
import { sourcesApi } from '@/api/sources'
import SourceConnectionFields from './SourceConnectionFields.vue'

const props = defineProps<{
  open: boolean
  editing: Endpoint | null
  prefill: EndpointCreateData | null
}>()

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const PROTOCOLS = ['modbus', 'opcua', 'mqtt', 'bacnet']

const formRef = ref<FormInstance>()
const saving = ref(false)

const form = ref<EndpointCreateData>({
  name: '',
  protocol: 'modbus',
  connection: {},
  poll_interval: 5000,
  enabled: true,
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    if (props.editing) {
      form.value = {
        name: props.editing.name,
        protocol: props.editing.protocol,
        connection: { ...props.editing.connection },
        poll_interval: props.editing.poll_interval,
        enabled: props.editing.enabled,
        data_points: props.editing.data_points ? [...props.editing.data_points] : undefined,
        metadata: props.editing.metadata ? { ...props.editing.metadata } : undefined,
      }
    } else if (props.prefill) {
      form.value = {
        name: props.prefill.name,
        protocol: props.prefill.protocol,
        connection: { ...props.prefill.connection },
        poll_interval: props.prefill.poll_interval ?? 5000,
        enabled: props.prefill.enabled ?? true,
      }
    } else {
      form.value = { name: '', protocol: 'modbus', connection: {}, poll_interval: 5000, enabled: true }
    }
  },
)

function onProtocolChange() {
  form.value.connection = {}
}

async function submit() {
  await formRef.value?.validate()
  saving.value = true
  try {
    if (props.editing) {
      await sourcesApi.replace(props.editing.uuid, form.value)
      message.success('Source updated')
    } else {
      await sourcesApi.create(form.value)
      message.success('Source added')
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
    :title="editing ? `Edit — ${editing.name}` : 'New Source'"
    width="480"
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
        <a-input v-model:value="form.name" placeholder="e.g. Warehouse Modbus Bus" />
      </a-form-item>

      <a-form-item label="Protocol" name="protocol">
        <a-select v-model:value="form.protocol" :disabled="!!editing" @change="onProtocolChange">
          <a-select-option v-for="p in PROTOCOLS" :key="p" :value="p">
            {{ p.toUpperCase() === 'OPCUA' ? 'OPC-UA' : p.charAt(0).toUpperCase() + p.slice(1) }}
          </a-select-option>
        </a-select>
      </a-form-item>

      <a-divider orientation="left" orientation-margin="0">Connection</a-divider>

      <SourceConnectionFields
        :protocol="form.protocol"
        :model-value="form.connection"
        @update:model-value="form.connection = $event"
      />

      <a-divider orientation="left" orientation-margin="0">Options</a-divider>

      <a-row :gutter="16">
        <a-col :span="14">
          <a-form-item label="Poll Interval (ms)" name="poll_interval">
            <a-input-number
              v-model:value="form.poll_interval"
              :min="100"
              :step="1000"
              style="width: 100%"
            />
          </a-form-item>
        </a-col>
        <a-col :span="10">
          <a-form-item label="Enabled" name="enabled">
            <a-switch v-model:checked="form.enabled" />
          </a-form-item>
        </a-col>
      </a-row>
    </a-form>

    <template #footer>
      <a-space>
        <a-button @click="close">Cancel</a-button>
        <a-button type="primary" :loading="saving" @click="submit">
          {{ editing ? 'Save' : 'Add Source' }}
        </a-button>
      </a-space>
    </template>
  </a-drawer>
</template>
