<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, ReloadOutlined, RollbackOutlined, DeleteOutlined, ClockCircleOutlined } from '@ant-design/icons-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { client } from '@/api/client'

interface Backup {
  fileName: string
  sizeBytes: number
  createdAt: string
  checksumSha256?: string
}

interface BackupSchedule {
  enabled: boolean
  intervalHours: number
  keepCount: number
  lastRunAt: string | null
  nextRunAt: string | null
}

const backups = ref<Backup[]>([])
const loading = ref(false)
const creating = ref(false)
const restoringFile = ref<string | null>(null)
const deletingFile = ref<string | null>(null)

const schedule = ref<BackupSchedule>({ enabled: false, intervalHours: 24, keepCount: 7, lastRunAt: null, nextRunAt: null })
const scheduleLoading = ref(false)
const scheduleSaving = ref(false)

const intervalOptions = [
  { label: 'Every hour', value: 1 },
  { label: 'Every 6 hours', value: 6 },
  { label: 'Every 12 hours', value: 12 },
  { label: 'Daily (24 h)', value: 24 },
  { label: 'Every 2 days', value: 48 },
  { label: 'Weekly', value: 168 },
]

const columns = [
  { title: 'File', key: 'fileName', ellipsis: true },
  { title: 'Created', key: 'createdAt', width: 180 },
  { title: 'Size', key: 'size', width: 100 },
  { title: 'Checksum (SHA-256)', key: 'checksum', ellipsis: true },
  { title: 'Actions', key: 'actions', width: 160, align: 'right' as const },
]

async function load() {
  loading.value = true
  try {
    const { data } = await client.get<{ backups: Backup[] }>('/v1/backups')
    backups.value = data.backups ?? []
  } catch (e: any) {
    message.error(e?.message ?? 'Failed to load backups')
  } finally {
    loading.value = false
  }
}

async function loadSchedule() {
  scheduleLoading.value = true
  try {
    const { data } = await client.get<{ schedule: BackupSchedule }>('/v1/backups/schedule')
    schedule.value = data.schedule
  } catch (e: any) {
    message.error(e?.message ?? 'Failed to load schedule')
  } finally {
    scheduleLoading.value = false
  }
}

async function saveSchedule() {
  scheduleSaving.value = true
  try {
    const { data } = await client.put<{ schedule: BackupSchedule }>('/v1/backups/schedule', {
      enabled: schedule.value.enabled,
      intervalHours: schedule.value.intervalHours,
      keepCount: schedule.value.keepCount,
    })
    schedule.value = data.schedule
    message.success('Schedule saved')
  } catch (e: any) {
    message.error(e?.message ?? 'Failed to save schedule')
  } finally {
    scheduleSaving.value = false
  }
}

async function createBackup() {
  creating.value = true
  try {
    await client.post('/v1/backups')
    message.success('Backup created')
    await load()
  } catch (e: any) {
    message.error(e?.message ?? 'Failed to create backup')
  } finally {
    creating.value = false
  }
}

function confirmRestore(backup: Backup) {
  Modal.confirm({
    title: 'Restore from backup?',
    content: `This will replace the current database with "${backup.fileName}". A pre-restore backup will be created automatically. The agent will need to restart to pick up the restored data.`,
    okText: 'Restore',
    okType: 'danger',
    cancelText: 'Cancel',
    onOk: () => doRestore(backup.fileName),
  })
}

async function doRestore(fileName: string) {
  restoringFile.value = fileName
  try {
    await client.post(`/v1/backups/${encodeURIComponent(fileName)}/restore`)
    message.success('Database restored — restart the agent for changes to take effect')
    await load()
  } catch (e: any) {
    message.error(e?.message ?? 'Restore failed')
  } finally {
    restoringFile.value = null
  }
}

function confirmDelete(backup: Backup) {
  Modal.confirm({
    title: 'Delete backup?',
    content: `"${backup.fileName}" will be permanently deleted.`,
    okText: 'Delete',
    okType: 'danger',
    cancelText: 'Cancel',
    onOk: () => doDelete(backup.fileName),
  })
}

