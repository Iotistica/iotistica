<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, EditOutlined, DeleteOutlined, CheckCircleOutlined, StopOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import SubscriptionDrawer from '@/components/subscriptions/SubscriptionDrawer.vue'
import type { Destination, Subscription } from '@/types'
import { subscriptionsApi } from '@/api/subscriptions'
import { destinationsApi } from '@/api/destinations'
import { settingsApi } from '@/api/settings'
import { sourcesApi } from '@/api/sources'
import { protocolColor, destinationColor } from '@/utils/protocol'
import { buildIotisticaTopicBase } from '@/utils/mqtt'

const rows = ref<Subscription[]>([])
const destinations = ref<Destination[]>([])
const deviceNames = ref<string[]>([])
const metricNames = ref<string[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const drawerOpen = ref(false)
const editing = ref<Subscription | null>(null)
const iotisticaTopicBase = ref<string | null>(null)
const selectedIds = ref<(string | number)[]>([])
const deleting = ref(false)
const bulkEnabling = ref(false)
const bulkDisabling = ref(false)

const rowSelection = computed(() => ({
  selectedRowKeys: selectedIds.value,
  onChange: (keys: (string | number)[]) => { selectedIds.value = keys },
}))

const destMap = computed<Record<number, Destination>>(() =>
  Object.fromEntries(destinations.value.map((d) => [d.id, d])),
)

const columns: TableColumnType<Subscription>[] = [
  { title: 'Destination', key: 'destination', width: 180 },
  { title: 'Type', key: 'dest_type', width: 120 },
  { title: 'Topic', key: 'topic' },
  { title: 'Source Filter', dataIndex: 'topics', key: 'topics', width: 160 },
  { title: 'Format', dataIndex: 'payload_format', key: 'payload_format', width: 100 },
  { title: 'Compression', dataIndex: 'compression', key: 'compression', width: 160 },
  { title: 'Enabled', dataIndex: 'enabled', key: 'enabled', width: 90 },
  { title: 'Actions', key: 'actions', width: 110, fixed: 'right' },
]

async function load() {
  loading.value = true
  error.value = null
  try {
    const [subs, dests, settings, endpoints] = await Promise.all([
      subscriptionsApi.getAll(),
      destinationsApi.getAll(),
      settingsApi.get(),
      sourcesApi.getAll().catch(() => [] as { name: string }[]),
    ])
    rows.value = subs
    destinations.value = dests
    deviceNames.value = endpoints.map((e) => e.name)
    metricNames.value = endpoints.flatMap((e) =>
      ((e.data_points ?? []) as { name?: string }[]).map((dp) => dp.name).filter((n): n is string => !!n),
    )
    const { uuid, tenantId } = settings.agent ?? {}
    if (uuid && tenantId) iotisticaTopicBase.value = buildIotisticaTopicBase(uuid, tenantId)
  } catch (err: unknown) {
    const e = err as { message?: string }
    error.value = e?.message ?? 'Failed to load'
  } finally {
    loading.value = false
  }
}

async function toggleEnabled(row: Subscription) {
  try {
    const updated = await subscriptionsApi.update(row.id, { enabled: !row.enabled })
    const idx = rows.value.findIndex((r) => r.id === row.id)
    if (idx !== -1) rows.value[idx] = updated
  } catch {
    message.error('Failed to update')
  }
}

function openCreate() {
  editing.value = null
  drawerOpen.value = true
}

function openEdit(row: Subscription) {
  editing.value = row
  drawerOpen.value = true
}

function confirmDelete(row: Subscription) {
  Modal.confirm({
    title: 'Delete this subscription?',
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      await subscriptionsApi.delete(row.id)
      message.success('Deleted')
      await load()
    },
  })
}

function confirmDeleteSelected() {
  const count = selectedIds.value.length
  Modal.confirm({
    title: `Delete ${count} subscription${count !== 1 ? 's' : ''}?`,
    okType: 'danger',
    okText: `Delete ${count}`,
    async onOk() {
      deleting.value = true
      try {
        await Promise.allSettled(selectedIds.value.map((id) => subscriptionsApi.delete(id as number)))
        selectedIds.value = []
        message.success(`Deleted ${count} subscription${count !== 1 ? 's' : ''}`)
        await load()
      } finally {
        deleting.value = false
      }
    },
  })
}

