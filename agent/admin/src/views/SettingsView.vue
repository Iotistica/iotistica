<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { message } from 'ant-design-vue'
import {
  InfoCircleOutlined,
  FileTextOutlined,
  ControlOutlined,
  ClockCircleOutlined,
  ThunderboltOutlined,
  SaveOutlined,
  ReloadOutlined,
  LinkOutlined,
} from '@ant-design/icons-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { settingsApi } from '@/api/settings'
import type { AgentSettings } from '@/types'

const loading = ref(false)
const saving = ref(false)
const saved = ref(false)
const loadError = ref<string | null>(null)

const settings = ref<AgentSettings>({})

// Deep clone for "discard changes" reset
let lastSaved: AgentSettings = {}

onMounted(load)

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
    <div style="max-width: 860px; margin: 0 auto">

      <!-- Top action bar -->
      <div style="display: flex; justify-content: flex-end; margin-bottom: 20px; gap: 8px">
        <a-button :disabled="saving" @click="discard">Discard</a-button>
        <a-button type="primary" :loading="saving" @click="save">
          <template #icon><SaveOutlined /></template>
          Save
        </a-button>
      </div>

      <!-- Saved banner -->
      <a-alert
        v-if="saved"
        type="info"
        show-icon
        message="Settings saved — changes take effect on the next reconciliation cycle (~30 seconds)."
        closable
        style="margin-bottom: 20px"
        @close="saved = false"
      />

      <!-- Load error -->
      <a-alert
        v-if="loadError"
        type="error"
        show-icon
        :message="loadError"
        style="margin-bottom: 20px"
      >
        <template #action>
          <a-button size="small" @click="load">
            <template #icon><ReloadOutlined /></template>
            Retry
          </a-button>
        </template>
      </a-alert>

      <a-spin :spinning="loading">
        <!-- No config yet -->
        <a-empty
          v-if="!loading && !loadError && Object.keys(settings).filter(k => k !== 'agent').length === 0"
          description="No configuration stored yet — defaults are active inside the agent."
          style="margin: 40px 0"
        />

        <!-- ── Agent Info ──────────────────────────────────────────────────── -->
        <a-card style="margin-bottom: 16px">
          <template #title>
            <InfoCircleOutlined style="margin-right: 8px" />
            Agent Info
          </template>

          <a-descriptions :column="2" size="small">
            <a-descriptions-item label="UUID">
              <a-typography-text copyable :content="settings.agent?.uuid ?? '—'">
                {{ settings.agent?.uuid ?? '—' }}
              </a-typography-text>
            </a-descriptions-item>
            <a-descriptions-item label="Name">{{ settings.agent?.name ?? '—' }}</a-descriptions-item>
            <a-descriptions-item label="Version">
              <a-tag v-if="settings.agent?.version" color="blue">v{{ settings.agent.version }}</a-tag>
              <span v-else>—</span>
            </a-descriptions-item>
            <a-descriptions-item label="Provisioned">
              <a-badge
                :status="settings.agent?.provisioned ? 'success' : 'default'"
                :text="settings.agent?.provisioned ? 'Yes' : 'No'"
              />
            </a-descriptions-item>
            <template v-if="settings.agent?.provisioned">
              <a-descriptions-item label="API endpoint" :span="2">
                {{ settings.agent.apiEndpoint ?? '—' }}
              </a-descriptions-item>
              <a-descriptions-item label="MQTT broker" :span="2">
                {{ settings.agent.mqttBrokerUrl ?? '—' }}
              </a-descriptions-item>
            </template>
          </a-descriptions>

          <!-- Provisioning form — shown only when not provisioned -->
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
                  {{ provisioning ? 'Connecting to Iotistica…' : 'Connect to Iotistica' }}
                </a-button>
              </a-col>
            </a-row>
          </template>
        </a-card>

        <!-- ── Features ───────────────────────────────────────────────────── -->
        <a-card style="margin-bottom: 16px">
          <template #title>
            <ControlOutlined style="margin-right: 8px" />
            Features
          </template>
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

        <!-- ── Logging ─────────────────────────────────────────────────────── -->
        <a-card style="margin-bottom: 16px">
          <template #title>
            <FileTextOutlined style="margin-right: 8px" />
            Logging
          </template>
          <a-row :gutter="[16, 16]">
            <a-col :span="12">
              <a-form-item label="Log level" style="margin-bottom: 0">
                <a-select
                  :value="settings.logging?.level ?? 'info'"
                  @change="(v: string) => setLogging('level', v as any)"
                  style="width: 100%"
                >
                  <a-select-option value="debug">Debug</a-select-option>
                  <a-select-option value="info">Info</a-select-option>
                  <a-select-option value="warn">Warning</a-select-option>
                  <a-select-option value="error">Error</a-select-option>
                </a-select>
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item label="Max log entries" style="margin-bottom: 0">
                <a-input-number
                  :value="settings.logging?.maxLogs ?? 10000"
                  :min="100"
                  :max="100000"
                  style="width: 100%"
                  @change="(v: number) => setLogging('maxLogs', v)"
                />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item style="margin-bottom: 0">
                <template #label>
                  Log max age (ms)
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
            <a-col :span="12">
              <a-form-item label="Max log file (bytes)" style="margin-bottom: 0">
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

        <!-- ── Intervals ───────────────────────────────────────────────────── -->
        <a-card style="margin-bottom: 16px">
          <template #title>
            <ClockCircleOutlined style="margin-right: 8px" />
            Intervals &amp; Timing
          </template>

          <p style="margin: 0 0 12px; font-size: 13px; font-weight: 600; color: rgba(0,0,0,.65)">
            Agent communication
          </p>
          <a-row :gutter="[16, 16]">
            <a-col :span="12">
              <a-form-item style="margin-bottom: 0">
                <template #label>
                  Report interval (ms)
                  <a-typography-text type="secondary" style="font-size: 12px; margin-left: 6px">
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
            <a-col :span="12">
              <a-form-item style="margin-bottom: 0">
                <template #label>
                  Metrics interval (ms)
                  <a-typography-text type="secondary" style="font-size: 12px; margin-left: 6px">
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
            <a-col :span="12">
              <a-form-item style="margin-bottom: 0">
                <template #label>
                  Reconciliation interval (ms)
                  <a-typography-text type="secondary" style="font-size: 12px; margin-left: 6px">
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
            <a-col :span="12">
              <a-form-item style="margin-bottom: 0">
                <template #label>
                  Target state poll (ms)
                  <a-typography-text type="secondary" style="font-size: 12px; margin-left: 6px">
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

          <a-divider style="margin: 16px 0 12px" />
          <p style="margin: 0 0 12px; font-size: 13px; font-weight: 600; color: rgba(0,0,0,.65)">
            Discovery scanning
          </p>
          <a-row :gutter="[16, 16]">
            <a-col :span="12">
              <a-form-item style="margin-bottom: 0">
                <template #label>
                  Full scan interval (ms)
                  <a-typography-text type="secondary" style="font-size: 12px; margin-left: 6px">
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
            <a-col :span="12">
              <a-form-item style="margin-bottom: 0">
                <template #label>
                  Light scan interval (ms)
                  <a-typography-text type="secondary" style="font-size: 12px; margin-left: 6px">
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

        <!-- ── Runtime ─────────────────────────────────────────────────────── -->
        <a-card style="margin-bottom: 16px">
          <template #title>
            <ThunderboltOutlined style="margin-right: 8px" />
            Runtime &amp; Memory
          </template>
          <a-row :gutter="[16, 16]">
            <a-col :span="12">
              <a-form-item label="Memory threshold (MB)" style="margin-bottom: 0">
                <a-input-number
                  :value="settings.runtime?.memory?.thresholdMb ?? 30"
                  :min="10"
                  style="width: 100%"
                  @change="(v: number) => setMemory('thresholdMb', v)"
                />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item style="margin-bottom: 0">
                <template #label>
                  Check interval (ms)
                  <a-typography-text type="secondary" style="font-size: 12px; margin-left: 6px">
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

        <!-- Bottom save bar -->
        <div style="display: flex; justify-content: flex-end; gap: 8px; padding-top: 8px">
          <a-button :disabled="saving" @click="discard">Discard</a-button>
          <a-button type="primary" :loading="saving" @click="save">
            <template #icon><SaveOutlined /></template>
            Save changes
          </a-button>
        </div>
      </a-spin>
    </div>
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
</style>
