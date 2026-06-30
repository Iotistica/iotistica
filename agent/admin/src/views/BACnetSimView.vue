<template>
  <AppLayout>
    <template #header>
      <div class="page-header">
        <div class="page-header-left">
          <h2>BACnet Simulator</h2>
          <a-tag :color="connected ? 'green' : 'red'" class="status-tag">
            {{ connected ? 'Online' : 'Offline' }}
          </a-tag>
        </div>
        <div class="page-header-right">
          <a-button v-if="!connected" @click="connectToSim" :loading="connecting">
            Reconnect
          </a-button>
          <a-button v-if="connected" @click="reload" :loading="reloading" type="default">
            Reload Stack
          </a-button>
          <a-button type="primary" @click="openAddDevice" :disabled="!connected">
            <template #icon><PlusOutlined /></template>
            Add Device
          </a-button>
        </div>
      </div>
    </template>

    <!-- Offline banner -->
    <div v-if="!connected && !connecting" class="offline-banner">
      <ApiOutlined class="offline-icon" />
      <div>
        <div class="offline-title">BACnet Simulator not reachable</div>
        <div class="offline-sub">
          Make sure <code>sim-bacnet</code> container is running.
          Expected at <code>{{ simBaseUrl }}</code>
        </div>
      </div>
    </div>

    <div v-if="connected" class="sim-layout">
      <!-- Device tree (left panel) -->
      <div class="device-panel">
        <div class="device-panel-header">Devices</div>
        <div class="device-list">
          <div
            v-for="dev in devices"
            :key="dev.id"
            class="device-item"
            :class="{ active: selectedDeviceId === dev.id, disabled: !dev.enabled }"
            @click="selectDevice(dev)"
          >
            <div class="device-item-main">
              <span class="device-instance">{{ dev.device_instance }}</span>
              <span class="device-name">{{ dev.name }}</span>
            </div>
            <div class="device-item-actions">
              <a-tooltip title="Edit device">
                <a-button size="small" type="text" @click.stop="openEditDevice(dev)">
                  <template #icon><EditOutlined /></template>
                </a-button>
              </a-tooltip>
              <a-tooltip title="Delete device">
                <a-popconfirm
                  title="Delete this device and all its objects?"
                  ok-text="Delete"
                  ok-type="danger"
                  @confirm="deleteDevice(dev.id)"
                  @click.stop
                >
                  <a-button size="small" type="text" danger @click.stop>
                    <template #icon><DeleteOutlined /></template>
                  </a-button>
                </a-popconfirm>
              </a-tooltip>
            </div>
          </div>
          <div v-if="devices.length === 0" class="device-empty">
            No devices yet
          </div>
        </div>
      </div>

      <!-- Object table (main panel) -->
      <div class="object-panel">
        <template v-if="selectedDevice">
          <div class="object-panel-header">
            <div>
              <span class="object-panel-title">{{ selectedDevice.name }}</span>
              <span class="object-panel-sub">Device {{ selectedDevice.device_instance }}</span>
            </div>
            <a-button type="primary" size="small" @click="openAddObject">
              <template #icon><PlusOutlined /></template>
              Add Object
            </a-button>
          </div>

          <a-table
            :data-source="objectsWithLive"
            :columns="columns"
            :loading="objectsLoading"
            size="small"
            :pagination="false"
            row-key="id"
            class="object-table"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'object_type'">
                <a-tag :color="typeColor(record.object_type)" class="type-tag">
                  {{ shortType(record.object_type) }}
                </a-tag>
              </template>
              <template v-if="column.key === 'value'">
                <span class="live-value" :class="{ stale: !connected }">
                  {{ formatValue(record) }}
                </span>
              </template>
              <template v-if="column.key === 'behavior'">
                <a-tag :color="behaviorColor(record.behavior)" class="behavior-tag">
                  {{ record.behavior }}
                </a-tag>
              </template>
              <template v-if="column.key === 'actions'">
                <a-space size="small">
                  <a-tooltip v-if="record.behavior === 'manual'" title="Set value">
                    <a-button size="small" type="link" @click="openSetValue(record)">
                      Set
                    </a-button>
                  </a-tooltip>
                  <a-button size="small" type="text" @click="openEditObject(record)">
                    <template #icon><EditOutlined /></template>
                  </a-button>
                  <a-popconfirm
                    title="Delete this object?"
                    ok-text="Delete"
                    ok-type="danger"
                    @confirm="deleteObject(record.id)"
                  >
                    <a-button size="small" type="text" danger>
                      <template #icon><DeleteOutlined /></template>
                    </a-button>
                  </a-popconfirm>
                </a-space>
              </template>
            </template>
          </a-table>
        </template>

        <div v-else class="object-placeholder">
          <ApartmentOutlined class="placeholder-icon" />
          <div>Select a device to view its objects</div>
        </div>
      </div>
    </div>

    <!-- Add/Edit Device drawer -->
    <a-drawer
      :title="editingDevice ? 'Edit Device' : 'Add Device'"
      :open="deviceDrawerOpen"
      width="400"
      @close="closeDeviceDrawer"
      destroy-on-close
    >
      <a-form :model="deviceForm" layout="vertical" ref="deviceFormRef">
        <a-form-item label="Device Instance" name="device_instance" :rules="[{ required: true }]">
          <a-input-number
            v-model:value="deviceForm.device_instance"
            :min="1" :max="4194302"
            style="width: 100%"
            placeholder="e.g. 1001"
          />
        </a-form-item>
        <a-form-item label="Name" name="name" :rules="[{ required: true }]">
          <a-input v-model:value="deviceForm.name" placeholder="e.g. Central-Plant" />
        </a-form-item>
        <a-form-item label="Description" name="description">
          <a-input v-model:value="deviceForm.description" placeholder="Optional description" />
        </a-form-item>
        <a-form-item label="Vendor Name" name="vendor_name">
          <a-input v-model:value="deviceForm.vendor_name" />
        </a-form-item>
        <a-form-item label="Model Name" name="model_name">
          <a-input v-model:value="deviceForm.model_name" />
        </a-form-item>
        <a-form-item label="Enabled">
          <a-switch v-model:checked="deviceEnabledBool" />
        </a-form-item>
      </a-form>
      <template #footer>
        <a-space>
          <a-button @click="closeDeviceDrawer">Cancel</a-button>
          <a-button type="primary" :loading="saving" @click="saveDevice">
            {{ editingDevice ? 'Save' : 'Create' }}
          </a-button>
        </a-space>
      </template>
    </a-drawer>

    <!-- Add/Edit Object drawer -->
    <a-drawer
      :title="editingObject ? 'Edit Object' : 'Add Object'"
      :open="objectDrawerOpen"
      width="440"
      @close="closeObjectDrawer"
      destroy-on-close
    >
      <a-form :model="objectForm" layout="vertical" ref="objectFormRef">
        <a-form-item label="Object Type" name="object_type" :rules="[{ required: true }]">
          <a-select v-model:value="objectForm.object_type" style="width: 100%">
            <a-select-option v-for="t in meta?.object_types ?? []" :key="t" :value="t">
              {{ t }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="Instance" name="object_instance" :rules="[{ required: true }]">
          <a-input-number
            v-model:value="objectForm.object_instance"
            :min="0" :max="4194302"
            style="width: 100%"
          />
        </a-form-item>
        <a-form-item label="Name" name="name" :rules="[{ required: true }]">
          <a-input v-model:value="objectForm.name" placeholder="e.g. Supply Temp" />
        </a-form-item>
        <a-form-item
          v-if="isAnalog(objectForm.object_type)"
          label="Units"
          name="units"
        >
          <a-select v-model:value="objectForm.units" style="width: 100%" show-search>
            <a-select-option v-for="u in meta?.units ?? []" :key="u" :value="u">
              {{ u }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="Behavior" name="behavior">
          <a-select v-model:value="objectForm.behavior" style="width: 100%" @change="onBehaviorChange">
            <a-select-option value="constant">constant — fixed value</a-select-option>
            <a-select-option value="sine">sine — sinusoidal wave</a-select-option>
            <a-select-option value="noise">noise — value ± random noise</a-select-option>
            <a-select-option value="random_walk">random_walk — drifts within range</a-select-option>
            <a-select-option value="manual">manual — you control the value</a-select-option>
          </a-select>
        </a-form-item>

        <!-- Behavior params -->
        <div class="behavior-params">
          <template v-if="objectForm.behavior === 'constant'">
            <a-form-item label="Value">
              <a-input-number v-model:value="bparams.value" style="width: 100%" />
            </a-form-item>
          </template>
          <template v-if="objectForm.behavior === 'sine'">
            <a-form-item label="Base value">
              <a-input-number v-model:value="bparams.base" style="width: 100%" />
            </a-form-item>
            <a-form-item label="Amplitude (± from base)">
              <a-input-number v-model:value="bparams.amplitude" :min="0" style="width: 100%" />
            </a-form-item>
            <a-form-item label="Period (hours)">
              <a-input-number v-model:value="bparams.period_hours" :min="0.1" style="width: 100%" />
            </a-form-item>
          </template>
          <template v-if="objectForm.behavior === 'noise'">
            <a-form-item label="Base value">
              <a-input-number v-model:value="bparams.base" style="width: 100%" />
            </a-form-item>
            <a-form-item label="Noise range (±)">
              <a-input-number v-model:value="bparams.noise" :min="0" style="width: 100%" />
            </a-form-item>
          </template>
          <template v-if="objectForm.behavior === 'random_walk'">
            <a-form-item label="Initial value">
              <a-input-number v-model:value="bparams.value" style="width: 100%" />
            </a-form-item>
            <a-form-item label="Max step per tick">
              <a-input-number v-model:value="bparams.step" :min="0" style="width: 100%" />
            </a-form-item>
            <a-form-item label="Minimum">
              <a-input-number v-model:value="bparams.min" style="width: 100%" />
            </a-form-item>
            <a-form-item label="Maximum">
              <a-input-number v-model:value="bparams.max" style="width: 100%" />
            </a-form-item>
          </template>
          <template v-if="objectForm.behavior === 'manual'">
            <a-form-item label="Initial value">
              <a-input-number v-model:value="bparams.value" style="width: 100%" />
            </a-form-item>
          </template>
        </div>

        <a-form-item label="Enabled">
          <a-switch v-model:checked="objectEnabledBool" />
        </a-form-item>
      </a-form>
      <template #footer>
        <a-space>
          <a-button @click="closeObjectDrawer">Cancel</a-button>
          <a-button type="primary" :loading="saving" @click="saveObject">
            {{ editingObject ? 'Save' : 'Create' }}
          </a-button>
        </a-space>
      </template>
    </a-drawer>

    <!-- Set Value modal (manual behavior) -->
    <a-modal
      v-model:open="setValueOpen"
      title="Set Value"
      @ok="confirmSetValue"
      :confirm-loading="saving"
      ok-text="Set"
    >
      <div v-if="setValueTarget" style="margin-bottom: 12px;">
        <strong>{{ setValueTarget.name }}</strong>
        <span style="color: #888; margin-left: 8px;">{{ setValueTarget.object_type }},{{ setValueTarget.object_instance }}</span>
      </div>
      <a-input-number
        v-if="setValueTarget && isAnalog(setValueTarget.object_type)"
        v-model:value="setValueInput"
        style="width: 100%"
        placeholder="Enter value"
      />
      <a-select
        v-else
        v-model:value="setValueBool"
        style="width: 100%"
      >
        <a-select-option :value="true">Active (ON)</a-select-option>
        <a-select-option :value="false">Inactive (OFF)</a-select-option>
      </a-select>
    </a-modal>
  </AppLayout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  ApiOutlined, ApartmentOutlined,
} from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'

// ── Sim URL ───────────────────────────────────────────────────────────────────

const simBaseUrl = `http://${window.location.hostname}:47900`

async function simFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${simBaseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `HTTP ${res.status}`)
  }
  if (res.status === 204) return null
  return res.json()
}

