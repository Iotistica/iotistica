#!/usr/bin/env node
/**
 * load-test-mqtt-cloud.cjs
 *
 * Cloud-targeted Node.js MQTT load test. Replaces load-test-mqtt-cloud.ps1.
 *
 * Differences vs load-test-mqtt.cjs (local):
 *   - kubectl for all cluster interactions (no Docker exec)
 *   - Tenant ID read from K8s license JWT secret
 *   - Database name read from K8s SQL secret
 *   - MQTT credentials from API runtime env or K8s MQTT secret
 *   - Agent UUIDs fetched via kubectl exec into CNPG primary pod
 *   - Ingestion health polled via kubectl exec into ingestion deployment
 *   - No Redis/spool/broker-$SYS access (no direct cluster FS access)
 *   - TLS enabled by default (mqtts://, port 8883)
 *   - Synthetic agent registration/disposal via CNPG psql
 *
 * Usage:
 *   node load-test-mqtt-cloud.cjs [--Param value ...]
 *
 * Examples:
 *   node load-test-mqtt-cloud.cjs --MessageCount 5000 --AgentCount 20
 *   node load-test-mqtt-cloud.cjs --Namespace demo --RatePerSecond 100 --MqttQoS 0
 *   node load-test-mqtt-cloud.cjs --UseSyntheticAgents true --RegisterSyntheticAgents true --DisposeAfterRun true
 */
'use strict';

const path                       = require('path');
const { execFileSync, execFile }  = require('child_process');
const zlib                       = require('zlib');
const crypto           = require('crypto');
const mqtt             = require(path.resolve(__dirname, '../../api/node_modules/mqtt'));

// ─── Defaults & arg parsing ───────────────────────────────────────────────────

const DEFAULTS = {
  Namespace:               'demo',
  MessageCount:            1000,
  AgentCount:              10,
  MetricsPerMessage:       5,
  RatePerSecond:           0,
  PollIntervalSec:         2,
  TenantId:                '',
  DatabaseName:            '',
  MqttUsername:            '',
  MqttPassword:            '',
  MqttHost:                'demo-mqtt.iotistica.com',
  MqttPort:                8883,
  MqttClientIdPrefix:      '',
  MqttCleanSession:        true,
  MqttKeepAliveSec:        60,
  MqttReconnectPeriodMs:   5000,
  MqttConnectTimeoutMs:    30000,
  MqttUseTls:              true,
  MqttInsecureTls:         true,
  MqttQoS:                 1,
  BatchSize:               200,
  BatchTimeMs:             0,
  CompressPayload:         true,
  UseSyntheticAgents:      false,
  RegisterSyntheticAgents: false,
  DisposeAfterRun:         false,
  TestRunId:               '',
  Cleanup:                 true,
  CleanStream:             true,
  RedisSecretName:         'redis-credentials-demo',
  ApiDeploymentName:       'demo-iotistic-api',
  IngestionDeploymentName: 'demo-iotistic-ingestion',
  CnpgNamespace:           'iotistica-cnpg-cl01',
  CnpgPodName:             'iotistica-cnpg-cl01-1',
  SqlSecretName:           'sql-credentials-demo',
  MqttSecretName:          'mqtt-credentials-demo',
  LicenseSecretName:       'api-license-credentials-demo',
  ApiUrl:                  'https://demo-api.iotistica.com',
  Username:                '',
  Password:                '',
  JwtToken:                '',
};

function parseArgs() {
  const p    = { ...DEFAULTS };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('-')) continue;
    const key  = args[i].replace(/^-+/, '');
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

// ─── ANSI colours ─────────────────────────────────────────────────────────────

const C   = { reset: '\x1b[0m', cyan: '\x1b[36m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', gray: '\x1b[90m' };
const clr = (s, c) => `${c}${s}${C.reset}`;

// ─── base64url (mirrors api/src/mqtt/codec.ts) ────────────────────────────────

const b64url     = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeHex  = (h) => b64url(Buffer.from(h, 'hex'));
const encodeUuid = (u) => b64url(Buffer.from(u.replace(/-/g, ''), 'hex'));
const mqttTopic  = (t, a) => `i/${t}/a/${a}/endpoints/load-test`;

// ─── Utilities ────────────────────────────────────────────────────────────────

function randomUuidV4() {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function normalizeTenantId(value) {
  let t = value.trim();
  t = t.replace(/^\{(.+)\}$/, '$1');
  t = t.replace(/^(cust_|tenant_)/, '');
  return t;
}

function encodeTenantIdForTopic(tenantId) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenantId)) {
    return encodeUuid(tenantId);
  }
  if (/^[0-9a-f]{12}$/.test(tenantId)) {
    return encodeHex(tenantId);
  }
  return tenantId;
}

// ─── kubectl helpers ──────────────────────────────────────────────────────────

