<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import SparklineChart from '@/components/SparklineChart.vue'
import { dashboardApi, type DashboardStats, type NetworkBandwidth } from '@/api/dashboard'

const netColumns: TableColumnType<NetworkBandwidth>[] = [
  { title: 'Interface', dataIndex: 'iface', key: 'iface', width: 120 },
  { title: 'In (current)', key: 'rx_sec', width: 130 },
  { title: 'Out (current)', key: 'tx_sec', width: 130 },
  { title: 'Total In', key: 'rx_bytes', width: 110 },
  { title: 'Total Out', key: 'tx_bytes', width: 110 },
]

const HISTORY = 60   // number of samples kept (~3 min at 3s interval)
const POLL_MS = 3000

const stats = ref<DashboardStats | null>(null)
const loading = ref(true)
const error = ref(false)

// Rolling history buffers
const cpuHistory    = ref<number[]>([])
const memHistory    = ref<number[]>([])
const rxHistory     = ref<number[]>([])
const txHistory     = ref<number[]>([])

function push(buf: number[], val: number) {
  buf.push(val)
  if (buf.length > HISTORY) buf.shift()
}

// Pick the busiest non-loopback interface
function primaryNet(network: NetworkBandwidth[]): NetworkBandwidth | null {
  const candidates = network.filter((n) => !n.iface.startsWith('lo'))
  if (!candidates.length) return null
  return candidates.reduce((a, b) => (a.rx_sec + a.tx_sec >= b.rx_sec + b.tx_sec ? a : b))
}

async function poll() {
  try {
    const data = await dashboardApi.getStats()
    stats.value = data
    error.value = false
    loading.value = false

    push(cpuHistory.value, data.cpu_usage)
    push(memHistory.value, data.memory_percent)

    const net = primaryNet(data.network)
    push(rxHistory.value, net ? net.rx_sec / 1024 : 0)   // KB/s
    push(txHistory.value, net ? net.tx_sec / 1024 : 0)
  } catch {
    error.value = true
    loading.value = false
  }
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => { poll(); timer = setInterval(poll, POLL_MS) })
onUnmounted(() => { if (timer) clearInterval(timer) })

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const parts = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m || !parts.length) parts.push(`${m}m`)
  return parts.join(' ')
}

function fmtBytes(kb: number): string {
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB/s`
  return `${kb.toFixed(1)} KB/s`
}

function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb.toFixed(0)} MB`
}

// Format raw bytes into a human-readable size string
function fmtBytesTotal(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024)      return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function cpuColor(v: number) { return v >= 90 ? '#cf1322' : v >= 70 ? '#fa8c16' : '#52c41a' }
function memColor(v: number) { return v >= 90 ? '#cf1322' : v >= 75 ? '#fa8c16' : '#1677ff' }

const rxCurrent  = computed(() => rxHistory.value[rxHistory.value.length - 1] ?? 0)
const txCurrent  = computed(() => txHistory.value[txHistory.value.length - 1] ?? 0)
const netIface   = computed(() => stats.value ? (primaryNet(stats.value.network)?.iface ?? '—') : '—')
</script>