// ── State ─────────────────────────────────────────────────────────────────────

const connected = ref(false)
const connecting = ref(false)
const reloading = ref(false)
const devices = ref<any[]>([])
const selectedDeviceId = ref<number | null>(null)
const objects = ref<any[]>([])
const objectsLoading = ref(false)
const meta = ref<any>(null)
const liveState = ref<any>({})
const saving = ref(false)

// WebSocket
let ws: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null

// ── Connection ────────────────────────────────────────────────────────────────

async function connectToSim() {
  connecting.value = true
  try {
    await simFetch('/health')
    connected.value = true
    meta.value = await simFetch('/meta')
    await loadDevices()
    openWebSocket()
  } catch {
    connected.value = false
  } finally {
    connecting.value = false
  }
}

function openWebSocket() {
  if (ws) ws.close()
  const wsUrl = `ws://${window.location.hostname}:47900/ws`
  ws = new WebSocket(wsUrl)
  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)
      liveState.value = data
    } catch {}
  }
  ws.onclose = () => {
    if (connected.value) {
      wsReconnectTimer = setTimeout(openWebSocket, 3000)
    }
  }
  ws.onerror = () => {
    connected.value = false
  }
}

onMounted(() => { connectToSim() })
onUnmounted(() => {
  if (ws) ws.close()
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer)
})

