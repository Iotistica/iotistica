<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { message, Modal } from 'ant-design-vue'
import {
  PlusOutlined,
  ReloadOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  DeleteOutlined,
  EditOutlined,
  AppstoreOutlined,
  FileTextOutlined,
  ShopOutlined,
  SearchOutlined,
  RocketOutlined,
} from '@ant-design/icons-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { containersApi, templatesApi } from '@/api/containers'
import type { ContainerApp, ContainerService, AppTemplate } from '@/api/containers'

// ── State ─────────────────────────────────────────────────────────────────────

const apps = ref<ContainerApp[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const actionInFlight = ref<Record<string, boolean>>({})

// ── Auto-refresh ──────────────────────────────────────────────────────────────

let refreshTimer: ReturnType<typeof setInterval> | null = null

function startRefresh() {
  refreshTimer = setInterval(load, 5000)
}
function stopRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
}

onMounted(() => { load(); startRefresh() })
onUnmounted(() => { stopRefresh(); if (logEs) { logEs.close(); logEs = null } })

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
  if (loading.value) return
  loading.value = true
  error.value = null
  try {
    apps.value = await containersApi.getAll()
  } catch (e: unknown) {
    error.value = (e as any)?.message ?? 'Failed to load containers'
  } finally {
    loading.value = false
  }
}

// ── Status helpers ─────────────────────────────────────────────────────────────

type RunState = 'running' | 'stopped' | 'error' | 'creating' | 'unknown'

function resolveState(svc: ContainerService): RunState {
  // status can be a ServiceStatus object OR a raw Docker string ("running", "exited", etc.)
  const rawStatus = typeof svc.status === 'string'
    ? svc.status
    : (svc.status as any)?.state
  const s = rawStatus ?? svc.serviceStatus ?? svc.state
  if (s === 'running') return 'running'
  if (s === 'stopped' || s === 'exited') return 'stopped'
  if (s === 'error') return 'error'
  if (s === 'creating' || s === 'pending') return 'creating'
  return 'unknown'
}

const CATEGORY_COLOR: Record<string, string> = {
  Automation:   'orange',
  Monitoring:   'blue',
  'Time Series':'purple',
  MQTT:         'cyan',
  Management:   'geekblue',
  'IoT Platform':'green',
  Database:     'red',
  AI:           'volcano',
}

const STATUS_COLOR: Record<RunState, string> = {
  running: 'success',
  stopped: 'default',
  error: 'error',
  creating: 'processing',
  unknown: 'warning',
}

const STATUS_LABEL: Record<RunState, string> = {
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error',
  creating: 'Creating',
  unknown: '—',
}

function summaryForApp(app: ContainerApp) {
  const total = app.services.length
  const running = app.services.filter(s => resolveState(s) === 'running').length
  return { total, running }
}

const totalRunning = computed(() =>
  apps.value.reduce((n, a) => n + a.services.filter(s => resolveState(s) === 'running').length, 0),
)
const totalServices = computed(() =>
  apps.value.reduce((n, a) => n + a.services.length, 0),
)

// ── Service actions ───────────────────────────────────────────────────────────

function actionKey(appId: number, serviceName: string, action: string) {
  return `${appId}:${serviceName}:${action}`
}

async function doAction(app: ContainerApp, svc: ContainerService, action: 'start' | 'stop' | 'restart') {
  const key = actionKey(app.appId, svc.serviceName, action)
  actionInFlight.value = { ...actionInFlight.value, [key]: true }
  try {
    await containersApi.serviceAction(app.appId, svc.serviceName, action)
    message.success(`${svc.serviceName} ${action}ed`)
    await load()
  } catch (e: unknown) {
    message.error((e as any)?.message ?? `${action} failed`)
  } finally {
    const next = { ...actionInFlight.value }
    delete next[key]
    actionInFlight.value = next
  }
}

function isInFlight(appId: number, serviceName: string, action: string) {
  return !!actionInFlight.value[actionKey(appId, serviceName, action)]
}

// ── Remove app ────────────────────────────────────────────────────────────────

function confirmRemoveApp(app: ContainerApp) {
  Modal.confirm({
    title: `Remove "${app.appName}"?`,
    content: 'All services in this application will be stopped and removed.',
    okType: 'danger',
    okText: 'Remove',
    async onOk() {
      try {
        await containersApi.remove(app.appId)
        message.success(`${app.appName} removed`)
        await load()
      } catch (e: unknown) {
        message.error((e as any)?.message ?? 'Remove failed')
      }
    },
  })
}

