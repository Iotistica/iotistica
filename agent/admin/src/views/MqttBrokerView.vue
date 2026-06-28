<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import TopicTree from '@/components/mqtt/TopicTree.vue'
import MessageViewer from '@/components/mqtt/MessageViewer.vue'
import { useProStatus } from '@/composables/useProStatus'
import { mqttApi, type TopicNode, type BrokerMetrics } from '@/api/mqtt'
import { WifiOutlined, GlobalOutlined } from '@ant-design/icons-vue'

const { proInstalled } = useProStatus()

const metrics    = ref<BrokerMetrics | null>(null)
const topicTree  = ref<Record<string, TopicNode>>({})
const selected   = ref<TopicNode | null>(null)
const connected  = ref(false)
const loading    = ref(true)
const filterText = ref('')

const POLL_MS = 5000

let timer: ReturnType<typeof setInterval> | null = null

async function poll() {
  try {
    const [m, tree] = await Promise.all([
      mqttApi.getMetrics(),
      mqttApi.getTopicTree(),
    ])
    metrics.value   = m
    topicTree.value = tree
    connected.value = m.connected
    loading.value   = false

    // Refresh selected node data from updated tree
    if (selected.value) {
      selected.value = findNode(tree, selected.value.fullTopic) ?? selected.value
    }
  } catch {
    loading.value = false
  }
}

function findNode(nodes: Record<string, TopicNode>, fullTopic: string): TopicNode | null {
  for (const node of Object.values(nodes)) {
    if (node.fullTopic === fullTopic) return node
    const found = findNode(node.children, fullTopic)
    if (found) return found
  }
  return null
}

const filteredTree = computed(() => {
  const q = filterText.value.trim().toLowerCase()
  if (!q) return topicTree.value
  return filterTree(topicTree.value, q)
})

function filterTree(nodes: Record<string, TopicNode>, q: string): Record<string, TopicNode> {
  const result: Record<string, TopicNode> = {}
  for (const [key, node] of Object.entries(nodes)) {
    if (node.fullTopic.toLowerCase().includes(q)) {
      result[key] = node
    } else {
      const filteredChildren = filterTree(node.children, q)
      if (Object.keys(filteredChildren).length) {
        result[key] = { ...node, children: filteredChildren }
      }
    }
  }
  return result
}