async function bulkEnable() {
  const ids = [...selectedIds.value] as number[]
  bulkEnabling.value = true
  try {
    await Promise.allSettled(ids.map((id) => subscriptionsApi.update(id, { enabled: true })))
    selectedIds.value = []
    message.success(`Enabled ${ids.length} subscription${ids.length !== 1 ? 's' : ''}`)
    await load()
  } finally {
    bulkEnabling.value = false
  }
}

async function bulkDisable() {
  const ids = [...selectedIds.value] as number[]
  bulkDisabling.value = true
  try {
    await Promise.allSettled(ids.map((id) => subscriptionsApi.update(id, { enabled: false })))
    selectedIds.value = []
    message.success(`Disabled ${ids.length} subscription${ids.length !== 1 ? 's' : ''}`)
    await load()
  } finally {
    bulkDisabling.value = false
  }
}

onMounted(load)
</script>

<template>
  <AppLayout title="Subscriptions">
    <div class="toolbar">
      <a-space>
        <template v-if="selectedIds.length > 0">
          <span style="font-size: 13px; color: #666">{{ selectedIds.length }} selected</span>
          <a-button :loading="bulkEnabling" @click="bulkEnable">
            <template #icon><CheckCircleOutlined /></template>
            Enable
          </a-button>
          <a-button :loading="bulkDisabling" @click="bulkDisable">
            <template #icon><StopOutlined /></template>
            Disable
          </a-button>
          <a-button danger :loading="deleting" @click="confirmDeleteSelected">
            <template #icon><DeleteOutlined /></template>
            Delete
          </a-button>
        </template>
        <a-alert
          v-if="destinations.length === 0 && !loading"
          type="warning"
          message="Create a destination first before adding subscriptions."
          show-icon
          style="padding: 4px 12px"
        />
      </a-space>
      <a-space style="margin-left: auto">
        <a-button type="primary" :disabled="destinations.length === 0" @click="openCreate">
          <template #icon><PlusOutlined /></template>
          New Subscription
        </a-button>
      </a-space>
    </div>

    <a-alert
      v-if="error"
      type="error"
      :message="error"
      show-icon
      style="margin-bottom: 16px"
    />

    <a-table
      :columns="columns"
      :data-source="rows"
      :loading="loading"
      :pagination="false"
      :row-selection="rowSelection"
      row-key="id"
      size="middle"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'destination'">
          <span v-if="destMap[record.publish_destination_id]">
            {{ destMap[record.publish_destination_id].name }}
          </span>
          <span v-else style="color: #999">ID {{ record.publish_destination_id }}</span>
        </template>

        <template v-else-if="column.key === 'dest_type'">
          <a-tag v-if="destMap[record.publish_destination_id]"
            :color="destinationColor(destMap[record.publish_destination_id].type)"
            style="margin: 0"
          >
            {{ destMap[record.publish_destination_id].type }}
          </a-tag>
          <span v-else style="color: #999">—</span>
        </template>

        <template v-else-if="column.key === 'topic'">
          <span v-if="record.route_json?.topic" style="font-family: monospace; font-size: 12px">
            {{ record.route_json.topic }}
          </span>
          <span v-else style="color: #999">—</span>
        </template>

        <template v-else-if="column.key === 'topics'">
          <template v-if="record.topics?.length">
            <a-tag v-for="t in record.topics" :key="t" :color="protocolColor(t)" style="margin-bottom: 2px">{{ t }}</a-tag>
          </template>
          <span v-else style="color: #999">all</span>
        </template>

        <template v-else-if="column.key === 'payload_format'">
          {{ record.payload_format === 'custom' ? 'Iotistica' : record.payload_format }}
        </template>

        <template v-else-if="column.key === 'compression'">
          <span v-if="record.compression">{{ record.compression }}</span>
          <span v-else style="color: #999">none</span>
        </template>

        <template v-else-if="column.key === 'enabled'">
          <a-switch
            :checked="record.enabled"
            size="small"
            @change="toggleEnabled(record)"
          />
        </template>

        <template v-else-if="column.key === 'actions'">
          <a-space>
            <a-button size="small" @click="openEdit(record)">
              <template #icon><EditOutlined /></template>
            </a-button>
            <a-button size="small" danger @click="confirmDelete(record)">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </a-space>
        </template>
      </template>
    </a-table>

    <SubscriptionDrawer
      v-model:open="drawerOpen"
      :editing="editing"
      :destinations="destinations"
      :device-names="deviceNames"
      :metric-names="metricNames"
      :iotistica-topic-base="iotisticaTopicBase ?? undefined"
      @saved="load"
    />
  </AppLayout>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
