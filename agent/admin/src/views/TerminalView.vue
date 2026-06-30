<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import AppLayout from '@/components/layout/AppLayout.vue'
import { DisconnectOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import '@xterm/xterm/css/xterm.css'

// ── State ──────────────────────────────────────────────────────────────────────

type ConnState = 'connecting' | 'connected' | 'disconnected' | 'error'

const containerEl = ref<HTMLDivElement | null>(null)
const connState = ref<ConnState>('connecting')
const errorMsg = ref('')

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let ws: WebSocket | null = null
let resizeObserver: ResizeObserver | null = null

// ── WebSocket URL ──────────────────────────────────────────────────────────────

function shellUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string) || ''
  const host = apiBase
    ? new URL(apiBase, location.href).host
    : location.host
  return `${proto}://${host}/v1/shell`
}

// ── Terminal setup ─────────────────────────────────────────────────────────────

function initTerminal() {
  if (!containerEl.value) return

  term = new Terminal({
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, 'Courier New', monospace",
    fontSize: 13,
    lineHeight: 1.4,
    theme: {
      background:   '#0d1117',
      foreground:   '#c9d1d9',
      cursor:       '#58a6ff',
      cursorAccent: '#0d1117',
      black:        '#484f58',
      red:          '#ff7b72',
      green:        '#3fb950',
      yellow:       '#d29922',
      blue:         '#58a6ff',
      magenta:      '#bc8cff',
      cyan:         '#39c5cf',
      white:        '#b1bac4',
      brightBlack:  '#6e7681',
      brightRed:    '#ffa198',
      brightGreen:  '#56d364',
      brightYellow: '#e3b341',
      brightBlue:   '#79c0ff',
      brightMagenta:'#d2a8ff',
      brightCyan:   '#56d4dd',
      brightWhite:  '#f0f6fc',
    },
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
  })

  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(new WebLinksAddon())
  term.open(containerEl.value)
  fitAddon.fit()

  term.onData((data) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data }))
    }
  })

  resizeObserver = new ResizeObserver(() => {
    fitAddon?.fit()
    if (ws?.readyState === WebSocket.OPEN && term) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
  })
  resizeObserver.observe(containerEl.value)
}

// ── WebSocket ──────────────────────────────────────────────────────────────────

function connect() {
  connState.value = 'connecting'
  errorMsg.value = ''
  term?.reset()
  term?.write('\x1b[2m  Connecting…\x1b[0m\r\n')

  ws = new WebSocket(shellUrl())

  ws.onopen = () => {
    connState.value = 'connected'
    if (term && fitAddon) {
      fitAddon.fit()
      ws!.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    term?.reset()
  }

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data as string) as { type: string; data?: string; code?: number }
      if (msg.type === 'data' && msg.data) {
        term?.write(msg.data)
      } else if (msg.type === 'exit') {
        term?.write(`\r\n\x1b[2m  Process exited (${msg.code ?? 0})\x1b[0m\r\n`)
        connState.value = 'disconnected'
        ws?.close()
      }
    } catch { /* ignore */ }
  }

  ws.onclose = (ev) => {
    if (connState.value === 'connected') {
      connState.value = 'disconnected'
      term?.write('\r\n\x1b[2m  Connection closed\x1b[0m\r\n')
    }
    if (ev.code === 1006) {
      connState.value = 'error'
      errorMsg.value = 'Could not connect. Make sure you are logged in.'
    }
  }

  ws.onerror = () => {
    connState.value = 'error'
    errorMsg.value = 'WebSocket error — check browser console for details.'
  }
}

function disconnect() {
  ws?.close()
}

function reconnect() {
  ws?.close()
  nextTick(connect)
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  await nextTick()
  initTerminal()
  connect()
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  ws?.close()
  term?.dispose()
})
</script>

<template>
  <AppLayout title="Terminal" flex>

    <!-- Toolbar -->
    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px">
      <a-badge
        :status="connState === 'connected' ? 'success' : connState === 'connecting' ? 'processing' : 'error'"
        :text="connState === 'connected' ? 'Connected' : connState === 'connecting' ? 'Connecting…' : 'Disconnected'"
        style="font-size: 13px"
      />
      <div style="flex: 1" />
      <a-button
        v-if="connState === 'connected'"
        size="small"
        danger
        @click="disconnect"
      >
        <template #icon><DisconnectOutlined /></template>
        Disconnect
      </a-button>
      <a-button
        v-else
        size="small"
        type="primary"
        :loading="connState === 'connecting'"
        @click="reconnect"
      >
        <template #icon><ReloadOutlined /></template>
        Reconnect
      </a-button>
    </div>

    <!-- Error banner -->
    <a-alert
      v-if="connState === 'error'"
      type="error"
      :message="errorMsg || 'Connection failed'"
      show-icon
      style="margin-bottom: 12px"
    />

    <!-- Terminal container -->
    <div class="term-wrapper">
      <div ref="containerEl" class="term-inner" />
    </div>

  </AppLayout>
</template>

<style scoped>
.term-wrapper {
  border-radius: 8px;
  overflow: hidden;
  background: #0d1117;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.term-inner {
  flex: 1;
  padding: 8px;
  min-height: 0;
}

/* Let xterm fill the container */
:deep(.xterm) {
  height: 100%;
}

:deep(.xterm-viewport) {
  border-radius: 6px;
}
</style>
