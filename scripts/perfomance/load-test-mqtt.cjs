#!/usr/bin/env node
/**
 * load-test-mqtt.cjs
 *
 * Native Node.js MQTT load test — replaces load-test-mqtt.ps1 +
 * mqtt-persistent-publisher.cjs.  All MQTT clients, message building, and
 * health polling run in one Node process with no IPC pipe overhead.
 *
 * setImmediate yields between publish chunks keep keepalive timers from being
 * starved, and offline clients are skipped rather than queued indefinitely.
 *
 * Usage (same flags as the .ps1):
 *   node load-test-mqtt.cjs [--Param value ...]
 *
 * Examples:
 *   node load-test-mqtt.cjs --MessageCount 500000 --AgentCount 50 --RatePerSecond 500 --MqttQoS 0 --MetricsPerMessage 50
 *   node load-test-mqtt.cjs --MessageCount 10000  --AgentCount 20 --RatePerSecond 200 --JwtToken "eyJ..."
 */
'use strict';

const path         = require('path');
const fs           = require('fs');
const { execFileSync } = require('child_process');
const zlib         = require('zlib');
const mqtt         = require(path.resolve(__dirname, '../../api/node_modules/mqtt'));

// ─── Defaults & arg parsing ───────────────────────────────────────────────────

const DEFAULTS = {
  MessageCount:        1000,
  AgentCount:          10,
  MetricsPerMessage:   5,
  RatePerSecond:       0,
  PollIntervalSec:     2,
  ApiUrl:              'http://localhost:4002',
  JwtToken:            '',
  MqttHost:            'localhost',
  MqttPort:            0,          // resolved from env / default below
  MqttClientIdPrefix:  '',
  MqttCleanSession:    true,
  MqttKeepAliveSec:    300,
  MqttReconnectPeriodMs: 5000,
  MqttConnectTimeoutMs:  30000,
  MqttUseTls:          false,
  MqttInsecureTls:     true,
  MqttQoS:             1,
  BatchSize:           12,
  BatchTimeMs:         60000,
  MqttUsername:        '',
  MqttPassword:        '',
  TenantId:            '',
  Username:            '',
  Password:            '',
  SyntheticAgents:     false,
  Cleanup:             true,
  CleanStream:         true,
  CompressPayload:     true,
};

function parseArgs() {
  const p    = { ...DEFAULTS };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('-')) continue;
    const key = args[i].replace(/^-+/, '');
    if (!(key in p)) continue;
    const next = args[i + 1];
    const val  = next !== undefined && !String(next).startsWith('-') ? args[++i] : 'true';
    const typ  = typeof DEFAULTS[key];
    if      (typ === 'number')  p[key] = Number(val);
    else if (typ === 'boolean') p[key] = val === 'true' || val === '1';
    else                        p[key] = val;
  }
  return p;
}

// ─── .env loader ──────────────────────────────────────────────────────────────

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}

// ─── ANSI colours ─────────────────────────────────────────────────────────────

const C = { reset: '\x1b[0m', cyan: '\x1b[36m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', gray: '\x1b[90m' };
const clr = (s, c) => `${c}${s}${C.reset}`;

// ─── base64url (mirrors api/src/mqtt/codec.ts) ────────────────────────────────

const b64url     = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeHex  = (h) => b64url(Buffer.from(h, 'hex'));
const encodeUuid = (u) => b64url(Buffer.from(u.replace(/-/g, ''), 'hex'));
const mqttTopic  = (t, a) => `i/${t}/a/${a}/endpoints/load-test`;

// ─── Docker helpers ───────────────────────────────────────────────────────────