function confirmRemoveService(app: ContainerApp, svc: ContainerService) {
  Modal.confirm({
    title: `Remove "${svc.serviceName}"?`,
    content: 'The service container will be stopped and removed.',
    okType: 'danger',
    okText: 'Remove',
    async onOk() {
      try {
        await containersApi.removeService(app.appId, svc.serviceName)
        message.success(`${svc.serviceName} removed`)
        await load()
      } catch (e: unknown) {
        message.error((e as any)?.message ?? 'Remove failed')
      }
    },
  })
}

// ── Add Service drawer ────────────────────────────────────────────────────────

const addSvcDrawerOpen = ref(false)
const addSvcTargetApp = ref<ContainerApp | null>(null)
const addSvcForm = ref<ServiceForm>(emptyService())
const addSvcSaving = ref(false)

function openAddService(app: ContainerApp) {
  addSvcTargetApp.value = app
  addSvcForm.value = emptyService()
  addSvcDrawerOpen.value = true
}

async function submitAddService() {
  const app = addSvcTargetApp.value
  if (!app) return
  if (!addSvcForm.value.serviceName.trim()) { message.error('Service name is required'); return }
  if (!addSvcForm.value.image.trim()) { message.error('Docker image is required'); return }

  const ports = parseLines(addSvcForm.value.ports)
  const volumes = parseLines(addSvcForm.value.volumes)
  const environment = addSvcForm.value.env.trim() ? parseEnv(addSvcForm.value.env) : undefined

  addSvcSaving.value = true
  try {
    await containersApi.addService(app.appId, {
      serviceName: addSvcForm.value.serviceName.trim(),
      imageName: addSvcForm.value.image.trim(),
      state: 'running',
      config: {
        image: addSvcForm.value.image.trim(),
        ...(ports.length ? { ports } : {}),
        ...(environment && Object.keys(environment).length ? { environment } : {}),
        ...(volumes.length ? { volumes } : {}),
        restart: addSvcForm.value.restart || undefined,
      },
    })
    message.success(`Service added to ${app.appName}`)
    addSvcDrawerOpen.value = false
    await load()
  } catch (e: unknown) {
    message.error((e as any)?.message ?? 'Failed to add service')
  } finally {
    addSvcSaving.value = false
  }
}

// ── Edit Service drawer ───────────────────────────────────────────────────────

const editSvcDrawerOpen = ref(false)
const editSvcTargetApp = ref<ContainerApp | null>(null)
const editSvcTargetSvc = ref<ContainerService | null>(null)
const editSvcForm = ref<ServiceForm>(emptyService())
const editSvcSaving = ref(false)

function openEditService(app: ContainerApp, svc: ContainerService) {
  editSvcTargetApp.value = app
  editSvcTargetSvc.value = svc
  editSvcForm.value = {
    serviceName: svc.serviceName,
    image: svc.imageName,
    ports: formatLines(svc.config.ports),
    env: formatEnv(svc.config.environment),
    volumes: formatLines(svc.config.volumes),
    restart: svc.config.restart ?? '',
  }
  editSvcDrawerOpen.value = true
}

async function submitEditService() {
  const app = editSvcTargetApp.value
  const original = editSvcTargetSvc.value
  if (!app || !original) return
  if (!editSvcForm.value.image.trim()) { message.error('Docker image is required'); return }

  const ports = parseLines(editSvcForm.value.ports)
  const volumes = parseLines(editSvcForm.value.volumes)
  const environment = editSvcForm.value.env.trim() ? parseEnv(editSvcForm.value.env) : undefined

  editSvcSaving.value = true
  try {
    await containersApi.updateService(app.appId, original.serviceName, {
      serviceName: editSvcForm.value.serviceName.trim() || original.serviceName,
      imageName: editSvcForm.value.image.trim(),
      state: 'running',
      config: {
        image: editSvcForm.value.image.trim(),
        ...(ports.length ? { ports } : {}),
        ...(environment && Object.keys(environment).length ? { environment } : {}),
        ...(volumes.length ? { volumes } : {}),
        restart: editSvcForm.value.restart || undefined,
      },
    })
    message.success(`${original.serviceName} updated`)
    editSvcDrawerOpen.value = false
    await load()
  } catch (e: unknown) {
    message.error((e as any)?.message ?? 'Failed to update service')
  } finally {
    editSvcSaving.value = false
  }
}

// ── Log viewer ───────────────────────────────────────────────────────────────

interface LogLine { msg: string; stream: 'stdout' | 'stderr'; ts: string }

const logDrawerOpen = ref(false)
const logApp = ref<ContainerApp | null>(null)
const logSvc = ref<ContainerService | null>(null)
const logLines = ref<LogLine[]>([])
const logFollow = ref(true)
const logAutoScroll = ref(true)
const logOutputEl = ref<HTMLDivElement | null>(null)
let logEs: EventSource | null = null

