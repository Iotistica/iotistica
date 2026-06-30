<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import AppLayout from '@/components/layout/AppLayout.vue'
import { DisconnectOutlined, ReloadOutlined, SearchOutlined, CaretRightOutlined } from '@ant-design/icons-vue'
import '@xterm/xterm/css/xterm.css'

// ── State ──────────────────────────────────────────────────────────────────────

type ConnState = 'connecting' | 'connected' | 'disconnected' | 'error'

const containerEl = ref<HTMLDivElement | null>(null)
const connState = ref<ConnState>('connecting')
const errorMsg = ref('')
const cmdSearch = ref('')

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let ws: WebSocket | null = null
let resizeObserver: ResizeObserver | null = null

// ── Command catalog ────────────────────────────────────────────────────────────

interface Cmd {
  cmd: string
  desc: string
  args?: string   // if set, show placeholder; row click types without Enter
}
interface CmdGroup {
  label: string
  commands: Cmd[]
}

const CLI_COMMANDS: CmdGroup[] = [
  {
    label: 'Agent',
    commands: [
      { cmd: 'iotctl status',      desc: 'Health & status overview' },
      { cmd: 'iotctl restart',     desc: 'Restart the agent process' },
      { cmd: 'iotctl update',      desc: 'Update to latest version', args: '[version]' },
      { cmd: 'iotctl diagnostics', desc: 'Run full diagnostics report' },
      { cmd: 'iotctl logs',        desc: 'Show recent agent logs', args: '[-f] [-n N]' },
      { cmd: 'iotctl version',     desc: 'Show CLI version' },
    ],
  },
  {
    label: 'Provisioning',
    commands: [
      { cmd: 'iotctl provision status', desc: 'Show provisioning status' },
      { cmd: 'iotctl provision',        desc: 'Provision with a key', args: '<key>' },
      { cmd: 'iotctl deprovision',      desc: 'Remove cloud registration' },
      { cmd: 'iotctl factory-reset',    desc: 'Full factory reset' },
    ],
  },
  {
    label: 'Config',
    commands: [
      { cmd: 'iotctl config show',    desc: 'Show all config values' },
      { cmd: 'iotctl config get',     desc: 'Get a config value', args: '<key>' },
      { cmd: 'iotctl config set',     desc: 'Set a config value', args: '<key> <value>' },
      { cmd: 'iotctl config set-api', desc: 'Set cloud API URL', args: '<url>' },
      { cmd: 'iotctl config get-api', desc: 'Show cloud API URL' },
      { cmd: 'iotctl config reset',   desc: 'Reset config to defaults' },
    ],
  },
  {
    label: 'Applications',
    commands: [
      { cmd: 'iotctl apps list',    desc: 'List all applications' },
      { cmd: 'iotctl apps start',   desc: 'Start an application', args: '<id>' },
      { cmd: 'iotctl apps stop',    desc: 'Stop an application', args: '<id>' },
      { cmd: 'iotctl apps restart', desc: 'Restart an application', args: '<id>' },
      { cmd: 'iotctl apps info',    desc: 'Application details', args: '<id>' },
      { cmd: 'iotctl apps purge',   desc: 'Remove app & volumes', args: '<id>' },
    ],
  },
  {
    label: 'Services',
    commands: [
      { cmd: 'iotctl services list',    desc: 'List all services' },
      { cmd: 'iotctl services logs',    desc: 'Stream service logs', args: '<id> [-f]' },
      { cmd: 'iotctl services start',   desc: 'Start a service', args: '<id>' },
      { cmd: 'iotctl services stop',    desc: 'Stop a service', args: '<id>' },
      { cmd: 'iotctl services restart', desc: 'Restart a service', args: '<id>' },
      { cmd: 'iotctl services info',    desc: 'Service details', args: '<id>' },
    ],
  },
  {
    label: 'Devices',
    commands: [
      { cmd: 'iotctl devices list',      desc: 'List configured adapters' },
      { cmd: 'iotctl discover',          desc: 'Auto-discover devices' },
      { cmd: 'iotctl devices enable',    desc: 'Enable an adapter', args: '<id>' },
      { cmd: 'iotctl devices disable',   desc: 'Disable an adapter', args: '<id>' },
      { cmd: 'iotctl devices add-mqtt',  desc: 'Add MQTT adapter' },
      { cmd: 'iotctl devices add-modbus',desc: 'Add Modbus adapter' },
      { cmd: 'iotctl devices add-opcua', desc: 'Add OPC-UA adapter' },
      { cmd: 'iotctl devices add-snmp',  desc: 'Add SNMP adapter' },
      { cmd: 'iotctl devices remove',    desc: 'Remove an adapter', args: '<id>' },
    ],
  },
  {
    label: 'Database',
    commands: [
      { cmd: 'iotctl db list',    desc: 'List backups' },
      { cmd: 'iotctl db backup',  desc: 'Create a backup' },
      { cmd: 'iotctl db stats',   desc: 'Database statistics' },
      { cmd: 'iotctl db verify',  desc: 'Verify database integrity' },
      { cmd: 'iotctl db restore', desc: 'Restore from backup', args: '<file>' },
      { cmd: 'iotctl db prune',   desc: 'Remove old backups', args: '[--keep N]' },
    ],
  },
  {
    label: 'System',
    commands: [
      { cmd: 'iotctl buffer status', desc: 'Offline buffer status' },
      { cmd: 'iotctl memory',        desc: 'Memory diagnostics' },
    ],
  },
]