function kubectlCapture(args) {
  try {
    return execFileSync('kubectl', args, { encoding: 'utf8' }).trim();
  } catch (err) {
    const msg = (err.stderr || '').trim() || err.message || String(err);
    // Strip kubectl warning lines (W0... / I0...) so the useful error stands out.
    const clean = msg.split('\n').filter(l => !/^[WIE]\d{4}\s/.test(l)).join('\n').trim();
    throw new Error(`kubectl ${args.slice(0, 4).join(' ')} ... failed: ${clean || msg}`);
  }
}

function getSecretValue(namespace, secretName, key) {
  const encoded = kubectlCapture([
    'get', 'secret', secretName, '-n', namespace,
    '-o', `jsonpath={.data.${key}}`,
  ]);
  if (!encoded) {
    throw new Error(`Secret '${secretName}' in namespace '${namespace}' does not contain key '${key}'`);
  }
  return Buffer.from(encoded, 'base64').toString('utf8');
}

function getTenantIdFromLicenseSecret(namespace, secretName) {
  const jwt   = getSecretValue(namespace, secretName, 'key');
  const parts = jwt.split('.');
  if (parts.length < 2) throw new Error(`License secret '${secretName}' does not contain a valid JWT`);
  let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const payload     = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const rawTenantId = payload.tenantId || payload.customerId;
  if (!rawTenantId) throw new Error('License payload does not contain tenantId or customerId');
  return normalizeTenantId(rawTenantId);
}

function getApiRuntimeEnvValue(namespace, deploymentName, key) {
  try {
    return kubectlCapture(['exec', '-n', namespace, `deployment/${deploymentName}`, '--', 'printenv', key]) || null;
  } catch {
    return null;
  }
}

let _resolvedPrimaryPod = null;

function getCnpgPrimaryPod(cnpgNamespace, podNameHint) {
  if (_resolvedPrimaryPod) return _resolvedPrimaryPod;

  // Derive cluster name from pod name hint (e.g. iotistica-cnpg-cl01-1 → iotistica-cnpg-cl01)
  let clusterName = podNameHint.match(/^(.*)-\d+$/)?.[1] ?? null;
  if (!clusterName) {
    clusterName = kubectlCapture([
      'get', 'cluster.postgresql.cnpg.io', '-n', cnpgNamespace,
      '-o', 'jsonpath={.items[0].metadata.name}',
    ]);
    if (!clusterName) throw new Error(`Could not determine CNPG cluster name in namespace '${cnpgNamespace}'`);
  }

  let primaryPod = kubectlCapture([
    'get', 'cluster.postgresql.cnpg.io', clusterName, '-n', cnpgNamespace,
    '-o', 'jsonpath={.status.currentPrimary}',
  ]);
  if (!primaryPod) {
    primaryPod = kubectlCapture([
      'get', 'pods', '-n', cnpgNamespace,
      '-l', `cnpg.io/cluster=${clusterName},cnpg.io/instanceRole=primary`,
      '-o', 'jsonpath={.items[0].metadata.name}',
    ]);
  }
  if (!primaryPod) throw new Error(`Could not determine CNPG primary pod for cluster '${clusterName}' in '${cnpgNamespace}'`);

  _resolvedPrimaryPod = primaryPod;
  return _resolvedPrimaryPod;
}

function cnpgQuery(cnpgNamespace, primaryPod, database, sql) {
  const run = (pod) => kubectlCapture([
    'exec', '-n', cnpgNamespace, pod, '--',
    'psql', '-U', 'postgres', '-d', database, '-t', '-A', '-F', '|', '-c', sql,
  ]);
  try {
    return run(primaryPod);
  } catch (err) {
    if (/read-only transaction|cannot execute .* in a read-only transaction/.test(err.message)) {
      _resolvedPrimaryPod = null;
      const fresh = getCnpgPrimaryPod(cnpgNamespace, primaryPod);
      return run(fresh);
    }
    throw err;
  }
}

// ─── Spool file helpers ─────────────────────────────────────────────────────────