function fmtKB(kb: number) {
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB/s`
  return `${kb.toFixed(1)} KB/s`
}


function countTopics(tree: Record<string, TopicNode>, count = 0): number {
  for (const node of Object.values(tree)) {
    if (node.count > 0) count++
    count = countTopics(node.children, count)
  }
  return count
}

onMounted(() => {
  if (proInstalled.value) {
    poll()
    timer = setInterval(poll, POLL_MS)
  }
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <AppLayout title="MQTT Broker">

    <!-- Pro gate -->
    <a-alert v-if="!proInstalled" type="info" show-icon style="margin-bottom: 16px">
      <template #message>Live broker monitoring requires Agent Pro</template>
      <template #description>
        <div style="margin-top: 4px">
          <strong>Iotistica Agent Pro</strong> includes a live MQTT broker monitor — browse the full topic tree,
          inspect message payloads, and track throughput and client metrics in real time.
        </div>
        <div style="margin-top: 12px">
          <a-button type="primary" size="small" href="https://iotistica.com/solutions.html" target="_blank" rel="noopener">
            Upgrade to Agent Pro →
          </a-button>
          <a href="https://iotistica.com/solutions.html" target="_blank" rel="noopener" style="margin-left:16px;font-size:12px">
            Compare plans
          </a>
        </div>
      </template>
    </a-alert>

    <template v-if="proInstalled">

      <!-- Connection banner -->
      <a-alert
        v-if="!loading && !connected"
        type="warning"
        message="Not connected to local MQTT broker — retrying…"
        show-icon
        style="margin-bottom: 16px"
      />

      <!-- Metric cards -->
      <a-row :gutter="16" style="margin-bottom: 16px">

        <a-col :xs="12" :sm="6">
          <div class="metric-card">
            <div class="metric-label">Clients</div>
            <div class="metric-value" :style="{ color: connected ? '#52c41a' : '#999' }">
              {{ metrics?.clients.connected ?? '—' }}
            </div>
            <div class="metric-sub">of {{ metrics?.clients.total ?? '—' }} total</div>
          </div>
        </a-col>

        <a-col :xs="12" :sm="6">
          <div class="metric-card">
            <div class="metric-label">Topics</div>
            <div class="metric-value">{{ metrics ? Object.keys(topicTree).length > 0 ? countTopics(topicTree) : '0' : '—' }}</div>
            <div class="metric-sub">{{ metrics?.subscriptions ?? '—' }} subscriptions</div>
          </div>
        </a-col>

        <a-col :xs="12" :sm="6">
          <div class="metric-card">
            <div class="metric-label">Msg rate in</div>
            <div class="metric-value" style="color:#1677ff">
              {{ metrics ? `${metrics.messageRateIn}/s` : '—' }}
            </div>
            <div class="metric-sub">{{ metrics ? fmtKB(metrics.throughputIn) : '—' }}</div>
          </div>
        </a-col>

        <a-col :xs="12" :sm="6">
          <div class="metric-card">
            <div class="metric-label">Msg rate out</div>
            <div class="metric-value" style="color:#722ed1">
              {{ metrics ? `${metrics.messageRateOut}/s` : '—' }}
            </div>
            <div class="metric-sub">{{ metrics ? fmtKB(metrics.throughputOut) : '—' }}</div>
          </div>
        </a-col>

      </a-row>

      <!-- Main split panel -->
      <div class="split-panel">

        <!-- Left: topic tree -->
        <div class="tree-pane">
          <div class="pane-header">
            <span class="pane-title">
              <WifiOutlined style="margin-right:6px" />
              Topics
            </span>
            <span class="pane-count">{{ countTopics(topicTree) }}</span>
          </div>
          <div class="tree-filter">
            <a-input
              v-model:value="filterText"
              placeholder="Filter topics…"
              allow-clear
              size="small"
            />
          </div>
          <div class="tree-scroll">
            <a-spin :spinning="loading" size="small">
              <div v-if="!loading && Object.keys(filteredTree).length === 0" class="tree-empty">
                No topics yet — messages will appear as the broker receives them
              </div>
              <TopicTree
                v-else
                :nodes="filteredTree"
                :selected-topic="selected?.fullTopic ?? null"
                @select="selected = $event"
              />
            </a-spin>
          </div>
        </div>

        <!-- Right: message viewer -->
        <div class="viewer-pane">
          <div class="pane-header">
            <span class="pane-title">
              <GlobalOutlined style="margin-right:6px" />
              Message
            </span>
            <span v-if="metrics?.version" class="broker-version">{{ metrics.version }}</span>
          </div>
          <div class="viewer-scroll">
            <MessageViewer :node="selected" />
          </div>
        </div>

      </div>

    </template>
  </AppLayout>
</template>

<style scoped>
.metric-card {
  background: #fafafa;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  padding: 14px 16px;
}

.metric-label {
  font-size: 11px;
  color: #aaa;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 4px;
}

.metric-value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.metric-sub {
  font-size: 11px;
  color: #bbb;
  margin-top: 2px;
}

.split-panel {
  display: flex;
  gap: 0;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  overflow: hidden;
  height: calc(100vh - 52px - 48px - 140px - 32px);
  min-height: 400px;
}

.tree-pane {
  width: 280px;
  flex-shrink: 0;
  border-right: 1px solid #f0f0f0;
  display: flex;
  flex-direction: column;
  background: #fafafa;
}

.viewer-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #f0f0f0;
  background: #fff;
  flex-shrink: 0;
}

.pane-title {
  font-size: 12px;
  font-weight: 600;
  color: #555;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.pane-count {
  font-size: 11px;
  color: #aaa;
  background: #f0f0f0;
  border-radius: 8px;
  padding: 1px 7px;
}

.broker-version {
  font-size: 10px;
  color: #bbb;
  font-family: monospace;
}

.tree-filter {
  padding: 8px 10px;
  border-bottom: 1px solid #f0f0f0;
  flex-shrink: 0;
}

.tree-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}

.tree-empty {
  padding: 24px 14px;
  font-size: 12px;
  color: #bbb;
  text-align: center;
  line-height: 1.6;
}

.viewer-scroll {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