const LOG_API_BASE = (import.meta.env.VITE_API_BASE_URL as string) || ''
const MAX_LOG_LINES = 1000

function parseLogLine(raw: string, stream: 'stdout' | 'stderr'): LogLine {
  const m = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z) (.*)$/)
  if (m) {
    const ts = m[1].slice(0, 23).replace('T', ' ')
    return { msg: m[2], stream, ts }
  }
  return { msg: raw, stream, ts: '' }
}

function connectLogs(appId: number, serviceName: string) {
  if (logEs) { logEs.close(); logEs = null }
  const url = `${LOG_API_BASE}/v1/apps/${appId}/services/${encodeURIComponent(serviceName)}/logs?tail=200&follow=${logFollow.value}&timestamps=true`
  const es = new EventSource(url)
  logEs = es
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data)
      if (data.error) {
        logLines.value.push({ msg: `[error] ${data.error}`, stream: 'stderr', ts: '' })
        return
      }
      if (!data.msg) return
      const line = parseLogLine(data.msg, data.stream ?? 'stdout')
      logLines.value.push(line)
      if (logLines.value.length > MAX_LOG_LINES) logLines.value.splice(0, logLines.value.length - MAX_LOG_LINES)
    } catch {}
  }
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) logEs = null
  }
}

function openLogs(app: ContainerApp, svc: ContainerService) {
  logApp.value = app
  logSvc.value = svc
  logLines.value = []
  logFollow.value = true
  logAutoScroll.value = true
  logDrawerOpen.value = true
  connectLogs(app.appId, svc.serviceName)
}

function onLogDrawerClose() {
  if (logEs) { logEs.close(); logEs = null }
}

function toggleFollow() {
  if (!logApp.value || !logSvc.value) return
  connectLogs(logApp.value.appId, logSvc.value.serviceName)
}

watch(logLines, () => {
  if (logAutoScroll.value) nextTick(() => {
    if (logOutputEl.value) logOutputEl.value.scrollTop = logOutputEl.value.scrollHeight
  })
}, { deep: false })

// ── Marketplace modal ─────────────────────────────────────────────────────────

const marketOpen = ref(false)
const marketTemplates = ref<AppTemplate[]>([])
const marketCategories = ref<string[]>(['All'])
const marketCategory = ref('All')
const marketSearch = ref('')
const marketLoading = ref(false)

const filteredTemplates = computed(() => {
  return marketTemplates.value.filter(t => {
    const matchCat = marketCategory.value === 'All' || t.category === marketCategory.value
    const q = marketSearch.value.toLowerCase()
    const matchQ = !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)
    return matchCat && matchQ
  })
})

async function openMarketplace() {
  marketOpen.value = true
  if (marketTemplates.value.length > 0) return
  marketLoading.value = true
  try {
    const data = await templatesApi.getAll()
    marketTemplates.value = data.templates
    marketCategories.value = data.categories
  } catch {
    // non-fatal
  } finally {
    marketLoading.value = false
  }
}

function deployTemplate(tpl: AppTemplate) {
  marketOpen.value = false
  appName.value = tpl.appName
  services.value = tpl.services.map(s => ({
    serviceName: s.serviceName,
    image: s.image,
    ports: (s.ports ?? []).join('\n'),
    volumes: (s.volumes ?? []).join('\n'),
    env: s.environment ? Object.entries(s.environment).map(([k, v]) => `${k}=${v}`).join('\n') : '',
    restart: s.restart ?? 'unless-stopped',
  }))
  drawerOpen.value = true
}

// ── Deploy drawer ─────────────────────────────────────────────────────────────

const drawerOpen = ref(false)
const deploying = ref(false)

interface ServiceForm {
  serviceName: string
  image: string
  ports: string
  env: string
  volumes: string
  restart: string
}

function emptyService(): ServiceForm {
  return { serviceName: '', image: '', ports: '', env: '', volumes: '', restart: 'unless-stopped' }
}

const appName = ref('')
const services = ref<ServiceForm[]>([emptyService()])

function openDeploy() {
  appName.value = ''
  services.value = [emptyService()]
  drawerOpen.value = true
}

function addService() {
  services.value.push(emptyService())
}

function removeService(i: number) {
  services.value.splice(i, 1)
}

function formatEnv(env?: Record<string, string>): string {
  if (!env) return ''
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')
}

function formatLines(arr?: string[]): string {
  return arr ? arr.join('\n') : ''
}

function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) { out[trimmed] = '' } else {
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
  }
  return out
}