// ── Devices ───────────────────────────────────────────────────────────────────

async function loadDevices() {
  devices.value = await simFetch('/devices')
  if (selectedDeviceId.value && !devices.value.find(d => d.id === selectedDeviceId.value)) {
    selectedDeviceId.value = null
    objects.value = []
  }
}

const selectedDevice = computed(() => devices.value.find(d => d.id === selectedDeviceId.value) ?? null)

async function selectDevice(dev: any) {
  selectedDeviceId.value = dev.id
  objectsLoading.value = true
  try {
    objects.value = await simFetch(`/devices/${dev.id}/objects`)
  } finally {
    objectsLoading.value = false
  }
}

async function deleteDevice(id: number) {
  await simFetch(`/devices/${id}`, { method: 'DELETE' })
  message.success('Device deleted')
  if (selectedDeviceId.value === id) {
    selectedDeviceId.value = null
    objects.value = []
  }
  await loadDevices()
}

async function reload() {
  reloading.value = true
  try {
    await simFetch('/reload', { method: 'POST' })
    message.success('BACnet stack reloading…')
  } finally {
    setTimeout(() => { reloading.value = false }, 2000)
  }
}

// ── Device drawer ─────────────────────────────────────────────────────────────

const deviceDrawerOpen = ref(false)
const editingDevice = ref<any>(null)
const deviceFormRef = ref<any>(null)
const deviceForm = ref({
  device_instance: 2001,
  name: '',
  description: '',
  vendor_name: 'Iotistica',
  model_name: 'BACnet Simulator',
  enabled: 1,
})
const deviceEnabledBool = computed({
  get: () => deviceForm.value.enabled === 1,
  set: (v) => { deviceForm.value.enabled = v ? 1 : 0 },
})

