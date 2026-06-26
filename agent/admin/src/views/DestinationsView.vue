<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import DestinationDrawer from '@/components/destinations/DestinationDrawer.vue'
import type { Destination } from '@/types'
import { destinationsApi } from '@/api/destinations'
import { settingsApi } from '@/api/settings'
import { destinationColor } from '@/utils/protocol'

const rows = ref<Destination[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const drawerOpen = ref(false)
const editing = ref<Destination | null>(null)
const activeType = ref('all')
const provisioned = ref(false)

const availableTypes = computed(() => [...new Set(rows.value.map((r) => r.type))].sort())

const filteredRows = computed(() =>
  activeType.value === 'all' ? rows.value : rows.value.filter((r) => r.type === activeType.value),
)

const columns: TableColumnType<Destination>[] = [
  { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true },
  { title: 'Type', dataIndex: 'type', key: 'type', width: 110 },
  { title: 'Enabled', dataIndex: 'enabled', key: 'enabled', width: 90 },
  { title: 'Last Error', dataIndex: 'last_error', key: 'last_error', ellipsis: true },
  { title: 'Actions', key: 'actions', width: 110, fixed: 'right' },
]

async function load() {
  loading.value = true
  error.value = null
  try {
    rows.value = await destinationsApi.getAll()
  } catch (err: unknown) {
    const e = err as { message?: string }
    error.value = e?.message ?? 'Failed to load destinations'
  } finally {
    loading.value = false
  }
}

async function toggleEnabled(row: Destination) {
  try {
    const updated = await destinationsApi.update(row.id, { enabled: !row.enabled })
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

function openEdit(row: Destination) {
  editing.value = row
  drawerOpen.value = true
}

function confirmDelete(row: Destination) {
  Modal.confirm({
    title: `Delete "${row.name}"?`,
    content: 'This will remove the destination and all associated subscriptions.',
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      await destinationsApi.delete(row.id)
      message.success('Deleted')
      await load()
    },
  })
}

onMounted(async () => {
  const [, settings] = await Promise.allSettled([load(), settingsApi.get()])
  if (settings.status === 'fulfilled') {
    provisioned.value = settings.value.agent?.provisioned ?? false
  }
})
</script>

<template>
  <AppLayout title="Destinations">
    <div class="toolbar">
      <a-radio-group v-model:value="activeType" button-style="solid" size="small">
        <a-radio-button value="all">All</a-radio-button>
        <a-radio-button v-for="t in availableTypes" :key="t" :value="t">
          {{ t.charAt(0).toUpperCase() + t.slice(1) }}
        </a-radio-button>
      </a-radio-group>
      <a-button type="primary" @click="openCreate">
        <template #icon><PlusOutlined /></template>
        New Destination
      </a-button>
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
      :data-source="filteredRows"
      :loading="loading"
      :pagination="false"
      row-key="id"
      size="middle"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'type'">
          <a-tag :color="destinationColor(record.type)">{{ record.type }}</a-tag>
        </template>

        <template v-else-if="column.key === 'enabled'">
          <a-switch
            :checked="record.enabled"
            size="small"
            @change="toggleEnabled(record)"
          />
        </template>

        <template v-else-if="column.key === 'last_error'">
          <a-tooltip v-if="record.last_error" :title="record.last_error">
            <a-tag color="error" style="max-width: 200px; overflow: hidden; text-overflow: ellipsis">
              {{ record.last_error }}
            </a-tag>
          </a-tooltip>
          <span v-else style="color: #999">—</span>
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

    <DestinationDrawer
      v-model:open="drawerOpen"
      :editing="editing"
      :provisioned="provisioned"
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
}
</style>
