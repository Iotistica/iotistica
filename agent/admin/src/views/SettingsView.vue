<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { message } from 'ant-design-vue'
import { SaveOutlined, ReloadOutlined, LinkOutlined, CheckCircleOutlined } from '@ant-design/icons-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { settingsApi } from '@/api/settings'
import { client as apiClient } from '@/api/client'
import { dockerConfigApi } from '@/api/containers'
import type { DockerConfig } from '@/api/containers'
import type { AgentSettings } from '@/types'

const activeTab = ref('agent')

const loading = ref(false)
const saving = ref(false)
const saved = ref(false)
const loadError = ref<string | null>(null)

const settings = ref<AgentSettings>({})

// Deep clone for "discard changes" reset
let lastSaved: AgentSettings = {}

onMounted(() => { load(); loadDockerConfig() })

async function load() {
  loading.value = true
  loadError.value = null
  try {
    settings.value = await settingsApi.get()
    lastSaved = JSON.parse(JSON.stringify(settings.value))
  } catch (e: any) {
    loadError.value = e?.message ?? 'Failed to load settings'
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  saved.value = false
  try {
    // Omit the read-only `agent` field before sending
    const { agent: _agent, ...patch } = settings.value
    settings.value = await settingsApi.update(patch)
    lastSaved = JSON.parse(JSON.stringify(settings.value))
    saved.value = true
    message.success('Settings saved')
  } catch (e: any) {
    message.error(e?.message ?? 'Save failed')
  } finally {
    saving.value = false
  }
}

function discard() {
  settings.value = JSON.parse(JSON.stringify(lastSaved))
  saved.value = false
  message.info('Changes discarded')
}

// ── target sync toggle ────────────────────────────────────────────────────────

const targetSyncSaving = ref(false)

async function setTargetSync(enabled: boolean) {
  targetSyncSaving.value = true
  try {
    const { data } = await apiClient.patch('/v1/settings/target-sync', { enabled })
    settings.value = data.settings
    lastSaved = JSON.parse(JSON.stringify(settings.value))
    message.success(enabled ? 'Target sync enabled — agent will now pull cloud state' : 'Target sync disabled — agent reports only')
  } catch (e: any) {
    message.error(e?.message ?? 'Failed to update target sync')
  } finally {
    targetSyncSaving.value = false
  }
}

// ── provisioning ───────────────────────────────────────────────────────────────

const provisioning = ref(false)
const provisionForm = ref({ key: '', apiEndpoint: '', deviceName: '' })

async function provision() {
  if (!provisionForm.value.key.trim()) {
    message.error('Provisioning key is required')
    return
  }
  provisioning.value = true
  try {
    await settingsApi.provision({
      provisioningApiKey: provisionForm.value.key.trim(),
      ...(provisionForm.value.apiEndpoint.trim() ? { apiEndpoint: provisionForm.value.apiEndpoint.trim() } : {}),
      ...(provisionForm.value.deviceName.trim() ? { deviceName: provisionForm.value.deviceName.trim() } : {}),
    })
    message.success('Agent provisioned successfully')
    // Reload settings so Agent Info reflects the new provisioned state
    await load()
    provisionForm.value = { key: '', apiEndpoint: '', deviceName: '' }
  } catch (e: any) {
    message.error(e?.response?.data?.message ?? e?.message ?? 'Provisioning failed')
  } finally {
    provisioning.value = false
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

function msToHuman(ms: number | undefined): string {
  if (ms == null) return ''
  if (ms >= 86_400_000) return `${ms / 86_400_000}d`
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`
  if (ms >= 60_000) return `${ms / 60_000}m`
  return `${ms / 1000}s`
}

function ensureLogging() {
  if (!settings.value.logging) settings.value.logging = {}
}
function ensureFeatures() {
  if (!settings.value.features) settings.value.features = {}
}
function ensureIntervals() {
  if (!settings.value.intervals) settings.value.intervals = {}
  if (!settings.value.intervals.agent) settings.value.intervals.agent = {}
  if (!settings.value.intervals.discovery) settings.value.intervals.discovery = {}
}
function ensureRuntime() {
  if (!settings.value.runtime) settings.value.runtime = {}
  if (!settings.value.runtime.memory) settings.value.runtime.memory = {}
}

// ── Docker daemon config ──────────────────────────────────────────────────────

const dockerConfig = ref<DockerConfig>({ type: 'socket' })
const dockerLoading = ref(false)
const dockerSaving = ref(false)
const dockerTesting = ref(false)
const dockerTestResult = ref<{ version: string; containers: number } | null>(null)
const dockerTestError = ref<string | null>(null)

async function loadDockerConfig() {
  dockerLoading.value = true
  try {
    dockerConfig.value = await dockerConfigApi.get()
  } catch {
    // non-fatal — defaults to socket
  } finally {
    dockerLoading.value = false
  }
}

async function saveDockerConfig() {
  dockerSaving.value = true
  dockerTestResult.value = null
  dockerTestError.value = null
  try {
    await dockerConfigApi.save(dockerConfig.value)
    message.success('Docker configuration saved')
  } catch (e: any) {
    message.error(e?.message ?? 'Failed to save Docker config')
  } finally {
    dockerSaving.value = false
  }
}

async function testDockerConnection() {
  dockerTesting.value = true
  dockerTestResult.value = null
  dockerTestError.value = null
  try {
    dockerTestResult.value = await dockerConfigApi.test(dockerConfig.value)
  } catch (e: any) {
    dockerTestError.value = e?.response?.data?.error ?? e?.message ?? 'Connection failed'
  } finally {
    dockerTesting.value = false
  }
}

function onDockerTypeChange() {
  dockerTestResult.value = null
  dockerTestError.value = null
}

// ── Schema Drift ───────────────────────────────────────────────────────────────

interface DriftOptions {
  enabled?: boolean
  warmupBatches?: number
  consecutiveMissingThreshold?: number
  alertCooldownMs?: number
  minFieldPresenceRatio?: number
}

interface ProtocolOutput {
  protocol: string
  drift_options?: DriftOptions | null
}

const protocolOutputs = ref<ProtocolOutput[]>([])
const driftSaving = ref<Record<string, boolean>>({})

async function loadProtocolOutputs() {
  try {
    const { data } = await apiClient.get('/v1/protocol-outputs')
    protocolOutputs.value = data.outputs ?? []
  } catch {
    // non-fatal
  }
}

function getDrift(output: ProtocolOutput): DriftOptions {
  return output.drift_options ?? {}
}

async function saveDrift(output: ProtocolOutput) {
  driftSaving.value[output.protocol] = true
  try {
    const res = await apiClient.patch(`/v1/protocol-outputs/${output.protocol}/drift`, {
      drift_options: output.drift_options,
    })
    const idx = protocolOutputs.value.findIndex(o => o.protocol === output.protocol)
    if (idx >= 0) protocolOutputs.value[idx] = res.data.output
    message.success(`Drift settings saved for ${output.protocol}`)
  } catch (e: any) {
    message.error(e?.message ?? 'Save failed')
  } finally {
    driftSaving.value[output.protocol] = false
  }
}

function setDrift<K extends keyof DriftOptions>(output: ProtocolOutput, key: K, val: DriftOptions[K]) {
  if (!output.drift_options) output.drift_options = {}
  output.drift_options[key] = val
}

onMounted(loadProtocolOutputs)

function setLogging<K extends keyof NonNullable<AgentSettings['logging']>>(
  key: K,
  val: NonNullable<AgentSettings['logging']>[K],
) {
  ensureLogging()
  settings.value.logging![key] = val
}
function setFeature<K extends keyof NonNullable<AgentSettings['features']>>(
  key: K,
  val: NonNullable<AgentSettings['features']>[K],
) {
  ensureFeatures()
  settings.value.features![key] = val
}
function setAgentInterval<K extends keyof NonNullable<NonNullable<AgentSettings['intervals']>['agent']>>(
  key: K,
  val: number,
) {
  ensureIntervals()
  settings.value.intervals!.agent![key] = val
}
function setDiscoveryInterval<K extends keyof NonNullable<NonNullable<AgentSettings['intervals']>['discovery']>>(
  key: K,
  val: number,
) {
  ensureIntervals()
  settings.value.intervals!.discovery![key] = val
}
function setMemory<K extends keyof NonNullable<NonNullable<AgentSettings['runtime']>['memory']>>(
  key: K,
  val: number,
) {
  ensureRuntime()
  settings.value.runtime!.memory![key] = val
}
</script>

<template>
  <AppLayout title="Settings">

    <!-- Global alerts -->
    <a-alert
      v-if="saved"
      type="info"
      show-icon
      message="Settings saved — changes take effect on the next reconciliation cycle (~30 seconds)."
      closable
      style="margin-bottom: 16px"
      @close="saved = false"
    />
    <a-alert
      v-if="loadError"
      type="error"
      show-icon
      :message="loadError"
      style="margin-bottom: 16px"
    >
      <template #action>
        <a-button size="small" @click="load">
          <template #icon><ReloadOutlined /></template>
          Retry
        </a-button>
      </template>
    </a-alert>

    <a-spin :spinning="loading">
      <a-tabs v-model:active-key="activeTab">

        <!-- ══ AGENT ══════════════════════════════════════════════════════════ -->
        <a-tab-pane key="agent" tab="Agent">
          <a-card size="small">
            <a-descriptions :column="2" size="small" bordered>
              <a-descriptions-item label="UUID" :span="2">
                <a-typography-text copyable :content="settings.agent?.uuid ?? '—'">
                  {{ settings.agent?.uuid ?? '—' }}
                </a-typography-text>
              </a-descriptions-item>
              <a-descriptions-item label="Name">{{ settings.agent?.name ?? '—' }}</a-descriptions-item>
              <a-descriptions-item label="Type">{{ settings.agent?.type ?? '—' }}</a-descriptions-item>
              <a-descriptions-item label="Version">
                <a-tag v-if="settings.agent?.version" color="blue">v{{ settings.agent.version }}</a-tag>
                <span v-else>—</span>
              </a-descriptions-item>
              <a-descriptions-item label="Status">
                <a-badge
                  :status="settings.agent?.provisioned ? 'success' : 'default'"
                  :text="settings.agent?.provisioned ? 'Provisioned' : 'Not provisioned'"
                />
              </a-descriptions-item>
              <a-descriptions-item label="Tenant ID">{{ settings.agent?.tenantId ?? '—' }}</a-descriptions-item>
              <a-descriptions-item label="Registered at">
                {{ settings.agent?.registeredAt ? new Date(settings.agent.registeredAt).toLocaleString() : '—' }}
              </a-descriptions-item>
              <template v-if="settings.agent?.macAddress">
                <a-descriptions-item label="MAC address">{{ settings.agent.macAddress }}</a-descriptions-item>
              </template>
              <template v-if="settings.agent?.osVersion">
                <a-descriptions-item label="OS version">{{ settings.agent.osVersion }}</a-descriptions-item>
              </template>
              <template v-if="settings.agent?.provisioned">
                <a-descriptions-item label="API endpoint" :span="2">
                  <a-typography-text copyable :content="settings.agent.apiEndpoint ?? '—'">
                    {{ settings.agent.apiEndpoint ?? '—' }}
                  </a-typography-text>
                </a-descriptions-item>
                <a-descriptions-item label="MQTT broker" :span="2">
                  <a-typography-text copyable :content="settings.agent.mqttBrokerUrl ?? '—'">
                    {{ settings.agent.mqttBrokerUrl ?? '—' }}
                  </a-typography-text>
                </a-descriptions-item>
                <a-descriptions-item label="MQTT username">
                  <a-typography-text copyable :content="settings.agent.mqttUsername ?? '—'">
                    {{ settings.agent.mqttUsername ?? '—' }}
                  </a-typography-text>
                </a-descriptions-item>
                <a-descriptions-item label="MQTT TLS">
                  <a-badge
                    :status="settings.agent.mqttUseTls ? 'success' : 'default'"
                    :text="settings.agent.mqttUseTls === null ? '—' : settings.agent.mqttUseTls ? 'Enabled' : 'Disabled'"
                  />
                </a-descriptions-item>
                <a-descriptions-item label="MQTT client ID prefix" :span="2">
                  <a-typography-text copyable :content="settings.agent.mqttClientIdPrefix ?? '—'">
                    {{ settings.agent.mqttClientIdPrefix ?? '—' }}
                  </a-typography-text>
                </a-descriptions-item>
                <a-descriptions-item label="Cloud target sync" :span="2">
                  <div style="display: flex; align-items: center; gap: 12px">
                    <a-switch
                      :checked="settings.agent.targetSyncEnabled !== false"
                      :loading="targetSyncSaving"
                      @change="(v: boolean) => setTargetSync(v)"
                    />
                    <span style="font-size: 12px; color: rgba(0,0,0,.45)">
                      {{ settings.agent.targetSyncEnabled !== false
                        ? 'Pulling target state from cloud'
                        : 'Report-only — cloud cannot push config changes' }}
                    </span>
                  </div>
                </a-descriptions-item>
              </template>
            </a-descriptions>

            <template v-if="!settings.agent?.provisioned">
              <a-divider style="margin: 16px 0 12px" />
              <p style="margin: 0 0 12px; font-size: 13px; font-weight: 600; color: rgba(0,0,0,.65)">
                Connect to Iotistica
              </p>
              <a-row :gutter="[12, 12]">
                <a-col :span="24">
                  <a-form-item label="Provisioning key" style="margin-bottom: 0" required>
                    <a-input-password
                      v-model:value="provisionForm.key"
                      placeholder="Paste your provisioning key"
                      :disabled="provisioning"
                    />
                  </a-form-item>
                </a-col>
                <a-col :span="12">
                  <a-form-item label="API endpoint" style="margin-bottom: 0">
                    <a-input
                      v-model:value="provisionForm.apiEndpoint"
                      placeholder="https://api.iotistica.com (optional)"
                      :disabled="provisioning"
                    />
                  </a-form-item>
                </a-col>
                <a-col :span="12">
                  <a-form-item label="Device name" style="margin-bottom: 0">
                    <a-input
                      v-model:value="provisionForm.deviceName"
                      placeholder="Optional override"
                      :disabled="provisioning"
                    />
                  </a-form-item>
                </a-col>
                <a-col :span="24" style="display: flex; justify-content: flex-end">
                  <a-button
                    type="primary"
                    :loading="provisioning"
                    :disabled="!provisionForm.key.trim()"
                    @click="provision"
                  >
                    <template #icon><LinkOutlined /></template>
                    {{ provisioning ? 'Connecting…' : 'Connect to Iotistica' }}
                  </a-button>
                </a-col>
              </a-row>
            </template>
          </a-card>
        </a-tab-pane>

        <!-- ══ FEATURES ═══════════════════════════════════════════════════════ -->
        <a-tab-pane key="features" tab="Features">
          <a-card size="small">
            <a-space direction="vertical" style="width: 100%">
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">Metrics Publishing</div>
                  <div class="toggle-desc">Automatically publish device data to MQTT broker</div>
                </div>
                <a-switch
                  :checked="settings.features?.enableDevicePublish ?? true"
                  @change="(v: boolean) => setFeature('enableDevicePublish', v)"
                />
              </div>
              <a-divider style="margin: 8px 0" />
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">Anomaly Detection</div>
                  <div class="toggle-desc">Enable AI-powered anomaly detection for metrics</div>
                </div>
                <a-switch
                  :checked="settings.features?.enableAnomalyDetection ?? false"
                  @change="(v: boolean) => setFeature('enableAnomalyDetection', v)"
                />
              </div>
              <a-divider style="margin: 8px 0" />
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">Remote Access</div>
                  <div class="toggle-desc">Allow remote terminal access to the agent</div>
                </div>
                <a-switch
                  :checked="settings.features?.enableDeviceRemoteAccess ?? true"
                  @change="(v: boolean) => setFeature('enableDeviceRemoteAccess', v)"
                />
              </div>
              <a-divider style="margin: 8px 0" />
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">Device Jobs</div>
                  <div class="toggle-desc">Enable the job execution engine on the agent</div>
                </div>
                <a-switch
                  :checked="settings.features?.enableDeviceJobs ?? true"
                  @change="(v: boolean) => setFeature('enableDeviceJobs', v)"
                />
              </div>
            </a-space>
          </a-card>
          <div class="save-bar">
            <a-button :disabled="saving" @click="discard">Discard</a-button>
            <a-button type="primary" :loading="saving" @click="save">
              <template #icon><SaveOutlined /></template>
              Save
            </a-button>
          </div>
        </a-tab-pane>

        <!-- ══ LOGGING ════════════════════════════════════════════════════════ -->
        <a-tab-pane key="logging" tab="Logging">
          <a-card size="small">
            <a-row :gutter="[16, 16]">
              <a-col :span="6">
                <a-form-item label="Log level" style="margin-bottom: 0">
                  <a-select
                    :value="settings.logging?.level ?? 'info'"
                    style="width: 100%"
                    @change="(v: string) => setLogging('level', v as any)"
                  >
                    <a-select-option value="debug">Debug</a-select-option>
                    <a-select-option value="info">Info</a-select-option>
                    <a-select-option value="warn">Warning</a-select-option>
                    <a-select-option value="error">Error</a-select-option>
                  </a-select>
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item label="Max entries" style="margin-bottom: 0">
                  <a-input-number
                    :value="settings.logging?.maxLogs ?? 10000"
                    :min="100"
                    :max="100000"
                    style="width: 100%"
                    @change="(v: number) => setLogging('maxLogs', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item style="margin-bottom: 0">
                  <template #label>
                    Max age (ms)
                    <a-typography-text type="secondary" style="font-size: 12px; margin-left: 6px">
                      {{ msToHuman(settings.logging?.logMaxAge) }}
                    </a-typography-text>
                  </template>
                  <a-input-number
                    :value="settings.logging?.logMaxAge ?? 86400000"
                    :min="60000"
                    style="width: 100%"
                    @change="(v: number) => setLogging('logMaxAge', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item label="Max file (bytes)" style="margin-bottom: 0">
                  <a-input-number
                    :value="settings.logging?.maxLogFileSize ?? 52428800"
                    :min="1048576"
                    style="width: 100%"
                    @change="(v: number) => setLogging('maxLogFileSize', v)"
                  />
                </a-form-item>
              </a-col>
            </a-row>
            <a-divider style="margin: 16px 0 12px" />
            <a-space direction="vertical" style="width: 100%">
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">Compression</div>
                  <div class="toggle-desc">Compress log files to save disk space</div>
                </div>
                <a-switch
                  :checked="settings.logging?.enableCompression ?? false"
                  @change="(v: boolean) => setLogging('enableCompression', v)"
                />
              </div>
              <a-divider style="margin: 8px 0" />
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">Remote logging</div>
                  <div class="toggle-desc">Send logs to the cloud API for centralised monitoring</div>
                </div>
                <a-switch
                  :checked="settings.logging?.enableRemoteLogging ?? false"
                  @change="(v: boolean) => setLogging('enableRemoteLogging', v)"
                />
              </div>
              <a-divider style="margin: 8px 0" />
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">File persistence</div>
                  <div class="toggle-desc">Persist logs to disk for local debugging</div>
                </div>
                <a-switch
                  :checked="settings.logging?.enableFilePersistence ?? false"
                  @change="(v: boolean) => setLogging('enableFilePersistence', v)"
                />
              </div>
            </a-space>
          </a-card>
          <div class="save-bar">
            <a-button :disabled="saving" @click="discard">Discard</a-button>
            <a-button type="primary" :loading="saving" @click="save">
              <template #icon><SaveOutlined /></template>
              Save
            </a-button>
          </div>
        </a-tab-pane>

        <!-- ══ INTERVALS ══════════════════════════════════════════════════════ -->
        <a-tab-pane key="intervals" tab="Intervals">
          <a-card size="small" style="margin-bottom: 12px">
            <template #title>Agent communication</template>
            <a-row :gutter="[16, 16]">
              <a-col :span="6">
                <a-form-item style="margin-bottom: 0">
                  <template #label>
                    Report (ms)
                    <a-typography-text type="secondary" style="font-size: 12px; margin-left: 4px">
                      {{ msToHuman(settings.intervals?.agent?.reportIntervalMs) }}
                    </a-typography-text>
                  </template>
                  <a-input-number
                    :value="settings.intervals?.agent?.reportIntervalMs ?? 60000"
                    :min="5000"
                    style="width: 100%"
                    @change="(v: number) => setAgentInterval('reportIntervalMs', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item style="margin-bottom: 0">
                  <template #label>
                    Metrics (ms)
                    <a-typography-text type="secondary" style="font-size: 12px; margin-left: 4px">
                      {{ msToHuman(settings.intervals?.agent?.metricsIntervalMs) }}
                    </a-typography-text>
                  </template>
                  <a-input-number
                    :value="settings.intervals?.agent?.metricsIntervalMs ?? 60000"
                    :min="5000"
                    style="width: 100%"
                    @change="(v: number) => setAgentInterval('metricsIntervalMs', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item style="margin-bottom: 0">
                  <template #label>
                    Reconciliation (ms)
                    <a-typography-text type="secondary" style="font-size: 12px; margin-left: 4px">
                      {{ msToHuman(settings.intervals?.agent?.reconciliationIntervalMs) }}
                    </a-typography-text>
                  </template>
                  <a-input-number
                    :value="settings.intervals?.agent?.reconciliationIntervalMs ?? 30000"
                    :min="5000"
                    style="width: 100%"
                    @change="(v: number) => setAgentInterval('reconciliationIntervalMs', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item style="margin-bottom: 0">
                  <template #label>
                    Target state poll (ms)
                    <a-typography-text type="secondary" style="font-size: 12px; margin-left: 4px">
                      {{ msToHuman(settings.intervals?.agent?.targetStatePollIntervalMs) }}
                    </a-typography-text>
                  </template>
                  <a-input-number
                    :value="settings.intervals?.agent?.targetStatePollIntervalMs ?? 60000"
                    :min="5000"
                    style="width: 100%"
                    @change="(v: number) => setAgentInterval('targetStatePollIntervalMs', v)"
                  />
                </a-form-item>
              </a-col>
            </a-row>
          </a-card>

          <a-card size="small" style="margin-bottom: 12px">
            <template #title>Discovery scanning</template>
            <a-row :gutter="[16, 16]">
              <a-col :span="6">
                <a-form-item style="margin-bottom: 0">
                  <template #label>
                    Full scan (ms)
                    <a-typography-text type="secondary" style="font-size: 12px; margin-left: 4px">
                      {{ msToHuman(settings.intervals?.discovery?.fullIntervalMs) }}
                    </a-typography-text>
                  </template>
                  <a-input-number
                    :value="settings.intervals?.discovery?.fullIntervalMs ?? 86400000"
                    :min="60000"
                    style="width: 100%"
                    @change="(v: number) => setDiscoveryInterval('fullIntervalMs', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item style="margin-bottom: 0">
                  <template #label>
                    Light scan (ms)
                    <a-typography-text type="secondary" style="font-size: 12px; margin-left: 4px">
                      {{ msToHuman(settings.intervals?.discovery?.lightIntervalMs) }}
                    </a-typography-text>
                  </template>
                  <a-input-number
                    :value="settings.intervals?.discovery?.lightIntervalMs ?? 14400000"
                    :min="60000"
                    style="width: 100%"
                    @change="(v: number) => setDiscoveryInterval('lightIntervalMs', v)"
                  />
                </a-form-item>
              </a-col>
            </a-row>
          </a-card>

          <a-card size="small">
            <template #title>Runtime &amp; Memory</template>
            <a-row :gutter="[16, 16]">
              <a-col :span="6">
                <a-form-item label="Memory threshold (MB)" style="margin-bottom: 0">
                  <a-input-number
                    :value="settings.runtime?.memory?.thresholdMb ?? 30"
                    :min="10"
                    style="width: 100%"
                    @change="(v: number) => setMemory('thresholdMb', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item style="margin-bottom: 0">
                  <template #label>
                    Check interval (ms)
                    <a-typography-text type="secondary" style="font-size: 12px; margin-left: 4px">
                      {{ msToHuman(settings.runtime?.memory?.checkIntervalMs) }}
                    </a-typography-text>
                  </template>
                  <a-input-number
                    :value="settings.runtime?.memory?.checkIntervalMs ?? 30000"
                    :min="5000"
                    style="width: 100%"
                    @change="(v: number) => setMemory('checkIntervalMs', v)"
                  />
                </a-form-item>
              </a-col>
            </a-row>
          </a-card>

          <div class="save-bar">
            <a-button :disabled="saving" @click="discard">Discard</a-button>
            <a-button type="primary" :loading="saving" @click="save">
              <template #icon><SaveOutlined /></template>
              Save
            </a-button>
          </div>
        </a-tab-pane>

        <!-- ══ SCHEMA DRIFT ═══════════════════════════════════════════════════ -->
        <a-tab-pane key="drift" tab="Schema Drift">
          <p style="margin: 0 0 16px; font-size: 13px; color: #888">
            Controls how the agent detects unexpected changes in the fields published by each protocol pipe.
            Settings take effect after the agent restarts.
          </p>

          <div v-if="!protocolOutputs.length" style="color: #aaa; font-size: 13px">
            No protocol outputs configured.
          </div>

          <div
            v-for="output in protocolOutputs"
            :key="output.protocol"
            style="margin-bottom: 12px; padding: 16px; background: #fafafa; border: 1px solid #f0f0f0; border-radius: 8px"
          >
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px">
              <span style="font-weight: 600; font-size: 13px; text-transform: capitalize">{{ output.protocol }}</span>
              <div style="display: flex; align-items: center; gap: 8px">
                <span style="font-size: 12px; color: #888">Enabled</span>
                <a-switch
                  :checked="getDrift(output).enabled !== false"
                  size="small"
                  @change="(v: boolean) => setDrift(output, 'enabled', v)"
                />
              </div>
            </div>
            <a-row :gutter="[16, 12]">
              <a-col :span="6">
                <a-form-item label="Warmup batches" style="margin-bottom: 0">
                  <a-input-number
                    :value="getDrift(output).warmupBatches ?? 20"
                    :min="1" :max="500"
                    style="width: 100%"
                    @change="(v: number) => setDrift(output, 'warmupBatches', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item label="Missing threshold" style="margin-bottom: 0">
                  <a-input-number
                    :value="getDrift(output).consecutiveMissingThreshold ?? 10"
                    :min="1" :max="1000"
                    style="width: 100%"
                    @change="(v: number) => setDrift(output, 'consecutiveMissingThreshold', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item label="Alert cooldown (ms)" style="margin-bottom: 0">
                  <a-input-number
                    :value="getDrift(output).alertCooldownMs ?? 1800000"
                    :min="0" :step="60000"
                    style="width: 100%"
                    @change="(v: number) => setDrift(output, 'alertCooldownMs', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item label="Min presence ratio" style="margin-bottom: 0">
                  <a-input-number
                    :value="getDrift(output).minFieldPresenceRatio ?? 0.5"
                    :min="0" :max="1" :step="0.05" :precision="2"
                    style="width: 100%"
                    @change="(v: number) => setDrift(output, 'minFieldPresenceRatio', v)"
                  />
                </a-form-item>
              </a-col>
            </a-row>
            <div style="margin-top: 12px; display: flex; justify-content: flex-end">
              <a-button
                type="primary"
                size="small"
                :loading="driftSaving[output.protocol]"
                @click="saveDrift(output)"
              >
                <template #icon><SaveOutlined /></template>
                Save
              </a-button>
            </div>
          </div>
        </a-tab-pane>

        <!-- ══ DOCKER ══════════════════════════════════════════════════════════ -->
        <a-tab-pane key="docker" tab="Docker">
          <a-spin :spinning="dockerLoading">
            <a-card size="small" title="Daemon Connection">
              <a-form layout="vertical">

                <a-form-item label="Connection type">
                  <a-radio-group
                    v-model:value="dockerConfig.type"
                    button-style="solid"
                    @change="onDockerTypeChange"
                  >
                    <a-radio-button value="socket">Local socket</a-radio-button>
                    <a-radio-button value="tcp">Remote TCP</a-radio-button>
                    <a-radio-button value="tcp+tls">Remote TCP + TLS</a-radio-button>
                  </a-radio-group>
                  <div style="font-size: 12px; color: #888; margin-top: 6px">
                    <template v-if="dockerConfig.type === 'socket'">
                      Connects to the Docker daemon on this device via a Unix socket or Windows named pipe.
                    </template>
                    <template v-else-if="dockerConfig.type === 'tcp'">
                      Connects to a remote Docker daemon over an unencrypted TCP connection. Only use on trusted networks.
                    </template>
                    <template v-else>
                      Connects to a remote Docker daemon over TLS. Requires CA certificate and client credentials.
                    </template>
                  </div>
                </a-form-item>

                <!-- Socket path -->
                <a-form-item v-if="dockerConfig.type === 'socket'" label="Socket path">
                  <a-input
                    v-model:value="dockerConfig.socketPath"
                    placeholder="/var/run/docker.sock  (Linux/Mac)   or   //./pipe/docker_engine  (Windows)"
                    style="font-family: monospace; font-size: 12px"
                  />
                  <div style="font-size: 12px; color: #888; margin-top: 4px">
                    Leave blank to use the platform default.
                  </div>
                </a-form-item>

                <!-- TCP host + port -->
                <template v-if="dockerConfig.type === 'tcp' || dockerConfig.type === 'tcp+tls'">
                  <div style="display: grid; grid-template-columns: 1fr 140px; gap: 12px">
                    <a-form-item label="Host">
                      <a-input v-model:value="dockerConfig.host" placeholder="192.168.1.100" />
                    </a-form-item>
                    <a-form-item label="Port">
                      <a-input-number
                        v-model:value="dockerConfig.port"
                        :placeholder="dockerConfig.type === 'tcp+tls' ? '2376' : '2375'"
                        style="width: 100%"
                        :min="1"
                        :max="65535"
                      />
                    </a-form-item>
                  </div>
                </template>

                <!-- TLS certificates -->
                <template v-if="dockerConfig.type === 'tcp+tls'">
                  <a-form-item label="CA certificate (PEM)">
                    <a-textarea
                      v-model:value="dockerConfig.ca"
                      placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                      :rows="4"
                      style="font-family: monospace; font-size: 12px"
                    />
                  </a-form-item>
                  <a-form-item label="Client certificate (PEM)">
                    <a-textarea
                      v-model:value="dockerConfig.cert"
                      placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                      :rows="4"
                      style="font-family: monospace; font-size: 12px"
                    />
                  </a-form-item>
                  <a-form-item label="Client key (PEM)">
                    <a-textarea
                      v-model:value="dockerConfig.key"
                      placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                      :rows="4"
                      style="font-family: monospace; font-size: 12px"
                    />
                  </a-form-item>
                </template>

                <!-- Test result -->
                <a-alert
                  v-if="dockerTestResult"
                  type="success"
                  show-icon
                  style="margin-bottom: 12px"
                >
                  <template #icon><CheckCircleOutlined /></template>
                  <template #message>
                    Connected — Docker {{ dockerTestResult.version }},
                    {{ dockerTestResult.containers }} container{{ dockerTestResult.containers !== 1 ? 's' : '' }}
                  </template>
                </a-alert>
                <a-alert
                  v-if="dockerTestError"
                  type="error"
                  :message="dockerTestError"
                  show-icon
                  style="margin-bottom: 12px"
                />

              </a-form>
            </a-card>

            <div class="save-bar">
              <a-button :loading="dockerTesting" @click="testDockerConnection">
                <template #icon><LinkOutlined /></template>
                Test Connection
              </a-button>
              <a-button type="primary" :loading="dockerSaving" @click="saveDockerConfig">
                <template #icon><SaveOutlined /></template>
                Save
              </a-button>
            </div>
          </a-spin>
        </a-tab-pane>

      </a-tabs>
    </a-spin>
  </AppLayout>
</template>

<style scoped>
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 0;
}
.toggle-label {
  font-size: 14px;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.85);
}
.toggle-desc {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
  margin-top: 2px;
}
.save-bar {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 16px;
}
</style>