function openAddDevice() {
  editingDevice.value = null
  deviceForm.value = {
    device_instance: (Math.max(0, ...devices.value.map(d => d.device_instance)) || 1000) + 1,
    name: '',
    description: '',
    vendor_name: 'Iotistica',
    model_name: 'BACnet Simulator',
    enabled: 1,
  }
  deviceDrawerOpen.value = true
}

function openEditDevice(dev: any) {
  editingDevice.value = dev
  deviceForm.value = { ...dev }
  deviceDrawerOpen.value = true
}

function closeDeviceDrawer() {
  deviceDrawerOpen.value = false
  editingDevice.value = null
}

async function saveDevice() {
  saving.value = true
  try {
    if (editingDevice.value) {
      await simFetch(`/devices/${editingDevice.value.id}`, {
        method: 'PUT',
        body: JSON.stringify(deviceForm.value),
      })
      message.success('Device updated')
    } else {
      await simFetch('/devices', {
        method: 'POST',
        body: JSON.stringify(deviceForm.value),
      })
      message.success('Device created')
    }
    closeDeviceDrawer()
    await loadDevices()
  } catch (e: any) {
    message.error(e.message)
  } finally {
    saving.value = false
  }
}

// ── Object table ──────────────────────────────────────────────────────────────

const columns = [
  { title: 'Type', key: 'object_type', width: 90 },
  { title: 'Instance', dataIndex: 'object_instance', width: 80 },
  { title: 'Name', dataIndex: 'name' },
  { title: 'Value', key: 'value', width: 120 },
  { title: 'Units', dataIndex: 'units', width: 130 },
  { title: 'Behavior', key: 'behavior', width: 110 },
  { title: '', key: 'actions', width: 120 },
]