function parseLines(raw: string): string[] {
  return raw.split('\n').map(l => l.trim()).filter(Boolean)
}

async function deploy() {
  if (!appName.value.trim()) { message.error('Application name is required'); return }
  for (let i = 0; i < services.value.length; i++) {
    const svc = services.value[i]
    if (!svc.serviceName.trim()) { message.error(`Service ${i + 1}: name is required`); return }
    if (!svc.image.trim()) { message.error(`Service ${i + 1} (${svc.serviceName}): Docker image is required`); return }
  }

  deploying.value = true
  try {
    await containersApi.deploy({
      appName: appName.value.trim(),
      services: services.value.map(svc => {
        const ports = parseLines(svc.ports)
        const volumes = parseLines(svc.volumes)
        const environment = svc.env.trim() ? parseEnv(svc.env) : undefined
        return {
          serviceName: svc.serviceName.trim(),
          imageName: svc.image.trim(),
          state: 'running' as const,
          config: {
            image: svc.image.trim(),
            ...(ports.length ? { ports } : {}),
            ...(environment && Object.keys(environment).length ? { environment } : {}),
            ...(volumes.length ? { volumes } : {}),
            restart: svc.restart || undefined,
          },
        }
      }),
    })
    message.success(`${appName.value} deploying…`)
    drawerOpen.value = false
    await load()
  } catch (e: unknown) {
    message.error((e as any)?.message ?? 'Deploy failed')
  } finally {
    deploying.value = false
  }
}
</script>