function randomUuidV4() {
  const bytes = require('crypto').randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;   // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80;   // variant 1
  const h = bytes.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function dockerExec(container, ...cmd) {
  return execFileSync('docker', ['exec', container, ...cmd], { encoding: 'utf8' }).trim();
}

function getBrokerPublishCount(username, password) {
  try {
    const args = ['exec', 'iotistic-mosquitto', 'mosquitto_sub',
      '-h', 'localhost', '-p', '1883',
      '-t', '$SYS/broker/messages/received', '-C', '1', '-W', '12'];
    if (username) args.push('-u', username);
    if (password) args.push('-P', password);
    const out = execFileSync('docker', args, { encoding: 'utf8', timeout: 15000 }).trim();
    const val = parseInt(out, 10);
    return isNaN(val) ? null : val;
  } catch { return null; }
}

function getTenantIdFromRedis() {
  const pass = process.env.REDIS_PASSWORD || '';
  const out  = dockerExec('iotistic-redis', 'redis-cli', '--no-auth-warning', '-a', pass,
    'KEYS', '*:agent:devices:ingestion');
  if (!out || out === '(empty array)') throw new Error('No ingestion stream key found in Redis.');
  const key = out.split('\n')[0].trim();
  const m   = key.match(/tenant:\{([0-9a-f]+)\}/);
  if (!m) throw new Error(`Could not parse tenant ID from key: ${key}`);
  return m[1];
}

// ─── Spool file cleanup ───────────────────────────────────────────────────────

function cleanSpoolFiles() {
  try {
    const out = dockerExec('iotistic-api', 'sh', '-c',
      'find /var/lib/iotistic/spool -type f 2>/dev/null | wc -l').trim();
    const count = parseInt(out, 10) || 0;
    if (count === 0) return { deleted: 0 };
    dockerExec('iotistic-api', 'sh', '-c',
      'rm -f /var/lib/iotistic/spool/* 2>/dev/null; true');
    return { deleted: count };
  } catch (err) {
    console.warn(clr(`  Spool cleanup failed: ${err.message}`, C.yellow));
    return null;
  }
}

function cleanIngestionSpoolFiles() {
  try {
    const out = dockerExec('iotistic-ingestion', 'sh', '-c',
      'find /var/lib/iotistic/ingestion-db-spool -type f 2>/dev/null | wc -l').trim();
    const count = parseInt(out, 10) || 0;
    if (count === 0) return { deleted: 0 };
    dockerExec('iotistic-ingestion', 'sh', '-c',
      'rm -f /var/lib/iotistic/ingestion-db-spool/* 2>/dev/null; true');
    return { deleted: count };
  } catch (err) {
    console.warn(clr(`  Ingestion spool cleanup failed: ${err.message}`, C.yellow));
    return null;
  }
}

// ─── Redis stream cleanup ────────────────────────────────────────────────────

function cleanRedisStream(tenantId) {
  const pass     = process.env.REDIS_PASSWORD || '';
  const streamKey = `tenant:{${tenantId}}:agent:devices:ingestion`;
  try {
    const existsOut = dockerExec('iotistic-redis', 'redis-cli', '--no-auth-warning', '-a', pass,
      'EXISTS', streamKey);
    if (parseInt(existsOut, 10) === 0) return { cleared: 0, pending: 0 };

    const lenOut = dockerExec('iotistic-redis', 'redis-cli', '--no-auth-warning', '-a', pass,
      'XLEN', streamKey);
    const cleared = parseInt(lenOut, 10) || 0;

    // Count PEL across all consumer groups
    let totalPending = 0;
    try {
      const infoOut = dockerExec('iotistic-redis', 'redis-cli', '--no-auth-warning', '-a', pass,
        'XINFO', 'GROUPS', streamKey);
      for (const m of (infoOut.match(/pending\s+(\d+)/g) || [])) {
        totalPending += parseInt(m.match(/\d+/)[0], 10);
      }
    } catch { /* ignore */ }

    // DEL removes the stream and all consumer groups; ingestion recreates on next XREADGROUP.
    dockerExec('iotistic-redis', 'redis-cli', '--no-auth-warning', '-a', pass,
      'DEL', streamKey);

    return { cleared, pending: totalPending };
  } catch (err) {
    console.warn(clr(`  Stream cleanup failed: ${err.message}`, C.yellow));
    return null;
  }
}

function getAgentUuidsFromDb(limit) {
  try {
    const out = dockerExec('iotistic-postgres',
      'psql', '-U', 'postgres', '-d', 'iotistica', '-t', '-c',
      `SELECT uuid FROM agents ORDER BY random() LIMIT ${limit};`);
    return out.split('\n').map(l => l.trim()).filter(l => /^[0-9a-f-]{36}$/.test(l));
  } catch { return []; }
}

// ─── Ingestion health snapshot ────────────────────────────────────────────────

const METRIC_FIELDS = [
  ['streamLength',      'iotistic_ingestion_stream_length'],
  ['workerLag',         'iotistic_ingestion_worker_lag'],
  ['pendingMessages',   'iotistic_ingestion_pending_count'],
  ['dlqLength',         'iotistic_ingestion_dlq_length'],
  ['workerCount',       'iotistic_ingestion_worker_count'],
  ['dwellP95Ms',        'iotistic_ingestion_dwell_latency_p95_ms'],
  ['batchLatP95Ms',     'iotistic_ingestion_batch_latency_p95_ms'],
  ['messagesProcessed', 'iotistic_ingestion_messages_processed_total'],
  ['readingsInserted',  'iotistic_ingestion_readings_inserted_total'],
  ['messagesDropped',   'iotistic_ingestion_messages_dropped_total'],
  ['insertLatP95Ms',    'iotistic_ingestion_insert_latency_p95_ms'],
  ['dbPoolPct',         'iotistic_ingestion_db_pool_saturation_pct'],
  ['processingLatP95Ms','iotistic_ingestion_processing_latency_p95_ms'],
];

function parseGauge(text, name) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}(?:\\{[^}]*\\})?\\s+([\\-+0-9.eE]+)\\s*$`, 'm');
  const m  = text.match(re);
  return m ? parseFloat(m[1]) : null;
}

// Run fetch from inside the ingestion container (port 3003 is not exposed to host).
const FETCH_SCRIPT =
  "fetch('http://127.0.0.1:3003/metrics')" +
  ".then(r=>r.ok?r.text():Promise.reject(r.status))" +
  ".then(t=>process.stdout.write(t))" +
  ".catch(e=>{process.stderr.write(String(e));process.exit(1);});";

function getIngestionSnapshot() {
  try {
    const text = dockerExec('iotistic-ingestion', 'node', '-e', FETCH_SCRIPT);
    const snap = {};
    for (const [field, metric] of METRIC_FIELDS) snap[field] = parseGauge(text, metric);
    return snap;
  } catch { return null; }
}

// ─── Console output ───────────────────────────────────────────────────────────

const lpad = (v, n) => String(v).padStart(n);
const rpad = (v, n) => String(v).padEnd(n);
const now  = ()     => new Date().toTimeString().slice(0, 8);

function printHealthRow(h, base, injected, total, mpm, elapsed) {
  if (!h) { console.log(clr('  [health poll failed]', C.gray)); return; }
  const rate  = elapsed > 0 ? (injected / elapsed).toFixed(1) : '0';
  const lag   = h.workerLag ?? '?';
  const proc  = base ? (h.messagesProcessed ?? 0) - (base.messagesProcessed ?? 0) : (h.messagesProcessed ?? '?');
  const ins   = base ? (h.readingsInserted  ?? 0) - (base.readingsInserted  ?? 0) : (h.readingsInserted  ?? '?');
  const drop  = base ? (h.messagesDropped   ?? 0) - (base.messagesDropped   ?? 0) : (h.messagesDropped   ?? '?');
  // Subtract the baseline stream+PEL so leftover entries from a prior run don't
  // artificially reduce the apparent loss for the current test.
  const baseInflight = base ? (Number(base.streamLength) || 0) + (Number(base.pendingMessages) || 0) : 0;
  const inflight = Math.max(0, (Number(h.streamLength) || 0) + (Number(h.pendingMessages) || 0) - baseInflight);
  const untracked  = typeof proc === 'number' && injected > 0 ? Math.max(0, injected - proc - inflight) : 0;
  const untrackedPct = injected > 0 ? ((untracked / injected) * 100).toFixed(1) : '0.0';
  const lagC  = Number(lag)  > 20000 ? C.red : Number(lag)  > 5000 ? C.yellow : C.cyan;
  const dropC = Number(drop) > 0     ? C.red : C.green;
  const untrackedC = untracked > 0 ? C.yellow : C.green;
  process.stdout.write(
    `${now()} | msg=${lpad(injected,5)}/${rpad(total,5)} rd=${lpad(injected*mpm,6)}/${rpad(total*mpm,6)} | ` +
    `rate=${lpad(rate,7)}/s | stream=${lpad(h.streamLength??'?',5)} lag=` +
    clr(lpad(lag,6), lagC) +
    `  pending=${lpad(h.pendingMessages??'?',5)} workers=${lpad(h.workerCount??'?',2)} ` +
    `procΔ=${lpad(proc,7)} insΔ=${lpad(ins,7)} dropΔ=` +
    clr(lpad(drop,4), dropC) +
    ` untracked=` + clr(`${lpad(untrackedPct,5)}%`, untrackedC) +
    `  dwellP95=${h.dwellP95Ms??'?'}ms insertP95=${h.insertLatP95Ms??'?'}ms pool=${h.dbPoolPct??'?'}%\n`
  );
}

// ─── Message building ─────────────────────────────────────────────────────────

function buildPayload(agentUuid, agentName, metricCount, baseTs, seq) {
  const t = new Date(baseTs.getTime() + seq).toISOString();
  const readings = new Array(metricCount);
  for (let r = 0; r < metricCount; r++) {
    readings[r] = `{"metric":"metric-${r + 1}","value":${(Math.random() * 100).toFixed(4)},"unit":"unit","quality":"good","timestamp":"${t}","protocol":"mqtt"}`;
  }
  return `{"protocol":"mqtt","deviceUuid":"${agentUuid}","deviceName":"${agentName}","timestamp":"${t}","readings":[${readings.join(',')}]}`;
}

// ─── MQTT helpers ─────────────────────────────────────────────────────────────

function connectAgent(brokerUrl, opts) {
  return new Promise((resolve, reject) => {
    const client  = mqtt.connect(brokerUrl, opts);
    let settled   = false;
    const timer   = setTimeout(() => {
      if (settled) return; settled = true;
      client.end(true);
      reject(new Error(`Connect timeout for ${opts.clientId}`));
    }, (opts.connectTimeout ?? 30000) + 1000);

    client.once('connect', () => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      // Demote lifecycle noise to stderr so it doesn't pollute stdout parsing.
      client.on('error',   err => process.stderr.write(`[warn] MQTT error ${opts.clientId}: ${err.message}\n`));
      client.on('offline', ()  => process.stderr.write(`[warn] MQTT offline: ${opts.clientId}\n`));
      resolve(client);
    });
    client.once('error', err => {
      if (settled) return; settled = true;
      clearTimeout(timer); client.end(true); reject(err);
    });
  });
}

// Skip offline clients rather than queuing publish requests indefinitely.
function publishOne(client, topic, payload, qos) {
  return new Promise(resolve => {
    if (!client.connected) { resolve(); return; }
    client.publish(topic, payload, { qos }, () => resolve());
  });
}

// Yield the event loop so MQTT keepalive timers can fire between chunk bursts.
const yieldLoop = () => new Promise(r => setImmediate(r));

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const p = parseArgs();
  loadEnv(path.resolve(__dirname, '..', '..', '.env'));
  if (!process.env.REDIS_PASSWORD) process.env.REDIS_PASSWORD = '';

  // Resolve env-sourced defaults
  if (!p.MqttPort)     p.MqttPort     = parseInt(process.env.MOSQUITTO_PORT_EXT  || '5883');
  if (!p.MqttUsername) p.MqttUsername = process.env.MQTT_USERNAME                || 'admin';
  if (!p.MqttPassword) p.MqttPassword = process.env.MQTT_PASSWORD                || 'iotistic42!';
  if (!p.Username)     p.Username     = process.env.LOAD_TEST_USERNAME            || 'admin';
  if (!p.Password)     p.Password     = process.env.LOAD_TEST_PASSWORD            || 'admin123';

  // ── Tenant ID ──────────────────────────────────────────────────────────────
  let tenantId = p.TenantId;
  if (!tenantId) {
    process.stdout.write('Discovering tenant ID from Redis...');
    tenantId = getTenantIdFromRedis();
    console.log(` ${tenantId}`);
  } else {
    console.log(clr(`Using tenant ID: ${tenantId}`, C.green));
  }
  const encTenant = encodeHex(tenantId);

  // ── Pre-test stream cleanup ────────────────────────────────────────────────
  if (p.CleanStream) {
    process.stdout.write('Cleaning Redis ingestion stream...');
    const result = cleanRedisStream(tenantId);
    if (result) {
      if (result.cleared > 0 || result.pending > 0) {
        console.log(clr(` cleared ${result.cleared} entries, ${result.pending} PEL`, C.green));
        // Give ingestion workers time to detect NOGROUP and recreate the consumer group.
        await new Promise(r => setTimeout(r, 2500));
      } else {
        console.log(clr(' already empty', C.gray));
      }
    } else {
      console.log('');
    }
  }

  // ── Pre-test DB truncate ───────────────────────────────────────────────────
  process.stdout.write('Truncating readings tables...');
  try {
    dockerExec('iotistic-postgres',
      'psql', '-U', 'postgres', '-d', 'iotistica', '-c',
      'TRUNCATE readings, readings_latest RESTART IDENTITY CASCADE;');
    console.log(clr(' done', C.green));
  } catch (err) {
    console.warn(clr(` failed: ${err.message}`, C.yellow));
  }

  // ── Pre-test spool cleanup ─────────────────────────────────────────────────
  process.stdout.write('Cleaning API spool files...');
  const spoolResult = cleanSpoolFiles();
  if (spoolResult) {
    console.log(spoolResult.deleted > 0
      ? clr(` deleted ${spoolResult.deleted} file(s)`, C.green)
      : clr(' already empty', C.gray));
  } else {
    console.log('');
  }

  process.stdout.write('Cleaning ingestion DB spool files...');
  const ingestionSpoolResult = cleanIngestionSpoolFiles();
  if (ingestionSpoolResult) {
    console.log(ingestionSpoolResult.deleted > 0
      ? clr(` deleted ${ingestionSpoolResult.deleted} file(s)`, C.green)
      : clr(' already empty', C.gray));
  } else {
    console.log('');
  }

  // ── Agent UUIDs ────────────────────────────────────────────────────────────
  let agentUuids;
  if (p.SyntheticAgents) {
    agentUuids = Array.from({ length: p.AgentCount }, () => randomUuidV4());
    console.log(clr(`Generated ${p.AgentCount} synthetic agent UUIDs (no DB lookup)`, C.green));
  } else {
    const dbUuids = getAgentUuidsFromDb(p.AgentCount);
    if (dbUuids.length > 0) {
      agentUuids = Array.from({ length: p.AgentCount }, (_, i) => dbUuids[i % dbUuids.length]);
      console.log(clr(`Using ${dbUuids.length} real agent UUIDs from DB (cycling to ${p.AgentCount} slots)`, C.gray));
    } else {
      agentUuids = Array.from({ length: p.AgentCount }, () => randomUuidV4());
      console.warn('Could not fetch agent UUIDs from DB — using synthetic UUIDs');
    }
  }

  // ── Agent descriptors ──────────────────────────────────────────────────────
  const uuidCount = {};
  for (const u of agentUuids) uuidCount[u] = (uuidCount[u] || 0) + 1;

  const agents = agentUuids.map((uuid, slot) => {
    const rawId    = uuidCount[uuid] > 1 ? `${uuid}-s${slot}` : uuid;
    const clientId = p.MqttClientIdPrefix ? `${p.MqttClientIdPrefix}_${rawId}` : `device_${rawId}`;
    return { uuid, slot, key: `s${slot}`, clientId, topic: mqttTopic(encTenant, encodeUuid(uuid)) };
  });

  const agentByKey = new Map(agents.map(a => [a.key, a]));

  // ── JWT token ──────────────────────────────────────────────────────────────
  let jwt = p.JwtToken;
  if (!jwt) {
    process.stdout.write(`Acquiring JWT token for '${p.Username}'...`);
    try {
      const res  = await fetch(`${p.ApiUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: p.Username, password: p.Password }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      jwt = data?.data?.accessToken || '';
      console.log(jwt ? clr(' OK', C.green) : clr(' FAILED (token missing)', C.yellow));
    } catch (err) {
      console.log(clr(' FAILED', C.yellow));
      console.warn(`JWT login failed: ${err.message}. Health polling will use direct ingestion scrape.`);
    }
  } else {
    console.log('Using provided JWT token.');
  }

  async function getHealth() {
    if (jwt) {
      try {
        const res = await fetch(`${p.ApiUrl}/api/v1/metrics/ingestion-health`, {
          headers: { Authorization: `Bearer ${jwt}` },
          signal: AbortSignal.timeout(5000),
        });
        return res.ok ? res.json() : null;
      } catch { return null; }
    }
    return getIngestionSnapshot();
  }

  // ── Config banner ──────────────────────────────────────────────────────────
  const sampleTopic  = mqttTopic(encTenant, encodeUuid(agentUuids[0]));
  const uniqueTopics = new Set(agents.map(a => a.topic)).size;

  console.log('');
  console.log(clr('=== Iotistica Seam-3 MQTT Load Test (Node) ===', C.cyan));
  console.log(`  Messages    : ${p.MessageCount}`);
  console.log(`  Agents      : ${p.AgentCount}  (${uniqueTopics} unique topics)`);
  console.log(`  Metrics/msg : ${p.MetricsPerMessage}  (${p.MetricsPerMessage * p.MessageCount} total readings)`);
  console.log(`  Rate target : ${p.RatePerSecond > 0 ? `${p.RatePerSecond} msg/s` : 'max speed'}`);
  console.log(`  Broker      : ${p.MqttUseTls ? 'mqtts' : 'mqtt'}://${p.MqttHost}:${p.MqttPort}  user=${p.MqttUsername}`);
  console.log(`  Session     : clean=${p.MqttCleanSession} keepalive=${p.MqttKeepAliveSec}s reconnect=${p.MqttReconnectPeriodMs}ms qos=${p.MqttQoS}${p.MqttQoS === 0 ? '  [fire-and-forget]' : ''}`);
  console.log(`  Compression : ${p.CompressPayload ? 'deflate (zlib) — API auto-detects' : 'none (raw JSON)'}`);
  console.log(`  Tenant      : ${tenantId}  (encoded: ${encTenant})`);
  console.log(`  Topic fmt   : ${sampleTopic.replace(encodeUuid(agentUuids[0]), '{encodedAgentUuid}')}`);
  console.log(`  Health poll : every ${p.PollIntervalSec}s — ${jwt ? 'API health endpoint' : 'direct ingestion scrape'}`);
  console.log('');

  // ── Connect MQTT clients ───────────────────────────────────────────────────
  // Connect in small batches to avoid overwhelming the broker with simultaneous
  // CONNECT handshakes. The MQTT auth cache may be cold after a Redis flush,
  // so the first few batches can be slow. 5 retries × exponential backoff
  // gives ~30s total window for the auth cache to warm up.
  const CONNECT_BATCH = 3;
  const CONNECT_RETRIES = 5;
  process.stdout.write(`Connecting ${p.AgentCount} MQTT clients (${CONNECT_BATCH} at a time)...`);
  const brokerUrl  = `${p.MqttUseTls ? 'mqtts' : 'mqtt'}://${p.MqttHost}:${p.MqttPort}`;
  const mqttOpts   = {
    username:           p.MqttUsername,
    password:           p.MqttPassword,
    clean:              p.MqttCleanSession,
    keepalive:          p.MqttKeepAliveSec,
    reconnectPeriod:    0,    // disable auto-reconnect during connect phase
    connectTimeout:     p.MqttConnectTimeoutMs,
    rejectUnauthorized: !p.MqttInsecureTls,
  };

  async function connectWithRetry(agent) {
    for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
      try {
        return await connectAgent(brokerUrl, { ...mqttOpts, clientId: agent.clientId });
      } catch (err) {
        if (attempt < CONNECT_RETRIES) {
          const delay = Math.min(2000 * attempt, 8000);
          process.stderr.write(`\n[warn] Connect failed for ${agent.clientId} (attempt ${attempt}/${CONNECT_RETRIES}): ${err.message}, retrying in ${delay}ms...\n`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw new Error(`Failed to connect ${agent.clientId} after ${CONNECT_RETRIES} attempts: ${err.message}`);
        }
      }
    }
  }

  const mqttClients = [];
  for (let i = 0; i < agents.length; i += CONNECT_BATCH) {
    const batch = agents.slice(i, i + CONNECT_BATCH);
    const clients = await Promise.all(batch.map(a => connectWithRetry(a)));
    mqttClients.push(...clients);
    if (i + CONNECT_BATCH < agents.length) {
      process.stdout.write(`${mqttClients.length}..`);
    }
  }
  // Restore reconnectPeriod for all connected clients
  for (const c of mqttClients) c.options.reconnectPeriod = p.MqttReconnectPeriodMs;
  console.log(clr(` ${mqttClients.length} connected`, C.green));

  const clientByKey = new Map(agents.map((a, i) => [a.key, mqttClients[i]]));

  // ── Subscriber monitor ─────────────────────────────────────────────────────
  // Subscribes to all test topics and counts broker deliveries independently of
  // the API's own subscription. Lets us distinguish broker→subscriber drop
  // (QoS 0 outbound queue overflow) from downstream loss (Redis / DB path).
  let subscriberReceived = 0;
  let subscriberClient = null;
  const monitorTopic = `i/${encTenant}/a/+/endpoints/load-test`;
  try {
    process.stdout.write('Connecting subscriber monitor...');
    subscriberClient = await connectAgent(brokerUrl, {
      ...mqttOpts,
      clientId: `load-test-monitor-${Date.now()}`,
      reconnectPeriod: 0,
    });
    await new Promise((resolve, reject) => {
      subscriberClient.subscribe(monitorTopic, { qos: 0 }, err => err ? reject(err) : resolve());
    });
    subscriberClient.on('message', () => { subscriberReceived++; });
    console.log(clr(` subscribed to ${monitorTopic}`, C.green));
  } catch (err) {
    console.warn(clr(`  Subscriber monitor failed: ${err.message}`, C.yellow));
    subscriberClient = null;
  }

  // ── Flush timing ───────────────────────────────────────────────────────────
  const batchSize  = Math.max(1, p.BatchSize);
  const roundSize  = batchSize * p.AgentCount;
  const flushIntMs = p.BatchTimeMs > 0
    ? p.BatchTimeMs
    : p.RatePerSecond > 0
      ? Math.max(50, Math.floor(50000 / p.RatePerSecond))
      : 0;

  console.log(clr(`  Flush size  : ${roundSize} msgs (${batchSize} per agent x ${p.AgentCount} agents)`, C.gray));
  if (flushIntMs > 0) {
    const lbl = p.BatchTimeMs === 60000 && p.BatchSize === 12 ? 'agent default'
              : p.BatchTimeMs > 0 ? 'user-specified' : 'auto (streaming mode)';
    console.log(clr(`  Flush interval: ${flushIntMs}ms — ${lbl}`, C.gray));
  }
  console.log('');
  console.log(`${'Time'.padStart(8)} | ${'Msgs/Total  Readings/Total'.padStart(27)} | ${'rate/stream'.padStart(12)} | ${'lag/pending/workers'.padStart(18)} | ${'procΔ/insΔ/dropΔ'.padStart(24)} | ${'dwellP95/insertP95/pool%'.padStart(25)}`);
  console.log('-'.repeat(130));

  // ── State ──────────────────────────────────────────────────────────────────
  const pending   = new Map(agents.map(a => [a.key, []]));
  const baseline  = await getHealth();
  const brokerBaseline = getBrokerPublishCount(p.MqttUsername, p.MqttPassword);
  const startMs   = Date.now();
  const baseTs    = new Date();
  let injected    = 0;
  let mqttPublishes = 0;
  let totalPend   = 0;
  let lastPollSec = 0;
  let lastFlushMs = 0;
  let lastSpoolCheckMs = 0;
  let peakSpoolDuringInject = 0;

  // ── Flush function ─────────────────────────────────────────────────────────
  // Builds one MQTT publish per agent from its buffered messages, then publishes
  // in chunks of 10 with a setImmediate yield between chunks to prevent event-loop
  // starvation (which causes keepalive timeouts at high publish rates).
  async function flush() {
    const work = [];
    for (const [key, msgs] of pending) {
      if (msgs.length === 0) continue;
      const client = clientByKey.get(key);
      const agent  = agentByKey.get(key);
      if (!client || !agent) continue;
      const flushTs = new Date().toISOString();
      const msgId   = Math.random().toString(36).slice(2);
      const msgsStr = msgs.join(',');
      // Build payload as a string — avoids JSON.parse/stringify round-trip.
      const jsonStr = `{"sensor":"load-test","timestamp":"${flushTs}","protocol":"mqtt","messages":[${msgsStr}],"msgId":"${msgId}"}`;
      msgs.length = 0;
      const payload = p.CompressPayload
        ? zlib.deflateSync(Buffer.from(jsonStr, 'utf-8'), { level: zlib.constants.Z_DEFAULT_COMPRESSION })
        : jsonStr;
      work.push({ client, topic: agent.topic, payload });
    }
    mqttPublishes += work.length;
    for (let i = 0; i < work.length; i += 10) {
      await Promise.all(work.slice(i, i + 10).map(w => publishOne(w.client, w.topic, w.payload, p.MqttQoS)));
      if (i + 10 < work.length) await yieldLoop();
    }
  }

  // ── Main publish loop ──────────────────────────────────────────────────────
  for (let i = 0; i < p.MessageCount; i++) {
    const slot  = i % p.AgentCount;
    const agent = agents[slot];
    pending.get(agent.key).push(buildPayload(agent.uuid, `agent-${agent.uuid.slice(0, 8)}`, p.MetricsPerMessage, baseTs, i));
    injected++;
    totalPend++;

    const elapsedMs  = Date.now() - startMs;
    const ageExceeded = flushIntMs > 0 && (elapsedMs - lastFlushMs) >= flushIntMs;

    if (totalPend >= roundSize || ageExceeded) {
      await flush();
      totalPend   = 0;
      lastFlushMs = Date.now() - startMs;
      const sec   = lastFlushMs / 1000;
      if (sec - lastPollSec >= p.PollIntervalSec) {
        const h = await getHealth();
        printHealthRow(h, baseline, injected, p.MessageCount, p.MetricsPerMessage, sec);
        lastPollSec = sec;
      }
    }

    // Spool buildup check every 10s — if spool grows during injection the rate exceeds pipeline capacity.
    if (Date.now() - lastSpoolCheckMs >= 10000) {
      lastSpoolCheckMs = Date.now();
      try {
        const _api = parseInt(dockerExec('iotistic-api', 'sh', '-c',
          'find /var/lib/iotistic/spool -name "spool-*.ndjson" -type f 2>/dev/null | wc -l').trim(), 10) || 0;
        const _ing = parseInt(dockerExec('iotistic-ingestion', 'sh', '-c',
          'find /var/lib/iotistic/ingestion-db-spool -name "spool-*.ndjson" -type f 2>/dev/null | wc -l').trim(), 10) || 0;
        const _tot = _api + _ing;
        if (_tot > peakSpoolDuringInject) peakSpoolDuringInject = _tot;
        if (_tot > 5) {
          process.stdout.write(clr(`  [spool building: ${_tot} file(s) — rate exceeds pipeline capacity]\n`, C.red));
        }
      } catch { /* non-fatal */ }
    }

    // Deadline-based rate limiting (avoids per-message sleep overhead).
    if (p.RatePerSecond > 0) {
      const expected = (i + 1) * 1000 / p.RatePerSecond;
      const slack    = expected - (Date.now() - startMs);
      if (slack > 5) await new Promise(r => setTimeout(r, slack));
    }

    // Yield every 100 messages to let keepalive timers fire between flushes.
    if (i % 100 === 99) await yieldLoop();

    const sec = (Date.now() - startMs) / 1000;
    if (totalPend === 0 && sec - lastPollSec >= p.PollIntervalSec) {
      const h = await getHealth();
      printHealthRow(h, baseline, injected, p.MessageCount, p.MetricsPerMessage, sec);
      lastPollSec = sec;
    }
  }

  // Final flush for any remaining buffered messages
  await flush();

  const totalSec = (Date.now() - startMs) / 1000;
  console.log('');
  console.log(clr('=== Injection complete ===', C.cyan));
  console.log(`  Injected : ${p.MessageCount} messages (${p.MessageCount * p.MetricsPerMessage} readings) in ${totalSec.toFixed(2)}s = ${(p.MessageCount / totalSec).toFixed(1)} msg/s actual`);
  console.log('');

  // ── Unified drain wait ─────────────────────────────────────────────────────
  // Final stats must not be taken until ALL of these are simultaneously true:
  //   1. Redis stream consumer lag = 0  (no unread messages in stream)
  //   2. Consumer pending = 0           (no in-flight/unACKed messages)
  //   3. API spool empty                (no buffered writes waiting for Redis)
  //   4. Ingestion DB spool empty       (no buffered writes waiting for DB)
  //
  // The health snapshot from the tick that satisfies all conditions is reused
  // directly as `fin` for final stats — no second getHealth() call, no race.
  //
  // Timeout: max(10 min, injectTime × 0.5, spoolFiles × 15s)
  let fin = null;
  {
    try {
      const apiSpoolOut0 = dockerExec('iotistic-api', 'sh', '-c',
        'find /var/lib/iotistic/spool -name "spool-*.ndjson" -type f 2>/dev/null | wc -l').trim();
      const ingSpoolOut0 = dockerExec('iotistic-ingestion', 'sh', '-c',
        'find /var/lib/iotistic/ingestion-db-spool -name "spool-*.ndjson" -type f 2>/dev/null | wc -l').trim();
      const initialSpool = (parseInt(apiSpoolOut0, 10) || 0) + (parseInt(ingSpoolOut0, 10) || 0);
      const drainTimeoutMs = Math.max(
        10 * 60 * 1000,
        Math.ceil(totalSec * 0.5) * 1000,
        initialSpool * 15 * 1000,
      );
      console.log(clr(
        `Waiting for stream + spools to fully drain — timeout: ${Math.round(drainTimeoutMs / 60000)}m` +
        (initialSpool > 0 ? ` (${initialSpool} spool file(s))` : ''),
        C.yellow,
      ));

      const drainStart = Date.now();
      while ((Date.now() - drainStart) < drainTimeoutMs) {
        await new Promise(r => setTimeout(r, p.PollIntervalSec * 1000));

        const apiOut = dockerExec('iotistic-api', 'sh', '-c',
          'find /var/lib/iotistic/spool -name "spool-*.ndjson" -type f 2>/dev/null | wc -l').trim();
        const ingOut = dockerExec('iotistic-ingestion', 'sh', '-c',
          'find /var/lib/iotistic/ingestion-db-spool -name "spool-*.ndjson" -type f 2>/dev/null | wc -l').trim();
        const apiSpool = parseInt(apiOut, 10) || 0;
        const ingSpool = parseInt(ingOut, 10) || 0;

        const h   = await getHealth();
        const ela = totalSec + (Date.now() - drainStart) / 1000;
        printHealthRow(h, baseline, injected, p.MessageCount, p.MetricsPerMessage, ela);

        const lag     = h?.workerLag ?? -1;
        const pending = h?.pendingMessages ?? -1;

        if (apiSpool > 0 || ingSpool > 0) {
          process.stdout.write(clr(`  [spool] API: ${apiSpool}  ing: ${ingSpool}  lag: ${lag}  pending: ${pending}   \n`, C.yellow));
        }

        if (apiSpool === 0 && ingSpool === 0 && lag === 0 && pending === 0) {
          console.log('');
          console.log(clr('All clear: spools empty, lag=0, pending=0. Capturing final stats.', C.green));
          fin = h;  // reuse this tick's snapshot — no race between drain and stats
          break;
        }
      }

      if (!fin) {
        // Drain timed out — take a best-effort snapshot and warn.
        const apiFinal = parseInt(
          dockerExec('iotistic-api', 'sh', '-c',
            'find /var/lib/iotistic/spool -name "spool-*.ndjson" -type f 2>/dev/null | wc -l').trim(), 10) || 0;
        const ingFinal = parseInt(
          dockerExec('iotistic-ingestion', 'sh', '-c',
            'find /var/lib/iotistic/ingestion-db-spool -name "spool-*.ndjson" -type f 2>/dev/null | wc -l').trim(), 10) || 0;
        fin = await getHealth();
        console.log('');
        console.warn(clr(
          `  WARNING: Drain timed out — API spool: ${apiFinal}, ing spool: ${ingFinal}, ` +
          `lag: ${fin?.workerLag ?? '?'}, pending: ${fin?.pendingMessages ?? '?'}. ` +
          `Loss count will be overstated.`,
          C.red,
        ));
      }
    } catch (err) {
      console.warn(clr(`  Drain wait failed: ${err && err.message ? err.message : String(err)}`, C.yellow));
      fin = await getHealth();
    }
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  console.log('');
  console.log(clr('=== Final Stats ===', C.cyan));
  const brokerFinal = getBrokerPublishCount(p.MqttUsername, p.MqttPassword);
  // fin was captured from the drain tick that confirmed completion.
  if (fin) {
    const proc = baseline ? (fin.messagesProcessed ?? 0) - (baseline.messagesProcessed ?? 0) : (fin.messagesProcessed ?? '?');
    const ins  = baseline ? (fin.readingsInserted  ?? 0) - (baseline.readingsInserted  ?? 0) : (fin.readingsInserted  ?? '?');
    const drop = baseline ? (fin.messagesDropped   ?? 0) - (baseline.messagesDropped   ?? 0) : (fin.messagesDropped   ?? '?');
    const expectedReadings = injected * p.MetricsPerMessage;
    const actualReadings   = typeof ins === 'number' ? ins : 0;
    const lostReadings     = expectedReadings - actualReadings;
    const lostPct          = expectedReadings > 0 ? ((lostReadings / expectedReadings) * 100).toFixed(1) : '0.0';
    const lostMessages     = injected - (typeof proc === 'number' ? proc : 0);
    const lostMsgPct       = injected > 0 ? ((lostMessages / injected) * 100).toFixed(1) : '0.0';
    console.log(`  Consumer lag    : ${fin.workerLag ?? '?'}  pending: ${fin.pendingMessages ?? '?'}`);
    console.log(`  Sent messages   : ${injected}`);
    console.log(`  Processed       : ${proc}`);
    console.log(clr(`  Lost messages   : ${lostMessages} (${lostMsgPct}%)`, lostMessages > 0 ? C.red : C.green));
    console.log(`  Expected reads  : ${expectedReadings.toLocaleString()}`);
    console.log(`  Readings in DB  : ${actualReadings.toLocaleString()}`);
    console.log(clr(`  Lost readings   : ${lostReadings.toLocaleString()} (${lostPct}%)`, lostReadings > 0 ? C.red : C.green));
    console.log(clr(`  Dropped         : ${drop}`, Number(drop) > 0 ? C.red : C.green));
    console.log(peakSpoolDuringInject > 5
      ? clr(`  Peak spool      : ${peakSpoolDuringInject} file(s) during injection — rate exceeded pipeline capacity`, C.red)
      : clr(`  Peak spool      : ${peakSpoolDuringInject} — pipeline kept up`, C.green));
    console.log(`  DLQ length      : ${fin.dlqLength ?? '?'}`);
    if (Number(fin.dlqLength) > 0) {
      console.log('');
      console.log(clr(`  WARNING: ${fin.dlqLength} messages landed in the DLQ!`, C.red));
      console.log(clr(`  Inspect: docker exec iotistic-redis redis-cli XRANGE tenant:{${tenantId}}:agent:devices:dlq - + COUNT 5`, C.yellow));
    }
  } else {
    console.log(clr('  (ingestion metrics unavailable for final stats)', C.gray));
  }
  const endToEndSec = (Date.now() - startMs) / 1000;
  const mins = Math.floor(endToEndSec / 60);
  const secs = (endToEndSec % 60).toFixed(1);
  console.log(`  Duration        : ${mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}  (inject ${totalSec.toFixed(1)}s + drain ${(endToEndSec - totalSec).toFixed(1)}s)`);
  if (brokerBaseline != null && brokerFinal != null) {
    const brokerDelta = brokerFinal - brokerBaseline;
    console.log(`  MQTT publishes  : ${mqttPublishes.toLocaleString()} msgs  /  ${(mqttPublishes * p.MetricsPerMessage).toLocaleString()} readings`);
    console.log(`  Broker received : ${brokerDelta.toLocaleString()}  ($SYS counter, ~10s update granularity)`);
    // $SYS counters update every sys_interval (~10s). At the test's publish rate,
    // up to 10s of messages may be uncounted. Only flag loss if the gap exceeds
    // what one sys_interval could explain.
    const sysIntervalSec = 10;
    const pubRate = totalSec > 0 ? mqttPublishes / totalSec : 0;
    const sysMargin = Math.ceil(pubRate * sysIntervalSec);
    const gap = mqttPublishes - brokerDelta;
    if (gap > sysMargin) {
      const realLoss = gap - sysMargin;
      const lossPct = mqttPublishes > 0 ? ((realLoss / mqttPublishes) * 100).toFixed(1) : '0.0';
      console.log(clr(`  Transport loss  : ~${realLoss.toLocaleString()} (${lossPct}%) — gap exceeds $SYS timing margin of ${sysMargin}`, C.red));
    } else {
      console.log(clr(`  Transport loss  : 0 (gap of ${gap} within $SYS timing margin of ${sysMargin})`, C.green));
    }
  } else {
    console.log(clr('  Broker $SYS stats unavailable', C.yellow));
  }
  if (subscriberClient) {
    const subLoss         = mqttPublishes - subscriberReceived;
    const subLossPct      = mqttPublishes > 0 ? ((subLoss / mqttPublishes) * 100).toFixed(1) : '0.0';
    const subPct          = mqttPublishes > 0 ? ((subscriberReceived / mqttPublishes) * 100).toFixed(1) : '100.0';
    const subReadings     = subscriberReceived * p.MetricsPerMessage;
    const subReadingsLost = (mqttPublishes - subscriberReceived) * p.MetricsPerMessage;
    const subReadingsPct  = mqttPublishes > 0 ? ((subReadings / (mqttPublishes * p.MetricsPerMessage)) * 100).toFixed(1) : '100.0';
    console.log(`  Subscriber recv : ${subscriberReceived.toLocaleString()} / ${mqttPublishes.toLocaleString()} msgs (${subPct}%)  →  ${subReadings.toLocaleString()} / ${(mqttPublishes * p.MetricsPerMessage).toLocaleString()} readings (${subReadingsPct}%)`);
    if (subLoss > 0) {
      console.log(clr(`  Subscriber loss : ${subLoss.toLocaleString()} msgs  /  ${subReadingsLost.toLocaleString()} readings  (${subLossPct}%) — broker→subscriber QoS 0 drop`, C.red));
    } else {
      console.log(clr(`  Subscriber loss : 0`, C.green));
    }
  }
  console.log('');

  // Close all clients gracefully
  const allClients = [...mqttClients, ...(subscriberClient ? [subscriberClient] : [])];
  await Promise.all(allClients.map(c => new Promise(r => c.end(false, {}, r))));

  // ── Refresh catalog views with final ingested data ────────────────────────
  // Skip when Cleanup=true: data is about to be TRUNCATEd, refresh is pointless.
  if (!p.Cleanup) {
    process.stdout.write(clr('Refreshing metric catalog views...', C.cyan));
    const catalogRefreshStart = Date.now();
    try {
      execFileSync('docker', [
        'exec', 'iotistic-postgres',
        'psql', '-U', 'postgres', '-d', 'iotistica', '-c', 'SELECT refresh_all_catalog_views();'
      ], { encoding: 'utf8', timeout: 300000 });
      const catalogMs = Date.now() - catalogRefreshStart;
      console.log(clr(` done (${(catalogMs / 1000).toFixed(1)}s)`, C.green));
    } catch (err) {
      const catalogMs = Date.now() - catalogRefreshStart;
      console.log(clr(` failed after ${(catalogMs / 1000).toFixed(1)}s: ${err.message}`, C.yellow));
    }
  }

  // ── Post-test cleanup ────────────────────────────────────────────────────
  if (p.Cleanup) {
    console.log(clr('Cleaning up test data...', C.cyan));
    // DB tables
    try {
      const sql = "TRUNCATE readings, series_latest;";
      const out = execFileSync('docker', [
        'exec', 'iotistic-postgres',
        'psql', '-U', 'postgres', '-d', 'iotistica', '-c', sql
      ], { encoding: 'utf8', timeout: 300000 }).trim();
      console.log(clr(`  DB: ${out}`, C.green));
    } catch (err) {
      console.log(clr(`  DB cleanup failed: ${err.message}`, C.yellow));
    }
    // Redis stream (so next run starts clean)
    const streamResult = cleanRedisStream(tenantId);
    if (streamResult) {
      console.log(clr(`  Stream: DEL'd ${streamResult.cleared} entries (ACKed + unACKed), ${streamResult.pending} PEL`, C.green));
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