// Merge live values from WebSocket into object rows
const objectsWithLive = computed(() => {
  if (!selectedDevice.value) return []
  const devLive = (liveState.value?.devices ?? []).find(
    (d: any) => d.device_instance === selectedDevice.value!.device_instance
  )
  const liveMap: Record<number, any> = {}
  for (const o of devLive?.objects ?? []) {
    liveMap[o.id] = o
  }
  return objects.value.map(o => ({
    ...o,
    _live: liveMap[o.id] ?? null,
  }))
})

function formatValue(record: any): string {
  const v = record._live?.value
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'Active' : 'Inactive'
  if (record.object_type.startsWith('binary')) return v ? 'Active' : 'Inactive'
  return (typeof v === 'number' ? v.toFixed(2) : String(v))
}

function typeColor(t: string): string {
  if (t.startsWith('analog')) return 'blue'
  if (t.startsWith('binary')) return 'green'
  return 'default'
}

function shortType(t: string): string {
  const map: Record<string, string> = {
    'analog-input': 'AI', 'analog-output': 'AO', 'analog-value': 'AV',
    'binary-input': 'BI', 'binary-output': 'BO', 'binary-value': 'BV',
    'multi-state-input': 'MSI', 'multi-state-output': 'MSO', 'multi-state-value': 'MSV',
  }
  return map[t] ?? t
}

function behaviorColor(b: string): string {
  const map: Record<string, string> = {
    constant: 'default', sine: 'blue', noise: 'cyan',
    random_walk: 'purple', manual: 'orange',
  }
  return map[b] ?? 'default'
}

function isAnalog(t: string): boolean {
  return !!t && t.startsWith('analog')
}

// ── Object drawer ─────────────────────────────────────────────────────────────

const objectDrawerOpen = ref(false)
const editingObject = ref<any>(null)
const objectFormRef = ref<any>(null)
const objectForm = ref({
  object_type: 'analog-input',
  object_instance: 1,
  name: '',
  units: 'no-units',
  behavior: 'constant',
  behavior_params: '{"value":0}',
  enabled: 1,
})
const objectEnabledBool = computed({
  get: () => objectForm.value.enabled === 1,
  set: (v) => { objectForm.value.enabled = v ? 1 : 0 },
})

// Parsed behavior params as reactive object
const bparams = ref<Record<string, any>>({ value: 0 })

watch(() => objectForm.value.behavior, (b) => {
  // Set sensible defaults when switching behavior
  const defaults: Record<string, any> = {
    constant: { value: 0 },
    sine: { base: 20, amplitude: 5, period_hours: 24, phase_hours: 0 },
    noise: { base: 20, noise: 2 },
    random_walk: { value: 50, step: 1, min: 0, max: 100 },
    manual: { value: 0 },
  }
  bparams.value = defaults[b] ?? { value: 0 }
})

function onBehaviorChange() {}

function openAddObject() {
  editingObject.value = null
  const maxInst = objects.value.length > 0 ? Math.max(...objects.value.map(o => o.object_instance)) : 0
  objectForm.value = {
    object_type: 'analog-input',
    object_instance: maxInst + 1,
    name: '',
    units: 'no-units',
    behavior: 'constant',
    behavior_params: '{"value":0}',
    enabled: 1,
  }
  bparams.value = { value: 0 }
  objectDrawerOpen.value = true
}

function openEditObject(obj: any) {
  editingObject.value = obj
  objectForm.value = {
    object_type: obj.object_type,
    object_instance: obj.object_instance,
    name: obj.name,
    units: obj.units,
    behavior: obj.behavior,
    behavior_params: obj.behavior_params,
    enabled: obj.enabled,
  }
  try {
    bparams.value = JSON.parse(obj.behavior_params) || {}
  } catch {
    bparams.value = {}
  }
  objectDrawerOpen.value = true
}

function closeObjectDrawer() {
  objectDrawerOpen.value = false
  editingObject.value = null
}