const filteredGroups = computed<CmdGroup[]>(() => {
  const q = cmdSearch.value.trim().toLowerCase()
  if (!q) return CLI_COMMANDS
  return CLI_COMMANDS
    .map(g => ({ ...g, commands: g.commands.filter(c => c.cmd.includes(q) || c.desc.toLowerCase().includes(q)) }))
    .filter(g => g.commands.length > 0)
})

// ── Send command to PTY ────────────────────────────────────────────────────────

function sendToTerminal(text: string) {
  if (ws?.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'data', data: '\x15' })) // Ctrl+U clears current line
  ws.send(JSON.stringify({ type: 'data', data: text }))
}

function typeCommand(c: Cmd) {
  // Always type without Enter — user reviews, adds args if needed, then presses Enter
  sendToTerminal(c.cmd + (c.args ? ' ' : ''))
}

function runCommand(c: Cmd) {
  if (c.args) {
    // Has required args — just type so user can complete
    sendToTerminal(c.cmd + ' ')
  } else {
    // No args — execute immediately
    sendToTerminal(c.cmd + '\r')
  }
}

// ── WebSocket URL ──────────────────────────────────────────────────────────────

function shellUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string) || ''
  const host = apiBase ? new URL(apiBase, location.href).host : location.host
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
      background:    '#0d1117',
      foreground:    '#c9d1d9',
      cursor:        '#58a6ff',
      cursorAccent:  '#0d1117',
      black:         '#484f58',
      red:           '#ff7b72',
      green:         '#3fb950',
      yellow:        '#d29922',
      blue:          '#58a6ff',
      magenta:       '#bc8cff',
      cyan:          '#39c5cf',
      white:         '#b1bac4',
      brightBlack:   '#6e7681',
      brightRed:     '#ffa198',
      brightGreen:   '#56d364',
      brightYellow:  '#e3b341',
      brightBlue:    '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan:    '#56d4dd',
      brightWhite:   '#f0f6fc',
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