function countCloudSpoolFiles(namespace, deploymentName, spoolPath) {
  try {
    const out = kubectlCapture([
      'exec', '-n', namespace, `deployment/${deploymentName}`, '--',
      'sh', '-c', `find ${spoolPath} -name "spool-*.ndjson" -type f 2>/dev/null | wc -l`,
    ]);
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

// ─── Ingestion health (via kubectl exec into ingestion deployment) ─────────────

const METRIC_FIELDS = [
  ['streamLength',       'iotistic_ingestion_stream_length'],
  ['workerLag',          'iotistic_ingestion_worker_lag'],
  ['pendingMessages',    'iotistic_ingestion_pending_count'],
  ['dlqLength',          'iotistic_ingestion_dlq_length'],
  ['workerCount',        'iotistic_ingestion_worker_count'],
  ['dwellP95Ms',         'iotistic_ingestion_dwell_latency_p95_ms'],
  ['batchLatP95Ms',      'iotistic_ingestion_batch_latency_p95_ms'],
  ['messagesProcessed',  'iotistic_ingestion_messages_processed_total'],
  ['readingsInserted',   'iotistic_ingestion_readings_inserted_total'],
  ['messagesDropped',    'iotistic_ingestion_messages_dropped_total'],
  ['insertLatP95Ms',     'iotistic_ingestion_insert_latency_p95_ms'],
  ['dbPoolPct',          'iotistic_ingestion_db_pool_saturation_pct'],
  ['processingLatP95Ms', 'iotistic_ingestion_processing_latency_p95_ms'],
];

function parseGauge(text, name) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}(?:\\{[^}]*\\})?\\s+([\\-+0-9.eE]+)\\s*$`, 'm');
  const m  = text.match(re);
  return m ? parseFloat(m[1]) : null;
}

const FETCH_SCRIPT =
  "fetch('http://127.0.0.1:3003/metrics')" +
  ".then(r=>r.ok?r.text():Promise.reject(r.status))" +
  ".then(t=>process.stdout.write(t))" +
  ".catch(e=>{process.stderr.write(String(e));process.exit(1);});";

function getIngestionSnapshotSync(namespace, deploymentName) {
  try {
    const text = kubectlCapture([
      'exec', '-n', namespace, `deployment/${deploymentName}`,
      '--', 'node', '-e', FETCH_SCRIPT,
    ]);
    const snap = {};
    for (const [field, metric] of METRIC_FIELDS) snap[field] = parseGauge(text, metric);
    if (snap.streamLength == null && snap.workerLag == null && snap.pendingMessages == null) {
      throw new Error('Metrics scrape returned no expected iotistic_ingestion_* fields');
    }
    return snap;
  } catch (err) {
    throw new Error(`Failed to scrape ingestion metrics from '${deploymentName}' in '${namespace}': ${err.message}`);
  }
}

// Non-blocking version for use inside the publish loop — uses execFile so kubectl
// does not block the Node.js event loop (and therefore does not stall MQTT keepalives
// or PUBACK callbacks during health polls).
function getIngestionSnapshotAsync(namespace, deploymentName) {
  return new Promise((resolve, reject) => {
    execFile('kubectl', [
      'exec', '-n', namespace, `deployment/${deploymentName}`,
      '--', 'node', '-e', FETCH_SCRIPT,
    ], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`kubectl exec failed: ${err.message}`)); return; }
      const text = (stdout || '')
        .split('\n')
        .filter(l => !l.startsWith('W0') && !l.includes('kubectl.kubernetes.io/last-applied'))
        .join('\n');
      const snap = {};
      for (const [field, metric] of METRIC_FIELDS) snap[field] = parseGauge(text, metric);
      if (snap.streamLength == null && snap.workerLag == null && snap.pendingMessages == null) {
        reject(new Error('Metrics scrape returned no expected iotistic_ingestion_* fields'));
        return;
      }
      resolve(snap);
    });
  });
}

// ─── Agent management ─────────────────────────────────────────────────────────

function getAgentUuidsFromCnpg(cnpgNamespace, primaryPod, database, limit) {
  try {
    const out = cnpgQuery(cnpgNamespace, primaryPod, database,
      `SELECT uuid::text, COALESCE(name, 'agent-' || LEFT(uuid::text, 8)) ` +
      `FROM agents WHERE is_active = true ` +
      `ORDER BY modified_at DESC NULLS LAST, created_at DESC ` +
      `LIMIT ${limit};`
    );
    return out.split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(row => {
        const parts = row.split('|', 2);
        if (parts.length === 2 && /^[0-9a-f-]{36}$/.test(parts[0].trim())) {
          return { uuid: parts[0].trim(), name: parts[1].trim() };
        }
        return null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildSyntheticAgents(count, runId) {
  return Array.from({ length: count }, (_, i) => ({
    uuid: randomUuidV4(),
    name: `perf-${runId}-${String(i + 1).padStart(4, '0')}`,
  }));
}

function registerSyntheticAgents(cnpgNamespace, primaryPod, database, agents) {
  if (!agents.length) return;
  const values = agents.map(a => `('${a.uuid}'::uuid, '${a.name.replace(/'/g, "''")}')`).join(',\n  ');
  cnpgQuery(cnpgNamespace, primaryPod, database,
    `INSERT INTO agents (uuid, name) VALUES\n  ${values}\nON CONFLICT (uuid) DO NOTHING;`
  );
}

// ─── Redis stream cleanup ────────────────────────────────────────────────────

function cleanRedisStreamCloud(namespace, deploymentName, tenantId, redisPass) {
  const streamKey = `tenant:{${tenantId}}:agent:devices:ingestion`;
  const auth      = redisPass ? ['-a', redisPass, '--no-auth-warning'] : [];
  const exec      = (cmd) => {
    try {
      return kubectlCapture(['exec', '-n', namespace, `deployment/${deploymentName}`, '--', 'redis-cli', ...auth, ...cmd]);
    } catch (err) {
      throw new Error(`redis-cli ${cmd[0]} failed: ${err.message}`);
    }
  };
  try {
    const existsOut = exec(['EXISTS', streamKey]);
    if (parseInt(existsOut, 10) === 0) return { cleared: 0, pending: 0 };

    const cleared = parseInt(exec(['XLEN', streamKey]), 10) || 0;

    let totalPending = 0;
    try {
      const infoOut = exec(['XINFO', 'GROUPS', streamKey]);
      for (const m of (infoOut.match(/pending\s+(\d+)/g) || [])) {
        totalPending += parseInt(m.match(/\d+/)[0], 10);
      }
    } catch { /* ignore */ }

    exec(['DEL', streamKey]);
    return { cleared, pending: totalPending };
  } catch (err) {
    console.warn(clr(`  Stream cleanup failed: ${err.message}`, C.yellow));
    return null;
  }
}

