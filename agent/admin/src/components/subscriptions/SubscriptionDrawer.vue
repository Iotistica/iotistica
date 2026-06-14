<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Destination, Subscription, SubscriptionFormData, SubscriptionRoute } from '@/types'
import { subscriptionsApi } from '@/api/subscriptions'

const props = defineProps<{
  open: boolean
  editing: Subscription | null
  destinations: Destination[]
}>()

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const SOURCE_PROTOCOLS = ['bacnet', 'modbus', 'opcua', 'mqtt', 'system']
const PAYLOAD_FORMATS = ['custom', 'tags', 'ecp']
const COMPRESSIONS = [
  { label: 'None (global default)', value: null },
  { label: 'JSON', value: 'json' },
  { label: 'MessagePack', value: 'msgpack' },
  { label: 'JSON + Deflate', value: 'json+deflate' },
  { label: 'MessagePack + Deflate', value: 'msgpack+deflate' },
]
const QUALITIES = ['GOOD', 'BAD', 'UNCERTAIN']

const formRef = ref<FormInstance>()
const saving = ref(false)
const showAdvanced = ref(false)

const blankRoute = (): SubscriptionRoute => ({
  includeMetrics: [],
  excludeMetrics: [],
  includeDevices: [],
  excludeDevices: [],
  qualities: [],
  minIntervalMs: undefined,
  maxPointsPerMessage: undefined,
  topic: '',
})

const blankForm = (): SubscriptionFormData => ({
  publish_destination_id: props.destinations[0]?.id ?? 0,
  topics: [],
  route_json: blankRoute(),
  payload_format: 'tags',
  compression: null,
  enabled: true,
})

const form = ref<SubscriptionFormData>(blankForm())

const selectedDestination = computed(() =>
  props.destinations.find((d) => d.id === form.value.publish_destination_id) ?? null,
)

const isExternalDestination = computed(() =>
  !!selectedDestination.value && selectedDestination.value.type !== 'iotistica',
)

const destinationTopicRules = computed(() =>
  isExternalDestination.value
    ? [{ required: true, message: 'Destination topic is required for external destinations' }]
    : [],
)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    showAdvanced.value = false
    if (props.editing) {
      form.value = {
        publish_destination_id: props.editing.publish_destination_id,
        topics: [...props.editing.topics],
        route_json: props.editing.route_json ?? blankRoute(),
        payload_format: props.editing.payload_format,
        compression: props.editing.compression ?? null,
        enabled: props.editing.enabled,
      }
    } else {
      form.value = blankForm()
    }
  },
)

async function submit() {
  await formRef.value?.validate()
  saving.value = true

  const payload = { ...form.value }
  const r = payload.route_json
  const hasRouteConfig =
    r &&
    ((r.includeMetrics?.length ?? 0) > 0 ||
      (r.excludeMetrics?.length ?? 0) > 0 ||
      (r.includeDevices?.length ?? 0) > 0 ||
      (r.excludeDevices?.length ?? 0) > 0 ||
      (r.qualities?.length ?? 0) > 0 ||
      r.minIntervalMs != null ||
      r.maxPointsPerMessage != null ||
      (r.topic?.trim().length ?? 0) > 0)
  if (!hasRouteConfig) payload.route_json = null

  try {
    if (props.editing) {
      await subscriptionsApi.update(props.editing.id, payload)
      message.success('Subscription updated')
    } else {
      await subscriptionsApi.create(payload)
      message.success('Subscription created')
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
    :title="editing ? 'Edit Subscription' : 'New Subscription'"
    width="520"
    @close="close"
  >
    <a-form
      ref="formRef"
      :model="form"
      layout="vertical"
    >
      <!-- Destination -->
      <a-form-item
        label="Destination"
        name="publish_destination_id"
        :rules="[{ required: true }]"
      >
        <a-select v-model:value="form.publish_destination_id" placeholder="Select destination">
          <a-select-option
            v-for="d in destinations"
            :key="d.id"
            :value="d.id"
          >
            {{ d.name }}
            <a-tag size="small" style="margin-left: 8px">{{ d.type }}</a-tag>
          </a-select-option>
        </a-select>
      </a-form-item>

      <!-- Destination Topic -->
      <a-form-item
        label="Destination Topic"
        :name="['route_json', 'topic']"
        :rules="destinationTopicRules"
        extra="MQTT topic to publish to on the external broker (e.g. sensors/bacnet/readings)"
      >
        <a-input
          v-model:value="form.route_json!.topic"
          placeholder="e.g. sensors/bacnet/readings"
        />
      </a-form-item>

      <!-- Source Protocols -->
      <a-form-item
        label="Source Protocols"
        name="topics"
        extra="Which protocol endpoints feed this subscription. Leave empty to receive from all."
      >
        <a-select
          v-model:value="form.topics"
          mode="multiple"
          placeholder="All protocols (leave empty for all)"
        >
          <a-select-option v-for="p in SOURCE_PROTOCOLS" :key="p" :value="p">
            {{ p }}
          </a-select-option>
        </a-select>
      </a-form-item>

      <!-- Payload Format -->
      <a-form-item label="Payload Format" name="payload_format">
        <a-select v-model:value="form.payload_format">
          <a-select-option v-for="f in PAYLOAD_FORMATS" :key="f" :value="f">{{ f }}</a-select-option>
        </a-select>
      </a-form-item>

      <!-- Compression -->
      <a-form-item label="Compression" name="compression">
        <a-select v-model:value="form.compression">
          <a-select-option v-for="c in COMPRESSIONS" :key="String(c.value)" :value="c.value">
            {{ c.label }}
          </a-select-option>
        </a-select>
      </a-form-item>

      <!-- Enabled -->
      <a-form-item label="Enabled" name="enabled">
        <a-switch v-model:checked="form.enabled" />
      </a-form-item>

      <!-- Advanced routing -->
      <a-collapse
        v-model:active-key="showAdvanced"
        :bordered="false"
        ghost
        style="margin-top: 8px"
      >
        <a-collapse-panel key="true" header="Advanced Routing (optional)">
          <a-form-item label="Include metrics">
            <a-select v-model:value="form.route_json!.includeMetrics" mode="tags" :open="false" placeholder="Leave empty for all" />
          </a-form-item>
          <a-form-item label="Exclude metrics">
            <a-select v-model:value="form.route_json!.excludeMetrics" mode="tags" :open="false" />
          </a-form-item>
          <a-form-item label="Include devices">
            <a-select v-model:value="form.route_json!.includeDevices" mode="tags" :open="false" />
          </a-form-item>
          <a-form-item label="Exclude devices">
            <a-select v-model:value="form.route_json!.excludeDevices" mode="tags" :open="false" />
          </a-form-item>
          <a-form-item label="Quality filter">
            <a-checkbox-group v-model:value="form.route_json!.qualities">
              <a-checkbox v-for="q in QUALITIES" :key="q" :value="q">{{ q }}</a-checkbox>
            </a-checkbox-group>
          </a-form-item>
          <a-row :gutter="16">
            <a-col :span="12">
              <a-form-item label="Min interval (ms)">
                <a-input-number v-model:value="form.route_json!.minIntervalMs" :min="0" style="width: 100%" placeholder="None" />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item label="Max points/message">
                <a-input-number v-model:value="form.route_json!.maxPointsPerMessage" :min="1" style="width: 100%" placeholder="None" />
              </a-form-item>
            </a-col>
          </a-row>
        </a-collapse-panel>
      </a-collapse>
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