function disconnect() { ws?.close() }

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
    <div class="toolbar">
      <a-badge
        :status="connState === 'connected' ? 'success' : connState === 'connecting' ? 'processing' : 'error'"
        :text="connState === 'connected' ? 'Connected' : connState === 'connecting' ? 'Connecting…' : 'Disconnected'"
        style="font-size: 13px"
      />
      <div style="flex: 1" />
      <a-button v-if="connState === 'connected'" size="small" danger @click="disconnect">
        <template #icon><DisconnectOutlined /></template>
        Disconnect
      </a-button>
      <a-button v-else size="small" type="primary" :loading="connState === 'connecting'" @click="reconnect">
        <template #icon><ReloadOutlined /></template>
        Reconnect
      </a-button>
    </div>

    <!-- Error banner -->
    <a-alert v-if="connState === 'error'" type="error" :message="errorMsg || 'Connection failed'"
      show-icon style="margin-bottom: 12px" />

    <!-- Split layout -->
    <div class="split">

      <!-- Terminal (2/3) -->
      <div class="term-wrapper">
        <div ref="containerEl" class="term-inner" />
      </div>

      <!-- Command panel (1/3) -->
      <div class="cmd-panel">
        <div class="cmd-panel-header">
          <span class="cmd-panel-title">iotctl Commands</span>
          <a-input
            v-model:value="cmdSearch"
            size="small"
            placeholder="Search…"
            allow-clear
            class="cmd-search"
          >
            <template #prefix><SearchOutlined style="color: #555" /></template>
          </a-input>
        </div>

        <div class="cmd-scroll">
          <template v-for="group in filteredGroups" :key="group.label">
            <div class="cmd-group-label">{{ group.label }}</div>
            <div
              v-for="c in group.commands"
              :key="c.cmd"
              class="cmd-row"
              :title="c.cmd + (c.args ? ' ' + c.args : '')"
              @click="typeCommand(c)"
            >
              <div class="cmd-info">
                <span class="cmd-text">{{ c.cmd.replace('iotctl ', '') }}</span>
                <span v-if="c.args" class="cmd-args">{{ c.args }}</span>
                <span class="cmd-desc">{{ c.desc }}</span>
              </div>
              <button
                class="cmd-run-btn"
                :title="c.args ? 'Type command (needs args)' : 'Run now'"
                @click.stop="runCommand(c)"
              >
                <CaretRightOutlined />
              </button>
            </div>
          </template>

          <div v-if="filteredGroups.length === 0" class="cmd-empty">
            No commands match "{{ cmdSearch }}"
          </div>
        </div>
      </div>

    </div>

  </AppLayout>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  flex-shrink: 0;
}

/* ── Split ── */
.split {
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

/* ── Terminal ── */
.term-wrapper {
  flex: 2;
  min-width: 0;
  border-radius: 8px;
  overflow: hidden;
  background: #0d1117;
  display: flex;
  flex-direction: column;
}

.term-inner {
  flex: 1;
  padding: 8px;
  min-height: 0;
}

:deep(.xterm) { height: 100%; }
:deep(.xterm-viewport) { border-radius: 6px; }

/* ── Command panel ── */
.cmd-panel {
  width: 280px;
  flex-shrink: 0;
  border-radius: 8px;
  background: #0d1117;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #21262d;
}

.cmd-panel-header {
  padding: 10px 12px 8px;
  border-bottom: 1px solid #21262d;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cmd-panel-title {
  font-size: 11px;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.cmd-search :deep(.ant-input) {
  background: #161b22;
  border-color: #30363d;
  color: #c9d1d9;
  font-size: 12px;
}

.cmd-search :deep(.ant-input::placeholder) { color: #484f58; }
.cmd-search :deep(.ant-input-affix-wrapper) {
  background: #161b22;
  border-color: #30363d;
}
.cmd-search :deep(.ant-input-affix-wrapper:focus-within) {
  border-color: #58a6ff;
  box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.15);
}

.cmd-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0 8px;
}

.cmd-scroll::-webkit-scrollbar { width: 4px; }
.cmd-scroll::-webkit-scrollbar-track { background: transparent; }
.cmd-scroll::-webkit-scrollbar-thumb { background: #30363d; border-radius: 2px; }

.cmd-group-label {
  padding: 10px 12px 4px;
  font-size: 10px;
  font-weight: 700;
  color: #484f58;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.cmd-row {
  display: flex;
  align-items: center;
  padding: 5px 8px 5px 12px;
  cursor: pointer;
  transition: background 0.1s;
  gap: 4px;
}

.cmd-row:hover {
  background: #161b22;
}

.cmd-row:hover .cmd-run-btn {
  opacity: 1;
}

.cmd-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.cmd-text {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11.5px;
  color: #79c0ff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cmd-args {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 10.5px;
  color: #d29922;
  margin-left: 4px;
}

.cmd-desc {
  font-size: 11px;
  color: #6e7681;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cmd-run-btn {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: #1f6feb;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.1s, background 0.1s;
  font-size: 10px;
  padding: 0;
}

.cmd-run-btn:hover {
  background: #388bfd;
}

.cmd-empty {
  padding: 20px 12px;
  font-size: 12px;
  color: #484f58;
  text-align: center;
}
</style>
