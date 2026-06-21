<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, DeleteOutlined, KeyOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { usersApi, type User } from '@/api/users'

const rows = ref<User[]>([])
const loading = ref(false)

// create drawer
const createOpen = ref(false)
const createForm = ref({ username: '', password: '', is_superuser: false })
const creating = ref(false)

// reset-password modal
const resetTarget = ref<string | null>(null)
const resetPassword = ref('')
const resetting = ref(false)

const columns: TableColumnType<User>[] = [
  { title: 'Username', dataIndex: 'username', key: 'username' },
  { title: 'Role', key: 'role', width: 110 },
  { title: 'Active', key: 'is_active', width: 90 },
  { title: 'Created', dataIndex: 'created_at', key: 'created_at', width: 180,
    customRender: ({ value }) => new Date(value).toLocaleString() },
  { title: 'Actions', key: 'actions', width: 120, fixed: 'right' },
]

async function load() {
  loading.value = true
  try {
    rows.value = await usersApi.getAll()
  } finally {
    loading.value = false
  }
}

async function toggleActive(row: User) {
  try {
    await usersApi.update(row.username, { is_active: !row.is_active })
    await load()
  } catch {
    message.error('Failed to update')
  }
}

function openCreate() {
  createForm.value = { username: '', password: '', is_superuser: false }
  createOpen.value = true
}

async function submitCreate() {
  if (!createForm.value.username.trim() || !createForm.value.password) return
  creating.value = true
  try {
    await usersApi.create(createForm.value)
    message.success('User created')
    createOpen.value = false
    await load()
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } } }
    message.error(e?.response?.data?.error ?? 'Failed to create user')
  } finally {
    creating.value = false
  }
}

function openReset(username: string) {
  resetTarget.value = username
  resetPassword.value = ''
}

async function submitReset() {
  if (!resetTarget.value || !resetPassword.value) return
  resetting.value = true
  try {
    await usersApi.update(resetTarget.value, { password: resetPassword.value })
    message.success('Password updated')
    resetTarget.value = null
  } catch {
    message.error('Failed to update password')
  } finally {
    resetting.value = false
  }
}

function confirmDelete(row: User) {
  Modal.confirm({
    title: `Delete user "${row.username}"?`,
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      await usersApi.remove(row.username)
      message.success('User deleted')
      await load()
    },
  })
}

onMounted(load)
</script>

<template>
  <AppLayout title="Users">
    <div style="display: flex; justify-content: flex-end; margin-bottom: 16px">
      <a-button type="primary" @click="openCreate">
        <template #icon><PlusOutlined /></template>
        New User
      </a-button>
    </div>

    <a-table
      :columns="columns"
      :data-source="rows"
      :loading="loading"
      :pagination="false"
      row-key="username"
      size="middle"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'role'">
          <a-tag :color="record.is_superuser ? 'gold' : 'default'">
            {{ record.is_superuser ? 'Superuser' : 'User' }}
          </a-tag>
        </template>

        <template v-else-if="column.key === 'is_active'">
          <a-switch
            :checked="record.is_active"
            size="small"
            @change="toggleActive(record)"
          />
        </template>

        <template v-else-if="column.key === 'actions'">
          <a-space>
            <a-tooltip title="Reset password">
              <a-button size="small" @click="openReset(record.username)">
                <template #icon><KeyOutlined /></template>
              </a-button>
            </a-tooltip>
            <a-button size="small" danger @click="confirmDelete(record)">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </a-space>
        </template>
      </template>
    </a-table>

    <!-- Create user drawer -->
    <a-drawer
      :open="createOpen"
      title="New User"
      width="400"
      @close="createOpen = false"
    >
      <a-form layout="vertical" autocomplete="off">
        <a-form-item label="Username" required>
          <a-input v-model:value="createForm.username" placeholder="e.g. operator1" />
        </a-form-item>
        <a-form-item label="Password" required extra="Minimum 6 characters">
          <a-input-password v-model:value="createForm.password" />
        </a-form-item>
        <a-form-item label="Role">
          <a-checkbox v-model:checked="createForm.is_superuser">Superuser</a-checkbox>
        </a-form-item>
      </a-form>
      <template #footer>
        <a-space style="justify-content: flex-end; width: 100%">
          <a-button @click="createOpen = false">Cancel</a-button>
          <a-button type="primary" :loading="creating" @click="submitCreate">Create</a-button>
        </a-space>
      </template>
    </a-drawer>

    <!-- Reset password modal -->
    <a-modal
      :open="resetTarget !== null"
      :title="`Reset password — ${resetTarget}`"
      ok-text="Update"
      :confirm-loading="resetting"
      @ok="submitReset"
      @cancel="resetTarget = null"
    >
      <a-form layout="vertical" style="margin-top: 8px">
        <a-form-item label="New password" extra="Minimum 6 characters">
          <a-input-password v-model:value="resetPassword" />
        </a-form-item>
      </a-form>
    </a-modal>
  </AppLayout>
</template>
