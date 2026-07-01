<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, DeleteOutlined, WifiOutlined, CrownOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { client as apiClient } from '@/api/client'

interface MqttUser {
  username: string
  topic: string
  access: 'read' | 'write' | 'readwrite'
  superuser: boolean
  endpointUuid: string | null
  endpointName: string | null
}

const rows = ref<MqttUser[]>([])
const loading = ref(false)
const selectedUsernames = ref<string[]>([])
const deleting = ref(false)

const rowSelection = computed(() => ({
  selectedRowKeys: selectedUsernames.value,
  onChange: (keys: (string | number)[]) => { selectedUsernames.value = keys as string[] },
  getCheckboxProps: (record: MqttUser) => ({ disabled: record.superuser }),
}))

const createOpen = ref(false)
const createForm = ref({ username: '', password: '', topic: '' })
const creating = ref(false)

const columns: TableColumnType<MqttUser>[] = [
  { title: 'Username', dataIndex: 'username', key: 'username' },
  { title: 'Topic Pattern', dataIndex: 'topic', key: 'topic' },
  { title: 'Access', dataIndex: 'access', key: 'access', width: 110 },
  { title: 'Role', key: 'role', width: 100 },
  { title: 'Actions', key: 'actions', width: 90, fixed: 'right' },
]

async function load() {
  loading.value = true
  try {
    const { data } = await apiClient.get('/v1/mqtt/users')
    rows.value = data.users
  } finally {
    loading.value = false
  }
}

function openCreate() {
  createForm.value = { username: '', password: '', topic: '' }
  createOpen.value = true
}

async function submitCreate() {
  if (!createForm.value.username.trim() || !createForm.value.password.trim()) return
  creating.value = true
  try {
    await apiClient.post('/v1/mqtt/users', {
      username: createForm.value.username.trim(),
      password: createForm.value.password.trim(),
      ...(createForm.value.topic.trim() ? { topic: createForm.value.topic.trim() } : {}),
    })
    message.success('MQTT user created')
    createOpen.value = false
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error ?? 'Failed to create user')
  } finally {
    creating.value = false
  }
}

function confirmDelete(row: MqttUser) {
  Modal.confirm({
    title: `Delete "${row.username}"?`,
    content: 'This will remove the user from the MQTT broker. Connected clients using these credentials will be disconnected.',
    okText: 'Delete',
    okType: 'danger',
    onOk: () => deleteUser(row),
  })
}

async function deleteUser(row: MqttUser) {
  try {
    await apiClient.delete(`/v1/mqtt/users/${encodeURIComponent(row.username)}`)
    message.success(`User "${row.username}" removed`)
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error ?? 'Failed to delete user')
  }
}

function confirmDeleteSelected() {
  const count = selectedUsernames.value.length
  Modal.confirm({
    title: `Delete ${count} MQTT user${count !== 1 ? 's' : ''}?`,
    content: 'Connected clients using these credentials will be disconnected.',
    okType: 'danger',
    okText: `Delete ${count}`,
    async onOk() {
      deleting.value = true
      try {
        await Promise.allSettled(
          selectedUsernames.value.map((u) => apiClient.delete(`/v1/mqtt/users/${encodeURIComponent(u)}`))
        )
        selectedUsernames.value = []
        message.success(`Deleted ${count} MQTT user${count !== 1 ? 's' : ''}`)
        await load()
      } finally {
        deleting.value = false
      }
    },
  })
}

onMounted(load)
</script>

<template>
  <AppLayout>
    <div class="page-header">
      <div>
        <h2 class="page-title">MQTT Users</h2>
        <p class="page-subtitle">Manage credentials for clients connecting to the local MQTT broker</p>
      </div>
      <a-space>
        <template v-if="selectedUsernames.length > 0">
          <span style="font-size: 13px; color: rgba(255,255,255,0.65)">{{ selectedUsernames.length }} selected</span>
          <a-button danger :loading="deleting" @click="confirmDeleteSelected">
            <template #icon><DeleteOutlined /></template>
            Delete
          </a-button>
        </template>
        <a-button type="primary" @click="openCreate">
          <template #icon><PlusOutlined /></template>
          Add User
        </a-button>
      </a-space>
    </div>

    <a-table
      :dataSource="rows"
      :columns="columns"
      :loading="loading"
      :pagination="false"
      :row-selection="rowSelection"
      rowKey="username"
      size="middle"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'topic'">
          <code style="font-size: 12px; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px;">{{ record.topic }}</code>
        </template>

        <template v-else-if="column.key === 'access'">
          <a-tag :color="record.access === 'readwrite' ? 'blue' : record.access === 'write' ? 'green' : 'default'">
            {{ record.access }}
          </a-tag>
        </template>

        <template v-else-if="column.key === 'role'">
          <span v-if="record.superuser" style="color: #faad14; display: flex; align-items: center; gap: 4px;">
            <CrownOutlined /> Admin
          </span>
          <span v-else style="color: rgba(255,255,255,0.45);">Client</span>
        </template>

        <template v-else-if="column.key === 'actions'">
          <a-tooltip v-if="record.superuser" title="Bootstrap admin cannot be deleted">
            <a-button size="small" danger disabled>
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </a-tooltip>
          <a-button v-else size="small" danger @click="confirmDelete(record)">
            <template #icon><DeleteOutlined /></template>
          </a-button>
        </template>
      </template>
    </a-table>

    <!-- Add User Drawer -->
    <a-drawer
      v-model:open="createOpen"
      title="Add MQTT User"
      placement="right"
      :width="400"
    >
      <a-form layout="vertical">
        <a-form-item label="Username" required>
          <a-input
            v-model:value="createForm.username"
            placeholder="e.g. my-device"
            autocomplete="off"
          />
        </a-form-item>

        <a-form-item label="Password" required>
          <a-input-password
            v-model:value="createForm.password"
            placeholder="Strong password"
            autocomplete="new-password"
          />
        </a-form-item>

        <a-form-item label="Topic Pattern" extra="Leave blank to allow publish to all topics under i/#">
          <a-input
            v-model:value="createForm.topic"
            placeholder="i/tenant/a/agent/d/device (optional)"
          />
        </a-form-item>
      </a-form>

      <div class="drawer-footer">
        <a-button @click="createOpen = false" style="margin-right: 8px">Cancel</a-button>
        <a-button
          type="primary"
          :loading="creating"
          :disabled="!createForm.username.trim() || !createForm.password.trim()"
          @click="submitCreate"
        >
          <template #icon><WifiOutlined /></template>
          Create User
        </a-button>
      </div>
    </a-drawer>
  </AppLayout>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 24px;
}

.page-title {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.88);
}

.page-subtitle {
  margin: 0;
  color: rgba(255, 255, 255, 0.45);
  font-size: 13px;
}

.drawer-footer {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 16px 24px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  justify-content: flex-end;
}
</style>