function removeSyntheticTestData(cnpgNamespace, primaryPod, database, agents, removeAgentRows) {
  if (!agents.length) return;
  const uuids    = [...new Set(agents.map(a => a.uuid))];
  const uuidList = uuids.map(u => `'${u}'::uuid`).join(', ');
  const textList = uuids.map(u => `'${u}'`).join(', ');
  const sql = [
    `DELETE FROM anomaly_events WHERE agent_uuid IN (${textList});`,
    `DELETE FROM readings WHERE agent_uuid IN (${uuidList});`,
    ...(removeAgentRows ? [`DELETE FROM agents WHERE uuid IN (${uuidList});`] : []),
  ].join('\n');
  cnpgQuery(cnpgNamespace, primaryPod, database, sql);
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
  const baseInflight = base ? (Number(base.streamLength) || 0) + (Number(base.pendingMessages) || 0) : 0;
  const inflight     = Math.max(0, (Number(h.streamLength) || 0) + (Number(h.pendingMessages) || 0) - baseInflight);
  const untracked    = typeof proc === 'number' && injected > 0 ? Math.max(0, injected - proc - inflight) : 0;
  const untrackedPct = injected > 0 ? ((untracked / injected) * 100).toFixed(1) : '0.0';
  const lagC       = Number(lag)  > 20000 ? C.red : Number(lag)  > 5000 ? C.yellow : C.cyan;
  const dropC      = Number(drop) > 0     ? C.red : C.green;
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

const METRIC_NAMES = ['temperature','humidity','pressure','vibration','current','voltage','co2','flow','rpm','power'];
const METRIC_BASES = { temperature:23, humidity:45, pressure:101.3, vibration:5, current:2.5, voltage:230, co2:400, flow:12.5, rpm:1450, power:575 };
const METRIC_UNITS = { temperature:'C', humidity:'%', pressure:'kPa', vibration:'mm/s', current:'A', voltage:'V', co2:'ppm', flow:'L/min', rpm:'RPM', power:'W' };

function buildPayload(agentUuid, agentName, metricCount, baseTs, seq) {
  const t = new Date(baseTs.getTime() + seq).toISOString();
  const readings = new Array(metricCount);
  for (let r = 0; r < metricCount; r++) {
    const name  = METRIC_NAMES[r % METRIC_NAMES.length];
    const base  = METRIC_BASES[name];
    const value = (base + (Math.random() * 10 - 5) * 0.001 * base).toFixed(4);
    readings[r] = `{"metric":"${name}","value":${value},"unit":"${METRIC_UNITS[name]}","quality":"good","timestamp":"${t}","protocol":"mqtt"}`;
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

function publishOne(client, topic, payload, qos) {
  return new Promise(resolve => {
    if (!client.connected) { resolve(); return; }
    client.publish(topic, payload, { qos }, () => resolve());
  });
}

const yieldLoop = () => new Promise(r => setImmediate(r));

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const p = parseArgs();

  if (p.RegisterSyntheticAgents && !p.UseSyntheticAgents) {
    throw new Error('--RegisterSyntheticAgents requires --UseSyntheticAgents true');
  }
  if (p.DisposeAfterRun && !p.UseSyntheticAgents) {
    throw new Error('--DisposeAfterRun is only supported with --UseSyntheticAgents true');
  }
  if (p.UseSyntheticAgents && !p.TestRunId) {
    p.TestRunId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  }

  // ── Resolve CNPG primary pod ───────────────────────────────────────────────
  process.stdout.write(`Resolving CNPG primary pod in '${p.CnpgNamespace}'...`);
  const cnpgPrimaryPod = getCnpgPrimaryPod(p.CnpgNamespace, p.CnpgPodName);
  console.log(clr(` ${cnpgPrimaryPod}`, C.green));

  // ── Database name ──────────────────────────────────────────────────────────
  let databaseName = p.DatabaseName;
  if (!databaseName) {
    process.stdout.write(`Reading database name from secret '${p.SqlSecretName}'...`);
    databaseName = getSecretValue(p.Namespace, p.SqlSecretName, 'dbname');
    console.log(clr(` ${databaseName}`, C.green));
  }

  // ── Tenant ID ──────────────────────────────────────────────────────────────
  let tenantId = p.TenantId;
  if (!tenantId) {
    process.stdout.write(`Discovering tenant ID from license secret '${p.LicenseSecretName}'...`);
    tenantId = getTenantIdFromLicenseSecret(p.Namespace, p.LicenseSecretName);
    console.log(clr(` ${tenantId}`, C.green));
  } else {
    tenantId = normalizeTenantId(tenantId);
    console.log(clr(`Using tenant ID: ${tenantId}`, C.green));
  }
  const encTenant = encodeTenantIdForTopic(tenantId);

  // ── MQTT credentials ───────────────────────────────────────────────────────
  if (!p.MqttUsername) {
    p.MqttUsername = getApiRuntimeEnvValue(p.Namespace, p.ApiDeploymentName, 'MQTT_USERNAME') || 'admin';
  }
  if (!p.MqttPassword) {
    p.MqttPassword = getApiRuntimeEnvValue(p.Namespace, p.ApiDeploymentName, 'MQTT_PASSWORD') || '';
  }
  if (!p.MqttPassword) {
    process.stdout.write(`Reading MQTT password from secret '${p.MqttSecretName}'...`);
    p.MqttPassword = getSecretValue(p.Namespace, p.MqttSecretName, 'password');
    console.log(clr(' done', C.green));
  }

  // ── JWT token (for API health polling via fetch, same as local version) ────
  let jwt = p.JwtToken;
  if (!jwt && p.Username) {
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
      console.warn(`JWT login failed: ${err.message}. Health polling will use kubectl exec fallback.`);
    }
  } else if (jwt) {
    console.log(clr('Using provided JWT token.', C.green));
  }

  // ── Agent UUIDs ────────────────────────────────────────────────────────────
  let selectedAgents;
  let syntheticAgentsRegistered = false;

  if (p.UseSyntheticAgents) {
    selectedAgents = buildSyntheticAgents(p.AgentCount, p.TestRunId);
    if (p.RegisterSyntheticAgents) {
      process.stdout.write(`Registering ${p.AgentCount} synthetic agents in DB...`);
      registerSyntheticAgents(p.CnpgNamespace, cnpgPrimaryPod, databaseName, selectedAgents);
      syntheticAgentsRegistered = true;
      console.log(clr(' done', C.green));
    } else {
      console.log(clr(`Generated ${p.AgentCount} synthetic agent UUIDs (no DB registration)`, C.green));
    }
  } else {
    process.stdout.write(`Fetching up to ${p.AgentCount} active agent UUIDs from '${databaseName}'...`);
    const dbAgents = getAgentUuidsFromCnpg(p.CnpgNamespace, cnpgPrimaryPod, databaseName, p.AgentCount);
    if (!dbAgents.length) throw new Error(`No active agents found in database '${databaseName}' via CNPG pod '${cnpgPrimaryPod}'`);
    selectedAgents = Array.from({ length: p.AgentCount }, (_, i) => dbAgents[i % dbAgents.length]);
    console.log(clr(` ${dbAgents.length} found, cycling to ${p.AgentCount} slots`, C.green));
  }

  // ── Agent descriptors ──────────────────────────────────────────────────────
  const uuidCount = {};
  for (const a of selectedAgents) uuidCount[a.uuid] = (uuidCount[a.uuid] || 0) + 1;

  const agents = selectedAgents.map((a, slot) => {
    const rawId    = uuidCount[a.uuid] > 1 ? `${a.uuid}-s${slot}` : a.uuid;
    const clientId = p.MqttClientIdPrefix ? `${p.MqttClientIdPrefix}_${rawId}` : `device_${rawId}`;
    return { uuid: a.uuid, name: a.name, slot, key: `s${slot}`, clientId, topic: mqttTopic(encTenant, encodeUuid(a.uuid)) };
  });

  const agentByKey   = new Map(agents.map(a => [a.key, a]));
  const uniqueTopics = new Set(agents.map(a => a.topic)).size;

  // ── Config banner ──────────────────────────────────────────────────────────
  const sampleTopic = mqttTopic(encTenant, encodeUuid(agents[0].uuid));
  console.log('');
  console.log(clr('=== Iotistica Cloud MQTT Load Test (Node) ===', C.cyan));
  console.log(`  Namespace   : ${p.Namespace}`);
  console.log(`  CNPG        : ${p.CnpgNamespace} / ${cnpgPrimaryPod} / ${databaseName}`);
  console.log(`  Messages    : ${p.MessageCount}`);
  console.log(`  Agents      : ${p.AgentCount}  (${uniqueTopics} unique topics; ${p.UseSyntheticAgents ? `synthetic — run ${p.TestRunId}` : `${new Set(selectedAgents.map(a => a.uuid)).size} from DB`})`);
  console.log(`  Metrics/msg : ${p.MetricsPerMessage}  (${p.MetricsPerMessage * p.MessageCount} total readings)`);
  console.log(`  Rate target : ${p.RatePerSecond > 0 ? `${p.RatePerSecond} msg/s` : 'max speed'}`);
  console.log(`  Broker      : ${p.MqttUseTls ? 'mqtts' : 'mqtt'}://${p.MqttHost}:${p.MqttPort}  user=${p.MqttUsername}`);
  console.log(`  Session     : clean=${p.MqttCleanSession} keepalive=${p.MqttKeepAliveSec}s reconnect=${p.MqttReconnectPeriodMs}ms qos=${p.MqttQoS}`);
  console.log(`  Compression : ${p.CompressPayload ? 'deflate (zlib)' : 'none (raw JSON)'}`);
  console.log(`  Tenant      : ${tenantId}  (encoded: ${encTenant})`);
  console.log(`  Topic fmt   : ${sampleTopic.replace(encodeUuid(agents[0].uuid), '{encodedAgentUuid}')}`);
  console.log(`  Health poll : every ${p.PollIntervalSec}s — ${jwt ? `fetch ${p.ApiUrl}/api/v1/metrics/ingestion-health` : `kubectl exec deployment/${p.IngestionDeploymentName} (no JWT — pass --Username and --Password for faster polling)`}`);
  console.log('');

  // ── Pre-test cleanup ──────────────────────────────────────────────────────
  if (p.Cleanup) {
    // Redis stream
    if (p.CleanStream) {
      process.stdout.write('Cleaning Redis ingestion stream...');
      let redisPass = '';
      try { redisPass = getSecretValue(p.Namespace, p.RedisSecretName, 'password'); } catch { /* optional */ }
      const result = cleanRedisStreamCloud(p.Namespace, 'redis', tenantId, redisPass);
      if (result) {
        if (result.cleared > 0 || result.pending > 0) {
          console.log(clr(` cleared ${result.cleared} entries, ${result.pending} PEL`, C.green));
          await new Promise(r => setTimeout(r, 2500));
        } else {
          console.log(clr(' already empty', C.gray));
        }
      } else {
        console.log('');
      }
    }

    // DB truncate
    process.stdout.write('Truncating readings tables...');
    try {
      cnpgQuery(p.CnpgNamespace, cnpgPrimaryPod, databaseName,
        'TRUNCATE readings, readings_latest RESTART IDENTITY CASCADE;');
      console.log(clr(' done', C.green));
    } catch (err) {
      console.warn(clr(` failed: ${err.message}`, C.yellow));
    }
  }

  // ── Connect MQTT clients ───────────────────────────────────────────────────
  const CONNECT_BATCH   = 3;
  const CONNECT_RETRIES = 5;
  process.stdout.write(`Connecting ${p.AgentCount} MQTT clients (${CONNECT_BATCH} at a time)...`);
  const brokerUrl = `${p.MqttUseTls ? 'mqtts' : 'mqtt'}://${p.MqttHost}:${p.MqttPort}`;
  const mqttOpts  = {
    username:           p.MqttUsername,
    password:           p.MqttPassword,
    clean:              p.MqttCleanSession,
    keepalive:          p.MqttKeepAliveSec,
    reconnectPeriod:    0,    // disabled during connect phase; restored after
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
    const batch   = agents.slice(i, i + CONNECT_BATCH);
    const clients = await Promise.all(batch.map(a => connectWithRetry(a)));
    mqttClients.push(...clients);
    if (i + CONNECT_BATCH < agents.length) process.stdout.write(`${mqttClients.length}..`);
  }
  // Re-enable auto-reconnect for all connected clients
  for (const c of mqttClients) c.options.reconnectPeriod = p.MqttReconnectPeriodMs;
  console.log(clr(` ${mqttClients.length} connected`, C.green));

  const clientByKey = new Map(agents.map((a, i) => [a.key, mqttClients[i]]));

  // ── Ingestion health wrapper ───────────────────────────────────────────────
  // Mirrors local version: fetch() to API endpoint when JWT available (non-blocking),
  // falls back to kubectl exec only if no JWT.
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
    // Fallback: kubectl exec (blocking — only used when no JWT provided)
    try { return await getIngestionSnapshotAsync(p.Namespace, p.IngestionDeploymentName); }
    catch (err) { process.stderr.write(`[warn] Health poll failed: ${err.message}\n`); return null; }
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
  if (flushIntMs > 0) console.log(clr(`  Flush interval: ${flushIntMs}ms`, C.gray));
  console.log('');
  console.log(`${'Time'.padStart(8)} | ${'Msgs/Total  Readings/Total'.padStart(27)} | ${'rate/stream'.padStart(12)} | ${'lag/pending/workers'.padStart(18)} | ${'procΔ/insΔ/dropΔ'.padStart(24)} | ${'dwellP95/insertP95/pool%'.padStart(25)}`);
  console.log('-'.repeat(130));

  // ── State ──────────────────────────────────────────────────────────────────
  const pending          = new Map(agents.map(a => [a.key, []]));
  const baseline         = await getHealth();
  const startMs          = Date.now();
  const baseTs           = new Date();
  let injected           = 0;
  let mqttPublishes      = 0;
  let totalPend          = 0;
  let lastPollSec        = 0;
  let lastFlushMs        = 0;
  let streamEverNonZero  = false;
  let peakStreamLength   = 0;

  // ── Background health poller ───────────────────────────────────────────────
  // Polls on a setInterval so the publish loop never awaits getHealth().
  // The loop reads lastHealth synchronously — no suspension, no rate impact.
  let lastHealth      = baseline;
  let healthPollBusy  = false;
  const healthTimer   = setInterval(async () => {
    if (healthPollBusy) return;
    healthPollBusy = true;
    try { lastHealth = await getHealth() ?? lastHealth; }
    finally { healthPollBusy = false; }
  }, p.PollIntervalSec * 1000);
  healthTimer.unref(); // don't keep process alive if loop finishes early

  // ── Flush function ─────────────────────────────────────────────────────────
  // Builds one MQTT publish per agent from its buffered messages, then publishes
  // in chunks of 10 with a setImmediate yield to prevent event-loop starvation.
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
      const jsonStr = `{"sensor":"load-test","timestamp":"${flushTs}","protocol":"mqtt","messages":[${msgsStr}],"msgId":"${msgId}"}`;
      msgs.length   = 0;
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
    pending.get(agent.key).push(buildPayload(agent.uuid, agent.name, p.MetricsPerMessage, baseTs, i));
    injected++;
    totalPend++;

    const elapsedMs   = Date.now() - startMs;
    const ageExceeded = flushIntMs > 0 && (elapsedMs - lastFlushMs) >= flushIntMs;

    if (totalPend >= roundSize || ageExceeded) {
      await flush();
      totalPend   = 0;
      lastFlushMs = Date.now() - startMs;
      const sec   = lastFlushMs / 1000;
      if (sec - lastPollSec >= p.PollIntervalSec) {
        const h = lastHealth;
        printHealthRow(h, baseline, injected, p.MessageCount, p.MetricsPerMessage, sec);
        if ((h?.streamLength ?? 0) > 0) { streamEverNonZero = true; peakStreamLength = Math.max(peakStreamLength, h.streamLength); }
        lastPollSec = sec;
      }
    }

    // Deadline-based rate limiting (avoids per-message sleep overhead).
    if (p.RatePerSecond > 0) {
      const expected = (i + 1) * 1000 / p.RatePerSecond;
      const slack    = expected - (Date.now() - startMs);
      if (slack > 5) await new Promise(r => setTimeout(r, slack));
    }

    // Yield every 100 messages to let keepalive timers fire.
    if (i % 100 === 99) await yieldLoop();

    const sec = (Date.now() - startMs) / 1000;
    if (totalPend === 0 && sec - lastPollSec >= p.PollIntervalSec) {
      const h = lastHealth;
      printHealthRow(h, baseline, injected, p.MessageCount, p.MetricsPerMessage, sec);
      if ((h?.streamLength ?? 0) > 0) { streamEverNonZero = true; peakStreamLength = Math.max(peakStreamLength, h.streamLength); }
      lastPollSec = sec;
    }
  }

  // Stop background health poller
  clearInterval(healthTimer);

  // Final flush for any remaining buffered messages
  await flush();

  const totalSec = (Date.now() - startMs) / 1000;
  console.log('');
  console.log(clr('=== Injection complete ===', C.cyan));
  console.log(`  Injected : ${p.MessageCount} messages (${p.MessageCount * p.MetricsPerMessage} readings) in ${totalSec.toFixed(2)}s = ${(p.MessageCount / totalSec).toFixed(1)} msg/s actual`);
  console.log('');

  // ── Drain wait ─────────────────────────────────────────────────────────────
  // Wait until lag=0, pendingMessages=0, AND API spool empty before capturing
  // final stats. Without the spool check the test declares "all clear" while
  // the API is still replaying buffered files into Redis, understating inserts.
  // Timeout: max(10 min, injectTime × 0.5, spoolFiles × 15s)
  const API_SPOOL_PATH        = '/tmp/iotistic-spool';
  const INGESTION_SPOOL_PATH  = '/var/lib/iotistic/spool';
  const initialApiSpool       = countCloudSpoolFiles(p.Namespace, p.ApiDeploymentName, API_SPOOL_PATH);
  const initialIngSpool       = countCloudSpoolFiles(p.Namespace, p.IngestionDeploymentName, INGESTION_SPOOL_PATH);
  const initialSpool          = initialApiSpool + initialIngSpool;
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

  // Require at least DRAIN_MIN_POLLS polls before allowing early exit — prevents
  // a false "all clear" when messages never reached the Redis stream and lag
  // was already 0 before the first poll.
  const DRAIN_MIN_POLLS = 3;
  let fin = null;
  let drainPoll = 0;
  const drainStart = Date.now();
  while ((Date.now() - drainStart) < drainTimeoutMs) {
    await new Promise(r => setTimeout(r, p.PollIntervalSec * 1000));
    drainPoll++;
    const apiSpool = countCloudSpoolFiles(p.Namespace, p.ApiDeploymentName, API_SPOOL_PATH);
    const ingSpool = countCloudSpoolFiles(p.Namespace, p.IngestionDeploymentName, INGESTION_SPOOL_PATH);
    const h   = await getHealth();
    const ela = totalSec + (Date.now() - drainStart) / 1000;
    printHealthRow(h, baseline, injected, p.MessageCount, p.MetricsPerMessage, ela);
    if ((h?.streamLength ?? 0) > 0) { streamEverNonZero = true; peakStreamLength = Math.max(peakStreamLength, h.streamLength); }
    if (apiSpool > 0 || ingSpool > 0) {
      const lag     = h?.workerLag ?? -1;
      const pending = h?.pendingMessages ?? -1;
      process.stdout.write(clr(`  [spool] API: ${apiSpool}  ing: ${ingSpool}  lag: ${lag}  pending: ${pending}   \n`, C.yellow));
    }
    if (drainPoll >= DRAIN_MIN_POLLS && apiSpool === 0 && ingSpool === 0 && (h?.workerLag ?? -1) === 0 && (h?.pendingMessages ?? -1) === 0) {
      console.log('');
      if (!streamEverNonZero && injected > 0) {
        console.warn(clr('  WARNING: Stream was never populated during this test run.', C.red));
        console.warn(clr('  Messages were published to the broker but did not reach the Redis ingestion stream.', C.yellow));
        console.warn(clr(`  Check: MQTT topic routing, broker ACLs, and API MQTT subscription for tenant '${tenantId}'.`, C.yellow));
        console.warn(clr(`  Sample topic used: ${sampleTopic}`, C.yellow));
      } else {
        console.log(clr('All clear: spools empty, lag=0, pending=0. Capturing final stats.', C.green));
      }
      fin = h;
      break;
    }
  }

  if (!fin) {
    const apiFinal = countCloudSpoolFiles(p.Namespace, p.ApiDeploymentName, API_SPOOL_PATH);
    const ingFinal = countCloudSpoolFiles(p.Namespace, p.IngestionDeploymentName, INGESTION_SPOOL_PATH);
    fin = await getHealth();
    console.log('');
    console.warn(clr(
      `  WARNING: Drain timed out — API spool: ${apiFinal}, ing spool: ${ingFinal}, ` +
      `lag: ${fin?.workerLag ?? '?'}, pending: ${fin?.pendingMessages ?? '?'}. ` +
      `Loss count may be overstated.`,
      C.red,
    ));
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  console.log('');
  console.log(clr('=== Final Stats ===', C.cyan));
  if (fin) {
    // Use null-aware deltas so that a missing metric shows '?' rather than
    // silently collapsing to 0 (null ?? 0 = 0 would mask unavailable counters).
    const procDelta = (fin.messagesProcessed != null && baseline?.messagesProcessed != null)
      ? fin.messagesProcessed - baseline.messagesProcessed : null;
    const insDelta  = (fin.readingsInserted  != null && baseline?.readingsInserted  != null)
      ? fin.readingsInserted  - baseline.readingsInserted  : null;
    const dropDelta = (fin.messagesDropped   != null && baseline?.messagesDropped   != null)
      ? fin.messagesDropped   - baseline.messagesDropped   : null;
    const proc = procDelta ?? (fin.messagesProcessed != null ? fin.messagesProcessed : '?');
    const ins  = insDelta  ?? (fin.readingsInserted  != null ? fin.readingsInserted  : '?');
    const drop = dropDelta ?? (fin.messagesDropped   != null ? fin.messagesDropped   : '?');
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
    console.log(`  DLQ length      : ${fin.dlqLength ?? '?'}`);
    console.log(`  Stream peak     : ${peakStreamLength}${peakStreamLength === 0 && injected > 0 ? clr('  ← ZERO — messages did not reach Redis', C.red) : ''}`);
    if (proc === '?' || ins === '?') {
      console.log(clr('  Metrics note    : ingestion snapshot unavailable — processed/inserted counts are unknown.', C.yellow));
    }
    if (Number(fin.dlqLength) > 0) {
      console.log('');
      console.log(clr(`  WARNING: ${fin.dlqLength} messages landed in the DLQ!`, C.red));
    }
    const endToEndSec = (Date.now() - startMs) / 1000;
    const mins = Math.floor(endToEndSec / 60);
    const secs = (endToEndSec % 60).toFixed(1);
    console.log(`  MQTT publishes  : ${mqttPublishes.toLocaleString()} msgs`);
    console.log(`  Duration        : ${mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}  (inject ${totalSec.toFixed(1)}s + drain ${(endToEndSec - totalSec).toFixed(1)}s)`);
  } else {
    console.log(clr('  (ingestion metrics unavailable for final stats)', C.gray));
  }
  console.log('');

  // ── Close MQTT clients ─────────────────────────────────────────────────────
  await Promise.all(mqttClients.map(c => new Promise(r => c.end(false, {}, r))));

  // ── Dispose synthetic test data ────────────────────────────────────────────
  if (p.DisposeAfterRun && p.UseSyntheticAgents) {
    process.stdout.write(clr('Disposing synthetic test data...', C.yellow));
    removeSyntheticTestData(p.CnpgNamespace, cnpgPrimaryPod, databaseName, selectedAgents, syntheticAgentsRegistered);
    console.log(clr(' done', C.green));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