<template>
  <AppLayout title="Applications">

    <!-- Toolbar -->
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap">
      <div style="display: flex; gap: 16px; align-items: center; flex: 1">
        <span style="font-size: 13px; color: #888">
          <a-badge status="success" />
          {{ totalRunning }} running
        </span>
        <span style="font-size: 13px; color: #888">
          {{ totalServices }} total services
        </span>
        <span v-if="apps.length > 0" style="font-size: 13px; color: #888">
          {{ apps.length }} app{{ apps.length !== 1 ? 's' : '' }}
        </span>
      </div>
      <a-button :loading="loading" @click="load">
        <template #icon><ReloadOutlined /></template>
        Refresh
      </a-button>
      <a-button @click="openMarketplace">
        <template #icon><ShopOutlined /></template>
        Marketplace
      </a-button>
      <a-button type="primary" @click="openDeploy">
        <template #icon><PlusOutlined /></template>
        Add Application
      </a-button>
    </div>

    <!-- Error -->
    <a-alert v-if="error" type="error" :message="error" show-icon style="margin-bottom: 16px" />

    <!-- Empty -->
    <a-empty
      v-if="!loading && !error && apps.length === 0"
      style="margin: 60px 0"
      description="No applications deployed"
    >
      <a-button type="primary" @click="openDeploy">
        <template #icon><PlusOutlined /></template>
        Add your first application
      </a-button>
    </a-empty>

    <!-- App grid -->
    <a-spin :spinning="loading && apps.length === 0">
      <div class="app-grid">
        <div v-for="app in apps" :key="app.appId" class="app-card">

          <!-- Card header -->
          <div class="card-header">
            <div class="card-header-left">
              <AppstoreOutlined class="card-icon" />
              <span class="app-name">{{ app.appName }}</span>
            </div>
            <a-button size="small" danger @click="confirmRemoveApp(app)">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </div>

          <!-- Running summary -->
          <div class="card-summary">
            <a-badge :status="summaryForApp(app).running > 0 ? 'success' : 'default'" />
            <span>{{ summaryForApp(app).running }}/{{ summaryForApp(app).total }} running</span>
          </div>

          <!-- Services -->
          <div class="service-list">
            <div
              v-for="svc in app.services"
              :key="svc.serviceId ?? svc.serviceName"
              class="service-row"
            >
              <!-- Name + image -->
              <div class="svc-identity">
                <span class="service-name">{{ svc.serviceName }}</span>
                <span class="service-image">{{ svc.imageName }}</span>
                <template v-if="svc.config.ports?.length">
                  <span v-for="p in svc.config.ports" :key="p" class="port-tag">{{ p }}</span>
                </template>
                <a-tooltip v-if="svc.error" :title="svc.error.message" placement="topLeft">
                  <span class="svc-error-hint">
                    {{ svc.error.type }}
                    <template v-if="svc.error.retryCount > 0">({{ svc.error.retryCount }}×)</template>
                  </span>
                </a-tooltip>
              </div>

              <!-- Status + actions pinned to bottom-right of the row -->
              <div class="svc-controls">
                <a-tag :color="STATUS_COLOR[resolveState(svc)]" style="font-size: 11px; margin: 0">
                  {{ STATUS_LABEL[resolveState(svc)] }}
                </a-tag>
                <a-button
                  size="small"
                  title="Logs"
                  @click="openLogs(app, svc)"
                >
                  <template #icon><FileTextOutlined /></template>
                </a-button>
                <a-button
                  size="small"
                  title="Edit"
                  @click="openEditService(app, svc)"
                >
                  <template #icon><EditOutlined /></template>
                </a-button>
                <a-button
                  size="small"
                  title="Start"
                  :disabled="resolveState(svc) === 'running' || isInFlight(app.appId, svc.serviceName, 'start')"
                  :loading="isInFlight(app.appId, svc.serviceName, 'start')"
                  style="color: #52c41a; border-color: #b7eb8f"
                  @click="doAction(app, svc, 'start')"
                >
                  <template #icon><PlayCircleOutlined /></template>
                </a-button>
                <a-button
                  size="small"
                  title="Restart"
                  :loading="isInFlight(app.appId, svc.serviceName, 'restart')"
                  @click="doAction(app, svc, 'restart')"
                >
                  <template #icon><ReloadOutlined /></template>
                </a-button>
                <a-button
                  size="small"
                  danger
                  title="Stop"
                  :disabled="resolveState(svc) === 'stopped' || isInFlight(app.appId, svc.serviceName, 'stop')"
                  :loading="isInFlight(app.appId, svc.serviceName, 'stop')"
                  @click="doAction(app, svc, 'stop')"
                >
                  <template #icon><PoweroffOutlined /></template>
                </a-button>
                <a-button
                  size="small"
                  danger
                  title="Remove service"
                  @click="confirmRemoveService(app, svc)"
                >
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </div>
            </div>

            <div v-if="app.services.length === 0" class="no-services">
              No services configured
            </div>
          </div>

          <!-- Card footer -->
          <div class="card-footer">
            <a-button size="small" type="dashed" block @click="openAddService(app)">
              <template #icon><PlusOutlined /></template>
              Add Service
            </a-button>
          </div>

        </div>
      </div>
    </a-spin>

    <!-- Add Service drawer -->
    <a-drawer
      v-model:open="addSvcDrawerOpen"
      :title="`Add Service to ${addSvcTargetApp?.appName ?? ''}`"
      width="480"
      :body-style="{ paddingBottom: '80px' }"
    >
      <a-form layout="vertical">
        <a-form-item label="Service name" required>
          <a-input v-model:value="addSvcForm.serviceName" placeholder="e.g. redis, worker" />
        </a-form-item>
        <a-form-item label="Docker image" required>
          <a-input v-model:value="addSvcForm.image" placeholder="redis:7, myregistry/app:latest" style="font-family: monospace; font-size: 12px" />
        </a-form-item>
        <a-form-item label="Port mappings">
          <a-textarea v-model:value="addSvcForm.ports" placeholder="6379:6379&#10;8080:80" :rows="2" />
          <div style="font-size: 11px; color: #aaa; margin-top: 3px">One per line — host:container</div>
        </a-form-item>
        <a-form-item label="Environment variables">
          <a-textarea v-model:value="addSvcForm.env" placeholder="KEY=value" :rows="3" style="font-family: monospace; font-size: 12px" />
          <div style="font-size: 11px; color: #aaa; margin-top: 3px">One KEY=VALUE per line</div>
        </a-form-item>
        <a-form-item label="Volume mounts">
          <a-textarea v-model:value="addSvcForm.volumes" placeholder="/host/path:/container/path" :rows="2" />
          <div style="font-size: 11px; color: #aaa; margin-top: 3px">One per line</div>
        </a-form-item>
        <a-form-item label="Restart policy">
          <a-select v-model:value="addSvcForm.restart" style="width: 100%">
            <a-select-option value="unless-stopped">Unless stopped</a-select-option>
            <a-select-option value="always">Always</a-select-option>
            <a-select-option value="on-failure">On failure</a-select-option>
            <a-select-option value="no">No restart</a-select-option>
          </a-select>
        </a-form-item>
      </a-form>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <a-button @click="addSvcDrawerOpen = false">Cancel</a-button>
          <a-button type="primary" :loading="addSvcSaving" @click="submitAddService">
            <template #icon><PlusOutlined /></template>
            Add Service
          </a-button>
        </div>
      </template>
    </a-drawer>

    <!-- Edit Service drawer -->
    <a-drawer
      v-model:open="editSvcDrawerOpen"
      :title="`Edit — ${editSvcTargetSvc?.serviceName ?? ''}`"
      width="480"
      :body-style="{ paddingBottom: '80px' }"
    >
      <a-form layout="vertical">
        <a-form-item label="Service name" required>
          <a-input v-model:value="editSvcForm.serviceName" placeholder="e.g. redis, worker" />
        </a-form-item>
        <a-form-item label="Docker image" required>
          <a-input v-model:value="editSvcForm.image" placeholder="redis:7, myregistry/app:latest" style="font-family: monospace; font-size: 12px" />
        </a-form-item>
        <a-form-item label="Port mappings">
          <a-textarea v-model:value="editSvcForm.ports" placeholder="6379:6379&#10;8080:80" :rows="2" />
          <div style="font-size: 11px; color: #aaa; margin-top: 3px">One per line — host:container</div>
        </a-form-item>
        <a-form-item label="Environment variables">
          <a-textarea v-model:value="editSvcForm.env" placeholder="KEY=value" :rows="3" style="font-family: monospace; font-size: 12px" />
          <div style="font-size: 11px; color: #aaa; margin-top: 3px">One KEY=VALUE per line</div>
        </a-form-item>
        <a-form-item label="Volume mounts">
          <a-textarea v-model:value="editSvcForm.volumes" placeholder="/host/path:/container/path" :rows="2" />
          <div style="font-size: 11px; color: #aaa; margin-top: 3px">One per line</div>
        </a-form-item>
        <a-form-item label="Restart policy">
          <a-select v-model:value="editSvcForm.restart" style="width: 100%">
            <a-select-option value="unless-stopped">Unless stopped</a-select-option>
            <a-select-option value="always">Always</a-select-option>
            <a-select-option value="on-failure">On failure</a-select-option>
            <a-select-option value="no">No restart</a-select-option>
          </a-select>
        </a-form-item>
      </a-form>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <a-button @click="editSvcDrawerOpen = false">Cancel</a-button>
          <a-button type="primary" :loading="editSvcSaving" @click="submitEditService">
            <template #icon><EditOutlined /></template>
            Save Changes
          </a-button>
        </div>
      </template>
    </a-drawer>

    <!-- Deploy drawer -->
    <a-drawer
      v-model:open="drawerOpen"
      title="Add Application"
      width="560"
      :body-style="{ paddingBottom: '80px' }"
    >
      <a-form layout="vertical">

        <!-- App name -->
        <a-form-item label="Application name" required>
          <a-input v-model:value="appName" placeholder="e.g. monitoring-stack, edge-gateway" />
          <div style="font-size: 12px; color: #888; margin-top: 4px">
            Groups all services below under one application
          </div>
        </a-form-item>

        <a-divider orientation="left" style="font-size: 13px; margin: 20px 0 12px">
          Services
        </a-divider>

        <!-- Service cards -->
        <div v-for="(svc, i) in services" :key="i" class="service-form-card">
          <div class="service-form-header">
            <span style="font-weight: 600; font-size: 13px; color: rgba(0,0,0,0.75)">
              Service {{ i + 1 }}
            </span>
            <a-button
              v-if="services.length > 1"
              size="small"
              danger
              type="text"
              @click="removeService(i)"
            >
              <template #icon><DeleteOutlined /></template>
              Remove
            </a-button>
          </div>

          <a-form-item label="Service name" required style="margin-bottom: 10px">
            <a-input v-model:value="svc.serviceName" placeholder="e.g. nginx, postgres, redis" />
          </a-form-item>

          <a-form-item label="Docker image" required style="margin-bottom: 10px">
            <a-input v-model:value="svc.image" placeholder="nginx:latest, postgres:15, registry/image:tag" style="font-family: monospace; font-size: 12px" />
          </a-form-item>

          <a-form-item label="Port mappings" style="margin-bottom: 10px">
            <a-textarea
              v-model:value="svc.ports"
              placeholder="8080:80&#10;8443:443"
              :rows="2"
            />
            <div style="font-size: 11px; color: #aaa; margin-top: 3px">One per line — host:container</div>
          </a-form-item>

          <a-form-item label="Environment variables" style="margin-bottom: 10px">
            <a-textarea
              v-model:value="svc.env"
              placeholder="NODE_ENV=production&#10;API_KEY=secret"
              :rows="3"
              style="font-family: monospace; font-size: 12px"
            />
            <div style="font-size: 11px; color: #aaa; margin-top: 3px">One KEY=VALUE per line</div>
          </a-form-item>

          <a-form-item label="Volume mounts" style="margin-bottom: 10px">
            <a-textarea
              v-model:value="svc.volumes"
              placeholder="/host/path:/container/path&#10;my-volume:/app/data"
              :rows="2"
            />
            <div style="font-size: 11px; color: #aaa; margin-top: 3px">One per line</div>
          </a-form-item>

          <a-form-item label="Restart policy" style="margin-bottom: 0">
            <a-select v-model:value="svc.restart" style="width: 100%">
              <a-select-option value="unless-stopped">Unless stopped</a-select-option>
              <a-select-option value="always">Always</a-select-option>
              <a-select-option value="on-failure">On failure</a-select-option>
              <a-select-option value="no">No restart</a-select-option>
            </a-select>
          </a-form-item>
        </div>

        <!-- Add service -->
        <a-button
          block
          style="margin-top: 12px; border-style: dashed"
          @click="addService"
        >
          <template #icon><PlusOutlined /></template>
          Add Another Service
        </a-button>

      </a-form>

      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <a-button @click="drawerOpen = false">Cancel</a-button>
          <a-button type="primary" :loading="deploying" @click="deploy">
            <template #icon><PlayCircleOutlined /></template>
            Deploy
          </a-button>
        </div>
      </template>
    </a-drawer>

    <!-- Marketplace modal -->
    <a-modal
      v-model:open="marketOpen"
      title="App Marketplace"
      :footer="null"
      width="900px"
      :body-style="{ padding: '0', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }"
    >
      <template #title>
        <div style="display: flex; align-items: center; gap: 10px">
          <ShopOutlined style="color: #1677ff; font-size: 18px" />
          <span>App Marketplace</span>
          <span style="font-size: 12px; font-weight: 400; color: #888; margin-left: 4px">
            One-click deploy for popular IoT apps
          </span>
        </div>
      </template>

      <!-- Search bar -->
      <div style="padding: 16px 20px 0; flex-shrink: 0">
        <a-input
          v-model:value="marketSearch"
          placeholder="Search apps…"
          allow-clear
          size="large"
        >
          <template #prefix><SearchOutlined style="color: #bbb" /></template>
        </a-input>
      </div>

      <!-- Category tabs -->
      <div style="padding: 0 20px; flex-shrink: 0; border-bottom: 1px solid #f0f0f0; margin-top: 12px">
        <a-tabs v-model:activeKey="marketCategory" size="small" :tab-bar-style="{ marginBottom: 0 }">
          <a-tab-pane v-for="cat in marketCategories" :key="cat" :tab="cat" />
        </a-tabs>
      </div>

      <!-- Cards -->
      <div style="flex: 1; overflow-y: auto; padding: 20px">
        <a-spin :spinning="marketLoading">
          <div v-if="filteredTemplates.length === 0 && !marketLoading" style="text-align: center; padding: 48px 0; color: #bbb">
            No apps found
          </div>
          <div class="market-grid">
            <div
              v-for="tpl in filteredTemplates"
              :key="tpl.id"
              class="market-card"
              @click="deployTemplate(tpl)"
            >
              <div class="market-card-top">
                <div
                  class="market-avatar"
                  :style="{ background: tpl.color }"
                >{{ tpl.letter }}</div>
                <div class="market-meta">
                  <div class="market-name">{{ tpl.name }}</div>
                  <a-tag :color="CATEGORY_COLOR[tpl.category] ?? 'default'" style="font-size: 11px; line-height: 18px; padding: 0 6px; margin: 0">
                    {{ tpl.category }}
                  </a-tag>
                </div>
              </div>
              <div class="market-desc">{{ tpl.description }}</div>
              <div class="market-footer">
                <span class="market-image">{{ tpl.services[0]?.image }}</span>
                <a-button type="primary" size="small" class="market-deploy-btn">
                  <template #icon><RocketOutlined /></template>
                  Deploy
                </a-button>
              </div>
            </div>
          </div>
        </a-spin>
      </div>
    </a-modal>

    <!-- Log viewer drawer -->
    <a-drawer
      v-model:open="logDrawerOpen"
      :title="`Logs — ${logSvc?.serviceName ?? ''}`"
      width="720"
      :body-style="{ padding: 0, display: 'flex', flexDirection: 'column', height: '100%' }"
      @close="onLogDrawerClose"
    >
      <div class="log-toolbar">
        <div style="display: flex; align-items: center; gap: 8px">
          <a-switch v-model:checked="logFollow" size="small" @change="toggleFollow" />
          <span class="log-toolbar-label">Follow</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px">
          <a-switch v-model:checked="logAutoScroll" size="small" />
          <span class="log-toolbar-label">Auto-scroll</span>
        </div>
        <a-button size="small" @click="logLines = []">Clear</a-button>
        <span class="log-count">{{ logLines.length }} lines</span>
      </div>
      <div ref="logOutputEl" class="log-output">
        <div v-if="logLines.length === 0" class="log-empty">Waiting for logs…</div>
        <div
          v-for="(line, i) in logLines"
          :key="i"
          class="log-line"
          :class="line.stream"
        >
          <span v-if="line.ts" class="log-ts">{{ line.ts }}</span>
          <span class="log-msg">{{ line.msg }}</span>
        </div>
      </div>
    </a-drawer>

  </AppLayout>