async function doDelete(fileName: string) {
  deletingFile.value = fileName
  try {
    await client.delete(`/v1/backups/${encodeURIComponent(fileName)}`)
    message.success('Backup deleted')
    backups.value = backups.value.filter(b => b.fileName !== fileName)
  } catch (e: any) {
    message.error(e?.message ?? 'Delete failed')
  } finally {
    deletingFile.value = null
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

onMounted(() => { load(); loadSchedule() })
</script>

<template>
  <AppLayout>
    <div class="backups-page">
      <div class="page-header">
        <div>
          <h2>Database Backups</h2>
          <p class="subtitle">Create and restore SQLite database snapshots</p>
        </div>
        <a-space>
          <a-button :loading="loading" @click="load">
            <template #icon><ReloadOutlined /></template>
            Refresh
          </a-button>
          <a-button type="primary" :loading="creating" @click="createBackup">
            <template #icon><PlusOutlined /></template>
            Create Backup
          </a-button>
        </a-space>
      </div>

      <a-alert
        type="info"
        show-icon
        message="Backups are stored on the device filesystem. Restore replaces the live database — a pre-restore snapshot is created automatically before any restore."
        style="margin-bottom: 20px"
      />

      <a-card size="small" style="margin-bottom: 20px">
        <template #title>
          <span><ClockCircleOutlined style="margin-right: 8px" />Automatic Schedule</span>
        </template>
        <template #extra>
          <a-switch v-model:checked="schedule.enabled" @change="saveSchedule" />
        </template>

        <a-spin :spinning="scheduleLoading">
          <div class="schedule-body">
            <div class="schedule-fields">
              <span class="field-label">Frequency</span>
              <a-select
                v-model:value="schedule.intervalHours"
                :options="intervalOptions"
                style="width: 180px"
                :disabled="!schedule.enabled"
              />
              <span class="field-label">Keep last</span>
              <a-input-number
                v-model:value="schedule.keepCount"
                :min="1"
                :max="100"
                :disabled="!schedule.enabled"
                addon-after="backups"
                style="width: 150px"
              />
              <a-button
                type="primary"
                :loading="scheduleSaving"
                :disabled="!schedule.enabled"
                @click="saveSchedule"
              >
                Save
              </a-button>
            </div>

            <div v-if="schedule.enabled && (schedule.lastRunAt || schedule.nextRunAt)" class="schedule-meta">
              <span v-if="schedule.lastRunAt" class="meta-item">
                Last run: <strong>{{ formatDate(schedule.lastRunAt) }}</strong>
              </span>
              <span v-if="schedule.nextRunAt" class="meta-item">
                Next run: <strong>{{ formatDate(schedule.nextRunAt) }}</strong>
              </span>
            </div>
          </div>
        </a-spin>
      </a-card>

      <a-table
        :dataSource="backups"
        :columns="columns"
        :loading="loading"
        row-key="fileName"
        :pagination="{ pageSize: 20, hideOnSinglePage: true }"
        size="small"
      >
        <template #bodyCell="{ column, record }">

          <template v-if="column.key === 'fileName'">
            <span class="mono">{{ record.fileName }}</span>
          </template>

          <template v-else-if="column.key === 'createdAt'">
            {{ formatDate(record.createdAt) }}
          </template>

          <template v-else-if="column.key === 'size'">
            {{ formatSize(record.sizeBytes) }}
          </template>

          <template v-else-if="column.key === 'checksum'">
            <a-tooltip v-if="record.checksumSha256" :title="record.checksumSha256">
              <span class="mono checksum">{{ record.checksumSha256.slice(0, 16) }}…</span>
            </a-tooltip>
            <span v-else class="muted">—</span>
          </template>

          <template v-else-if="column.key === 'actions'">
            <a-space>
              <a-tooltip title="Restore this backup">
                <a-button
                  size="small"
                  :loading="restoringFile === record.fileName"
                  @click="confirmRestore(record)"
                >
                  <template #icon><RollbackOutlined /></template>
                  Restore
                </a-button>
              </a-tooltip>
              <a-tooltip title="Delete">
                <a-button
                  size="small"
                  danger
                  :loading="deletingFile === record.fileName"
                  @click="confirmDelete(record)"
                >
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </a-tooltip>
            </a-space>
          </template>

        </template>

        <template #emptyText>
          <a-empty description="No backups yet">
            <template #description>
              <span>Click <strong>Create Backup</strong> to take a snapshot of the current database.</span>
            </template>
          </a-empty>
        </template>
      </a-table>
    </div>
  </AppLayout>
</template>

<style scoped>
.backups-page {
  padding: 24px;
  max-width: 1100px;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 20px;
}

.page-header h2 {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 600;
}

.subtitle {
  margin: 0;
  color: #888;
  font-size: 13px;
}

.mono {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
}

.checksum {
  color: #888;
}

.muted {
  color: #555;
}

.schedule-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.field-label {
  font-size: 13px;
  color: rgba(0, 0, 0, 0.65);
  white-space: nowrap;
}

.schedule-fields {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.schedule-meta {
  display: flex;
  gap: 24px;
  font-size: 12px;
  color: #888;
}

.meta-item strong {
  color: rgba(255, 255, 255, 0.65);
}
</style>
