<script setup lang="ts">
import { computed, ref } from 'vue'
import { CopyOutlined, CheckOutlined } from '@ant-design/icons-vue'
import type { TopicNode } from '@/api/mqtt'

const props = defineProps<{
  node: TopicNode | null
}>()

const copied = ref(false)

const prettyJson = computed(() => {
  if (!props.node?.lastMessage) return null
  if (props.node.messageType !== 'json') return null
  try {
    return JSON.stringify(JSON.parse(props.node.lastMessage), null, 2)
  } catch {
    return null
  }
})

const displayMessage = computed(() => {
  if (!props.node?.lastMessage) return ''
  return prettyJson.value ?? props.node.lastMessage
})

const typeColor = computed(() => {
  const t = props.node?.messageType
  if (t === 'json') return '#52c41a'
  if (t === 'binary') return '#722ed1'
  return '#1677ff'
})

function fmtBytes(b: number) {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${b} B`
}

function fmtTime(ts: number | null) {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

async function copy() {
  if (!displayMessage.value) return
  await navigator.clipboard.writeText(displayMessage.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

function highlightJson(json: string): string {
  return json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
      let cls = 'json-num'
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'json-key' : 'json-str'
      } else if (/true|false/.test(match)) {
        cls = 'json-bool'
      } else if (/null/.test(match)) {
        cls = 'json-null'
      }
      return `<span class="${cls}">${match}</span>`
    })
}
</script>

<template>
  <div v-if="!node" class="empty-state">
    <div class="empty-icon">◎</div>
    <div>Select a topic to view its last message</div>
  </div>

  <div v-else class="viewer">
    <!-- Header -->
    <div class="viewer-header">
      <div class="topic-path">{{ node.fullTopic }}</div>
      <div class="topic-meta">
        <a-tag :color="typeColor" style="font-size:11px">{{ node.messageType }}</a-tag>
        <span v-if="node.retain" class="meta-badge retain">RETAINED</span>
        <span class="meta-badge qos">QoS {{ node.qos }}</span>
      </div>
    </div>

    <!-- Stats row -->
    <div class="stats-row">
      <div class="stat">
        <div class="stat-label">Messages</div>
        <div class="stat-value">{{ node.count.toLocaleString() }}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Total bytes</div>
        <div class="stat-value">{{ fmtBytes(node.bytes) }}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Last received</div>
        <div class="stat-value">{{ fmtTime(node.lastMessageAt) }}</div>
      </div>
    </div>

    <!-- Message payload -->
    <div class="payload-label">
      Last message
      <button class="copy-btn" :class="{ copied }" @click="copy">
        <CheckOutlined v-if="copied" />
        <CopyOutlined v-else />
        {{ copied ? 'Copied' : 'Copy' }}
      </button>
    </div>

    <div class="payload-box">
      <div v-if="!node.lastMessage" class="payload-empty">No message received yet</div>

      <!-- JSON with syntax highlight -->
      <pre
        v-else-if="prettyJson"
        class="payload-code"
        v-html="highlightJson(prettyJson)"
      />

      <!-- Plain text / binary -->
      <pre v-else class="payload-code payload-code--plain">{{ displayMessage }}</pre>
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #bbb;
  font-size: 13px;
  gap: 10px;
}

.empty-icon {
  font-size: 32px;
  opacity: 0.3;
}

.viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.viewer-header {
  padding: 14px 16px 10px;
  border-bottom: 1px solid #f0f0f0;
}

.topic-path {
  font-family: 'SFMono-Regular', 'Consolas', monospace;
  font-size: 13px;
  font-weight: 600;
  word-break: break-all;
  margin-bottom: 8px;
}

.topic-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}

.meta-badge {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 3px;
}

.retain {
  background: rgba(250,140,22,0.12);
  color: #fa8c16;
}

.qos {
  background: #f0f0f0;
  color: #666;
}

.stats-row {
  display: flex;
  gap: 0;
  border-bottom: 1px solid #f0f0f0;
}

.stat {
  flex: 1;
  padding: 10px 16px;
  border-right: 1px solid #f0f0f0;
}

.stat:last-child {
  border-right: none;
}

.stat-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #aaa;
  margin-bottom: 2px;
}

.stat-value {
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.payload-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #aaa;
}

.copy-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: 1px solid #e8e8e8;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
  color: #666;
  transition: all 0.15s;
}

.copy-btn:hover { border-color: #1677ff; color: #1677ff; }
.copy-btn.copied { border-color: #52c41a; color: #52c41a; }

.payload-box {
  flex: 1;
  overflow: auto;
  background: #0d1117;
  margin: 0 16px 16px;
  border-radius: 6px;
}

.payload-empty {
  padding: 24px;
  color: #555;
  font-size: 12px;
  text-align: center;
}

.payload-code {
  margin: 0;
  padding: 14px 16px;
  font-family: 'SFMono-Regular', 'Consolas', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
  color: #e6edf3;
  white-space: pre-wrap;
  word-break: break-all;
}

.payload-code--plain {
  color: #adbac7;
}

:deep(.json-key)  { color: #79c0ff; }
:deep(.json-str)  { color: #a5d6ff; }
:deep(.json-num)  { color: #f2cc60; }
:deep(.json-bool) { color: #ff7b72; }
:deep(.json-null) { color: #ff7b72; }
</style>
