<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, DeleteOutlined, KeyOutlined, StopOutlined, ReloadOutlined, CheckCircleOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { usersApi, sessionsApi, type User, type Session } from '@/api/users'

// ── Users ─────────────────────────────────────────────────────────────────────

const rows = ref<User[]>([])
const loading = ref(false)
const selectedUsernames = ref<string[]>([])
const deletingUsers = ref(false)
const bulkActivating = ref(false)
const bulkDeactivating = ref(false)

const userRowSelection = computed(() => ({
  selectedRowKeys: selectedUsernames.value,
  onChange: (keys: (string | number)[]) => { selectedUsernames.value = keys as string[] },
}))

const createOpen = ref(false)
const createForm = ref({ username: '', password: '', is_superuser: false })
const creating = ref(false)

const resetTarget = ref<string | null>(null)
const resetPassword = ref('')
const resetting = ref(false)

const userColumns: TableColumnType<User>[] = [
  { title: 'Username', dataIndex: 'username', key: 'username' },
  { title: 'Role', key: 'role', width: 110 },
  { title: 'Active', key: 'is_active', width: 90 },
  { title: 'Created', dataIndex: 'created_at', key: 'created_at', width: 180,
    customRender: ({ value }) => new Date(value).toLocaleString() },
  { title: 'Actions', key: 'actions', width: 120, fixed: 'right' },
]

async function loadUsers() {
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
    await loadUsers()
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
    await loadUsers()
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
      await loadUsers()
    },
  })
}

function confirmDeleteSelectedUsers() {
  const count = selectedUsernames.value.length
  Modal.confirm({
    title: `Delete ${count} user${count !== 1 ? 's' : ''}?`,
    okType: 'danger',
    okText: `Delete ${count}`,
    async onOk() {
      deletingUsers.value = true
      try {
        await Promise.allSettled(selectedUsernames.value.map((u) => usersApi.remove(u)))
        selectedUsernames.value = []
        message.success(`Deleted ${count} user${count !== 1 ? 's' : ''}`)
        await loadUsers()
      } finally {
        deletingUsers.value = false
      }
    },
  })
}

async function bulkActivate() {
  const usernames = [...selectedUsernames.value]
  bulkActivating.value = true
  try {
    await Promise.allSettled(usernames.map((u) => usersApi.update(u, { is_active: true })))
    selectedUsernames.value = []
    message.success(`Activated ${usernames.length} user${usernames.length !== 1 ? 's' : ''}`)
    await loadUsers()
  } finally {
    bulkActivating.value = false
  }
}

async function bulkDeactivate() {
  const usernames = [...selectedUsernames.value]
  bulkDeactivating.value = true
  try {
    await Promise.allSettled(usernames.map((u) => usersApi.update(u, { is_active: false })))
    selectedUsernames.value = []
    message.success(`Deactivated ${usernames.length} user${usernames.length !== 1 ? 's' : ''}`)
    await loadUsers()
  } finally {
    bulkDeactivating.value = false
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────────

const sessions = ref<Session[]>([])
const sessionsLoading = ref(false)

const sessionColumns: TableColumnType<Session>[] = [
  { title: 'User', dataIndex: 'username', key: 'username' },
  { title: 'Logged in', dataIndex: 'created_at', key: 'created_at', width: 180,
    customRender: ({ value }) => new Date(value).toLocaleString() },
  { title: 'Expires', dataIndex: 'expires_at', key: 'expires_at', width: 180,
    customRender: ({ value }) => new Date(value).toLocaleString() },
  { title: 'Status', key: 'active', width: 100 },
  { title: 'Actions', key: 'actions', width: 90, fixed: 'right' },
]

async function loadSessions() {
  sessionsLoading.value = true
  try {
    sessions.value = await sessionsApi.getAll()
  } finally {
    sessionsLoading.value = false
  }
}

function confirmRevoke(row: Session) {
  Modal.confirm({
    title: `Revoke session for "${row.username}"?`,
    content: 'The user will be logged out immediately.',
    okType: 'danger',
    okText: 'Revoke',
    async onOk() {
      await sessionsApi.revoke(row.token_id)
      message.success('Session revoked')
      await loadSessions()
    },
  })
}

function onTabChange(key: string) {
  if (key === 'sessions') loadSessions()
}

onMounted(loadUsers)
</script>

<template>
  <AppLayout title="Users">
    <a-tabs default-active-key="users" @change="onTabChange">

      <!-- ── Users tab ──────────────────────────────────────────────────────── -->
      <a-tab-pane key="users" tab="Users">
        <div class="users-toolbar">
          <a-space>
            <template v-if="selectedUsernames.length > 0">
              <span style="font-size: 13px; color: #666">{{ selectedUsernames.length }} selected</span>
              <a-button :loading="bulkActivating" @click="bulkActivate">
                <template #icon><CheckCircleOutlined /></template>
                Activate
              </a-button>
              <a-button :loading="bulkDeactivating" @click="bulkDeactivate">
                <template #icon><StopOutlined /></template>
                Deactivate
              </a-button>
              <a-button danger :loading="deletingUsers" @click="confirmDeleteSelectedUsers">
                <template #icon><DeleteOutlined /></template>
                Delete
              </a-button>
            </template>
          </a-space>
          <a-button type="primary" @click="openCreate">
            <template #icon><PlusOutlined /></template>
            New User
          </a-button>
        </div>

        <a-table
          :columns="userColumns"
          :data-source="rows"
          :loading="loading"
          :pagination="false"
          :row-selection="userRowSelection"
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
      </a-tab-pane>

      <!-- ── Sessions tab ───────────────────────────────────────────────────── -->
      <a-tab-pane key="sessions" tab="Sessions">
        <div style="display: flex; justify-content: flex-end; margin-bottom: 16px">
          <a-button :loading="sessionsLoading" @click="loadSessions">
            <template #icon><ReloadOutlined /></template>
            Refresh
          </a-button>
        </div>

        <a-table
          :columns="sessionColumns"
          :data-source="sessions"
          :loading="sessionsLoading"
          :pagination="{ pageSize: 20 }"
          row-key="token_id"
          size="middle"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'active'">
              <a-tag :color="record.active ? 'green' : 'default'">
                {{ record.active ? 'Active' : 'Expired' }}
              </a-tag>
            </template>

            <template v-else-if="column.key === 'actions'">
              <a-tooltip :title="record.active ? 'Revoke session' : 'Already expired'">
                <a-button
                  size="small"
                  danger
                  :disabled="!record.active"
                  @click="confirmRevoke(record)"
                >
                  <template #icon><StopOutlined /></template>
                </a-button>
              </a-tooltip>
            </template>
          </template>
        </a-table>
      </a-tab-pane>

    </a-tabs>

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

<style scoped>
.users-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  gap: 8px;
}
</style>