<template>
  <AppLayout title="Dashboard">
    <a-spin :spinning="loading">

      <a-alert v-if="error" type="warning" message="Could not reach agent — retrying…" show-icon style="margin-bottom:16px" />

      <template v-if="stats">

        <!-- ── Row 1: Network ──────────────────────────────────────────────── -->
        <div class="section-label">Network · {{ netIface }}</div>
        <a-row :gutter="16" style="margin-bottom:16px">

          <a-col :xs="24" :sm="12" :lg="6">
            <div class="widget">
              <div class="widget-title">Bandwidth In</div>
              <div class="widget-value" style="color:#1677ff">{{ fmtBytes(rxCurrent) }}</div>
              <SparklineChart :data="rxHistory" color="#1677ff" fill-color="rgba(22,119,255,0.12)" />
              <div class="widget-sub">last {{ rxHistory.length * 3 }}s</div>
            </div>
          </a-col>

          <a-col :xs="24" :sm="12" :lg="6">
            <div class="widget">
              <div class="widget-title">Bandwidth Out</div>
              <div class="widget-value" style="color:#722ed1">{{ fmtBytes(txCurrent) }}</div>
              <SparklineChart :data="txHistory" color="#722ed1" fill-color="rgba(114,46,209,0.1)" />
              <div class="widget-sub">last {{ txHistory.length * 3 }}s</div>
            </div>
          </a-col>

          <a-col :xs="24" :sm="12" :lg="6">
            <div class="widget">
              <div class="widget-title">Total Received</div>
              <div class="widget-value">
                {{ stats.network.length ? fmtBytesTotal(primaryNet(stats.network)?.rx_bytes ?? 0) : '—' }}
              </div>
              <div class="widget-sub">since last restart</div>
            </div>
          </a-col>

          <a-col :xs="24" :sm="12" :lg="6">
            <div class="widget">
              <div class="widget-title">Total Sent</div>
              <div class="widget-value">
                {{ stats.network.length ? fmtBytesTotal(primaryNet(stats.network)?.tx_bytes ?? 0) : '—' }}
              </div>
              <div class="widget-sub">since last restart</div>
            </div>
          </a-col>

        </a-row>

        <!-- ── Row 2: Performance charts ─────────────────────────────────── -->
        <div class="section-label">Performance History · last {{ cpuHistory.length * 3 }}s</div>
        <a-row :gutter="16" style="margin-bottom:16px">

          <a-col :xs="24" :lg="12">
            <div class="widget chart-widget">
              <div class="chart-header">
                <span class="widget-title">CPU Usage</span>
                <span class="chart-current" :style="{ color: cpuColor(stats.cpu_usage) }">{{ stats.cpu_usage }}%</span>
              </div>
              <div class="chart-body">
                <SparklineChart
                  :data="cpuHistory"
                  :color="cpuColor(stats.cpu_usage)"
                  :fill-color="`${cpuColor(stats.cpu_usage)}22`"
                  :max-value="100"
                  :height="90"
                  full-width
                />
              </div>
              <a-progress
                :percent="stats.cpu_usage"
                :stroke-color="cpuColor(stats.cpu_usage)"
                :show-info="false"
                size="small"
                style="margin-top:8px"
              />
            </div>
          </a-col>

          <a-col :xs="24" :lg="12">
            <div class="widget chart-widget">
              <div class="chart-header">
                <span class="widget-title">Memory Usage</span>
                <span class="chart-current" :style="{ color: memColor(stats.memory_percent) }">
                  {{ stats.memory_percent }}%
                  <span class="chart-sub">{{ fmtMb(stats.memory_used) }} / {{ fmtMb(stats.memory_total) }}</span>
                </span>
              </div>
              <div class="chart-body">
                <SparklineChart
                  :data="memHistory"
                  :color="memColor(stats.memory_percent)"
                  :fill-color="`${memColor(stats.memory_percent)}22`"
                  :max-value="100"
                  :height="90"
                  full-width
                />
              </div>
              <a-progress
                :percent="stats.memory_percent"
                :stroke-color="memColor(stats.memory_percent)"
                :show-info="false"
                size="small"
                style="margin-top:8px"
              />
            </div>
          </a-col>

        </a-row>

        <!-- ── Row 3: System ───────────────────────────────────────────────── -->
        <div class="section-label">System · {{ stats.hostname }}</div>
        <a-row :gutter="16" style="margin-bottom:16px">

          <a-col :xs="24" :sm="12" :lg="6">
            <div class="widget">
              <div class="widget-title">CPU Usage</div>
              <div class="widget-value" :style="{ color: cpuColor(stats.cpu_usage) }">
                {{ stats.cpu_usage }}%
              </div>
              <SparklineChart
                :data="cpuHistory"
                :color="cpuColor(stats.cpu_usage)"
                :fill-color="`${cpuColor(stats.cpu_usage)}22`"
              />
              <a-progress
                :percent="stats.cpu_usage"
                :stroke-color="cpuColor(stats.cpu_usage)"
                :show-info="false"
                size="small"
                style="margin-top:6px"
              />
            </div>
          </a-col>

          <a-col :xs="24" :sm="12" :lg="6">
            <div class="widget">
              <div class="widget-title">Memory</div>
              <div class="widget-value" :style="{ color: memColor(stats.memory_percent) }">
                {{ stats.memory_percent }}%
              </div>
              <SparklineChart
                :data="memHistory"
                :color="memColor(stats.memory_percent)"
                :fill-color="`${memColor(stats.memory_percent)}22`"
              />
              <div class="widget-sub">{{ fmtMb(stats.memory_used) }} / {{ fmtMb(stats.memory_total) }}</div>
            </div>
          </a-col>

          <a-col :xs="24" :sm="12" :lg="6">
            <div class="widget">
              <div class="widget-title">Storage</div>
              <template v-if="stats.storage_percent != null">
                <div class="widget-value">{{ stats.storage_percent }}%</div>
                <a-progress
                  :percent="stats.storage_percent"
                  :stroke-color="stats.storage_percent >= 90 ? '#cf1322' : '#52c41a'"
                  :show-info="false"
                  size="small"
                  style="margin-top:16px"
                />
                <div class="widget-sub">
                  {{ fmtMb(stats.storage_used!) }} / {{ fmtMb(stats.storage_total!) }}
                </div>
              </template>
              <div v-else class="widget-value" style="color:#aaa">—</div>
            </div>
          </a-col>

          <a-col :xs="24" :sm="12" :lg="6">
            <div class="widget">
              <div class="widget-title">Uptime</div>
              <div class="widget-value" style="font-size:22px">{{ fmtUptime(stats.uptime) }}</div>
              <div class="widget-sub" style="margin-top:8px">{{ stats.hostname }}</div>
            </div>
          </a-col>

        </a-row>

        <!-- ── Row 3: Interfaces table ─────────────────────────────────────── -->
        <div class="section-label">Network Interfaces</div>
        <a-table
          :data-source="stats.network.filter(n => !n.iface.startsWith('lo'))"
          :columns="netColumns"
          :pagination="false"
          row-key="iface"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'rx_sec'">
              <span style="color:#1677ff">{{ fmtBytes(record.rx_sec / 1024) }}</span>
            </template>
            <template v-else-if="column.key === 'tx_sec'">
              <span style="color:#722ed1">{{ fmtBytes(record.tx_sec / 1024) }}</span>
            </template>
            <template v-else-if="column.key === 'rx_bytes'">
              <span style="color:#888; font-size:12px">{{ fmtBytesTotal(record.rx_bytes) }}</span>
            </template>
            <template v-else-if="column.key === 'tx_bytes'">
              <span style="color:#888; font-size:12px">{{ fmtBytesTotal(record.tx_bytes) }}</span>
            </template>
          </template>
        </a-table>

      </template>
    </a-spin>
  </AppLayout>
</template>


<style scoped>
.section-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #aaa;
  margin-bottom: 10px;
}

.widget {
  background: #fafafa;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  padding: 16px 18px 12px;
  height: 100%;
}

.widget-title {
  font-size: 12px;
  color: #888;
  margin-bottom: 6px;
  font-weight: 500;
}

.widget-value {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.1;
  margin-bottom: 10px;
  font-variant-numeric: tabular-nums;
}

.widget-sub {
  font-size: 11px;
  color: #aaa;
  margin-top: 6px;
}

.chart-widget {
  padding-bottom: 14px;
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 10px;
}

.chart-current {
  font-size: 22px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.chart-sub {
  font-size: 11px;
  color: #aaa;
  font-weight: 400;
  margin-left: 6px;
}

.chart-body {
  line-height: 0;
}
</style>