</template>

<style scoped>
/* ── Card grid ───────────────────────────────────────────── */
.app-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
  align-items: start;
}

.app-card {
  border: 1px solid #e8e8e8;
  border-radius: 10px;
  overflow: hidden;
  background: #fff;
  display: flex;
  flex-direction: column;
}

/* ── Card header ─────────────────────────────────────────── */
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 8px;
  gap: 8px;
}

.card-header-left {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.card-icon {
  color: #1677ff;
  font-size: 15px;
  flex-shrink: 0;
}

.app-name {
  font-weight: 600;
  font-size: 14px;
  color: rgba(0, 0, 0, 0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Running summary ─────────────────────────────────────── */
.card-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 14px 10px;
  font-size: 12px;
  color: #888;
  border-bottom: 1px solid #f0f0f0;
}

/* ── Service rows ────────────────────────────────────────── */
.service-list {
  padding: 4px 0 6px;
}

.service-row {
  padding: 8px 14px;
  border-bottom: 1px solid #fafafa;
}

.service-row:last-child {
  border-bottom: none;
}

.svc-identity {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.service-name {
  font-weight: 500;
  font-size: 13px;
  color: rgba(0, 0, 0, 0.85);
}

.service-image {
  font-size: 11px;
  color: #999;
  font-family: monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.port-tag {
  font-size: 11px;
  font-family: monospace;
  background: #e6f4ff;
  color: #1677ff;
  border: 1px solid #bae0ff;
  border-radius: 3px;
  padding: 0 5px;
  white-space: nowrap;
}

.svc-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}

.svc-error-hint {
  font-size: 11px;
  color: #ff4d4f;
  background: #fff2f0;
  border: 1px solid #ffccc7;
  border-radius: 3px;
  padding: 0 5px;
  cursor: help;
  white-space: nowrap;
}

.no-services {
  padding: 14px;
  font-size: 12px;
  color: #bbb;
  text-align: center;
}

.card-footer {
  padding: 8px 14px 12px;
  border-top: 1px solid #f0f0f0;
}

/* ── Deploy form ─────────────────────────────────────────── */
.service-form-card {
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  padding: 14px 14px 10px;
  margin-bottom: 12px;
  background: #fafafa;
}

.service-form-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

/* ── Log viewer ──────────────────────────────────────────── */
.log-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  background: #161b22;
  border-bottom: 1px solid #30363d;
  flex-shrink: 0;
}

.log-toolbar-label {
  font-size: 12px;
  color: #8b949e;
}

.log-count {
  margin-left: auto;
  font-size: 11px;
  color: #484f58;
}

.log-output {
  flex: 1;
  overflow-y: auto;
  background: #0d1117;
  padding: 8px 12px;
  font-family: 'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
}

.log-empty {
  color: #484f58;
  padding: 16px 0;
  text-align: center;
  font-size: 12px;
}

.log-line {
  display: flex;
  gap: 10px;
  padding: 1px 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-line.stdout .log-msg { color: #c9d1d9; }
.log-line.stderr .log-msg { color: #ff7b72; }

.log-ts {
  color: #484f58;
  flex-shrink: 0;
  user-select: none;
  font-size: 11px;
  padding-top: 1px;
}

.log-msg {
  flex: 1;
}

/* ── Marketplace ─────────────────────────────────────────── */
.market-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 14px;
}

.market-card {
  border: 1px solid #e8e8e8;
  border-radius: 10px;
  padding: 16px;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 10px;
  cursor: pointer;
  transition: box-shadow 0.18s, border-color 0.18s, transform 0.12s;
}

.market-card:hover {
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
  border-color: #1677ff;
  transform: translateY(-1px);
}

.market-card-top {
  display: flex;
  align-items: center;
  gap: 12px;
}

.market-avatar {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.5px;
  flex-shrink: 0;
  font-family: 'SFMono-Regular', Consolas, monospace;
}

.market-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.market-name {
  font-weight: 600;
  font-size: 14px;
  color: rgba(0, 0, 0, 0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.market-desc {
  font-size: 12px;
  color: #666;
  line-height: 1.5;
  flex: 1;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.market-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
}

.market-image {
  font-size: 10px;
  color: #aaa;
  font-family: monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.market-deploy-btn {
  flex-shrink: 0;
}
</style>