async function saveObject() {
  saving.value = true
  const payload = {
    ...objectForm.value,
    behavior_params: JSON.stringify(bparams.value),
  }
  const devId = selectedDeviceId.value!
  try {
    if (editingObject.value) {
      await simFetch(`/devices/${devId}/objects/${editingObject.value.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      message.success('Object updated')
    } else {
      await simFetch(`/devices/${devId}/objects`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      message.success('Object created')
    }
    closeObjectDrawer()
    objects.value = await simFetch(`/devices/${devId}/objects`)
  } catch (e: any) {
    message.error(e.message)
  } finally {
    saving.value = false
  }
}

async function deleteObject(id: number) {
  const devId = selectedDeviceId.value!
  await simFetch(`/devices/${devId}/objects/${id}`, { method: 'DELETE' })
  message.success('Object deleted')
  objects.value = await simFetch(`/devices/${devId}/objects`)
}

// ── Set Value modal ───────────────────────────────────────────────────────────

const setValueOpen = ref(false)
const setValueTarget = ref<any>(null)
const setValueInput = ref<number>(0)
const setValueBool = ref<boolean>(true)

function openSetValue(obj: any) {
  setValueTarget.value = obj
  const live = liveState.value?.devices
    ?.find((d: any) => d.device_instance === selectedDevice.value?.device_instance)
    ?.objects?.find((o: any) => o.id === obj.id)
  const current = live?.value
  if (isAnalog(obj.object_type)) {
    setValueInput.value = typeof current === 'number' ? current : 0
  } else {
    setValueBool.value = !!current
  }
  setValueOpen.value = true
}

async function confirmSetValue() {
  if (!setValueTarget.value || !selectedDeviceId.value) return
  saving.value = true
  try {
    const value = isAnalog(setValueTarget.value.object_type) ? setValueInput.value : setValueBool.value
    await simFetch(
      `/devices/${selectedDeviceId.value}/objects/${setValueTarget.value.id}/value`,
      { method: 'POST', body: JSON.stringify({ value }) },
    )
    message.success('Value set')
    setValueOpen.value = false
  } catch (e: any) {
    message.error(e.message)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.page-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.page-header-left h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}
.page-header-right {
  display: flex;
  gap: 8px;
}
.status-tag {
  font-size: 11px;
}

/* Offline */
.offline-banner {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 24px;
  margin: 24px;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 8px;
  color: #aaa;
}
.offline-icon {
  font-size: 28px;
  color: #555;
  margin-top: 2px;
}
.offline-title {
  font-size: 15px;
  color: #ddd;
  margin-bottom: 4px;
}
.offline-sub {
  font-size: 13px;
  color: #888;
}

/* Layout */
.sim-layout {
  display: flex;
  height: 100%;
  overflow: hidden;
}

/* Device panel */
.device-panel {
  width: 260px;
  flex-shrink: 0;
  border-right: 1px solid #2a2a2a;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.device-panel-header {
  padding: 10px 16px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #666;
  border-bottom: 1px solid #222;
  flex-shrink: 0;
}
.device-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.device-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  cursor: pointer;
  border-radius: 0;
  gap: 4px;
  transition: background 0.1s;
}
.device-item:hover { background: #1f1f1f; }
.device-item.active { background: #1d3557; }
.device-item.disabled { opacity: 0.45; }
.device-item-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.device-instance {
  font-size: 10px;
  color: #666;
  font-family: monospace;
}
.device-name {
  font-size: 13px;
  color: #ddd;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.device-item-actions {
  display: flex;
  gap: 0;
  opacity: 0;
  transition: opacity 0.1s;
}
.device-item:hover .device-item-actions { opacity: 1; }
.device-empty {
  padding: 24px 16px;
  text-align: center;
  color: #555;
  font-size: 13px;
}

/* Object panel */
.object-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.object-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #2a2a2a;
  flex-shrink: 0;
}
.object-panel-title {
  font-size: 14px;
  font-weight: 600;
  color: #ddd;
  margin-right: 8px;
}
.object-panel-sub {
  font-size: 12px;
  color: #666;
}
.object-table {
  flex: 1;
  overflow: auto;
}
.object-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #555;
  font-size: 14px;
}
.placeholder-icon {
  font-size: 40px;
  color: #333;
}

/* Table cells */
.type-tag, .behavior-tag {
  font-size: 11px;
  font-family: monospace;
}
.live-value {
  font-family: monospace;
  font-size: 13px;
  color: #52c41a;
}
.live-value.stale { color: #666; }

/* Behavior params section */
.behavior-params {
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  padding: 12px 12px 0;
  margin-bottom: 16px;
}
</style>
