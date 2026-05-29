<script setup lang="ts">
import { ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Destination, DestinationFormData } from '@/types'
import { destinationsApi } from '@/api/destinations'
import DestinationConfigFields from './DestinationConfigFields.vue'

const props = defineProps<{
  open: boolean
  editing: Destination | null
}>()

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const DESTINATION_TYPES = ['iotistica', 'mqtt', 'azure', 'aws', 'gcp']

const formRef = ref<FormInstance>()
const saving = ref(false)

const form = ref<DestinationFormData>({
  name: '',
  type: 'iotistica',
  config_json: {},
  enabled: true,
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    if (props.editing) {
      form.value = {
        name: props.editing.name,
        type: props.editing.type,
        config_json: props.editing.config_json ?? {},
        enabled: props.editing.enabled,
      }
    } else {
      form.value = { name: '', type: 'iotistica', config_json: {}, enabled: true }
    }
  },
)

// Reset config_json when type changes so stale fields don't carry over
function onTypeChange() {
  form.value.config_json = {}
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
        <a-input v-model:value="form.name" placeholder="e.g. Cloud MQTT" />
      </a-form-item>

      <a-form-item label="Type" name="type">
        <a-select v-model:value="form.type" @change="onTypeChange">
          <a-select-option v-for="t in DESTINATION_TYPES" :key="t" :value="t">
            {{ t }}
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
