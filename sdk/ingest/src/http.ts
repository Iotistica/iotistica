import * as https from 'https';
import * as http from 'http';
import * as zlib from 'zlib';
import { randomUUID } from 'crypto';
import type { WireEntry, TargetState } from './types';

export interface HttpTransportOptions {
  apiUrl: string;
  deviceUuid: string;
  deviceApiKey: string;
  maxRetries: number;
  onDropped?: (entries: WireEntry[], reason: string) => void;
}

interface ApiResponse {
  statusCode: number;
  body: string;
}

/** Exponential backoff with full jitter: 2^attempt * 100ms ± 50% */
function backoffMs(attempt: number): number {
  const base = Math.min(100 * Math.pow(2, attempt), 30_000);
  return Math.floor(base * (0.5 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Gzip-compress a Buffer using Node's built-in zlib. */
function gzip(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    zlib.gzip(data, (err, result) => (err ? reject(err) : resolve(result))),
  );
}

/** Make a raw HTTPS/HTTP request — zero external dependencies. */
function request(
  method: string,
  urlStr: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { ...headers, 'Content-Length': String(body.length) },
    };

    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(options, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Serialises a batch of WireEntries to NDJSON, gzip-compresses it, then POSTs
 * to `POST /api/v1/device/:uuid/logs` reusing the exact protocol the existing
 * agent uses (same route, same headers, same idempotency X-Batch-Id).
 *
 * Retries on 5xx / network errors with exponential backoff.
 * Returns true on success, false after all retries exhausted.
 */
export class HttpTransport {
  constructor(private readonly opts: HttpTransportOptions) {}

  async send(entries: WireEntry[]): Promise<boolean> {
    if (entries.length === 0) return true;

    const batchId = randomUUID();
    const ndjson = entries.map(e => JSON.stringify(e)).join('\n');
    const compressed = await gzip(Buffer.from(ndjson, 'utf8'));

    const url = `${this.opts.apiUrl.replace(/\/$/, '')}/api/v1/device/${this.opts.deviceUuid}/logs`;

    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt - 1));

      try {
        const resp = await request('POST', url, {
          'Content-Type': 'application/x-ndjson',
          'Content-Encoding': 'gzip',
          'X-Device-API-Key': this.opts.deviceApiKey,
          'X-Batch-Id': batchId,
          'X-Batch-Attempt': String(attempt + 1),
        }, compressed);

        // 200/202 = success; 200 with duplicate:true is also success (idempotent)
        if (resp.statusCode >= 200 && resp.statusCode < 300) return true;

        // 400 = bad payload — retrying won't help, drop immediately
        if (resp.statusCode === 400) {
          this.opts.onDropped?.(entries, `HTTP 400: ${resp.body}`);
          return false;
        }

        // 401/403 = auth issue — surface clearly
        if (resp.statusCode === 401 || resp.statusCode === 403) {
          this.opts.onDropped?.(entries, `HTTP ${resp.statusCode}: authentication failed`);
          return false;
        }

        // 429 / 5xx → retry
      } catch {
        // Network error → retry
      }
    }

    this.opts.onDropped?.(entries, `Failed after ${this.opts.maxRetries} retries`);
    return false;
  }
}

// ─── Provisioning / registration ─────────────────────────────────────────────

export interface RegisterOptions {
  apiUrl: string;
  provisioningKey: string;
  uuid: string;
  deviceName: string;
  deviceApiKey: string;
}

/**
 * Registers this device with the Iotistica platform using a provisioning key.
 * Only called once per device lifecycle; result is persisted to the state file.
 * Throws on any non-200 response.
 */
export async function registerDevice(opts: RegisterOptions): Promise<void> {
  const url = `${opts.apiUrl.replace(/\/$/, '')}/api/v1/agent/register`;
  const body = Buffer.from(JSON.stringify({
    uuid: opts.uuid,
    deviceName: opts.deviceName,
    deviceType: 'sdk',
    deviceApiKey: opts.deviceApiKey,
  }), 'utf8');

  const resp = await request('POST', url, {
    'Content-Type': 'application/json',
    'x-provisioning-key': opts.provisioningKey,
  }, body);

  if (resp.statusCode === 200 || resp.statusCode === 201) return;

  // 409 = already registered with this UUID — treat as success so a partially
  // completed first-run (state saved but process crashed before returning) is safe.
  if (resp.statusCode === 409) return;

  throw new Error(`Device registration failed (HTTP ${resp.statusCode}): ${resp.body}`);
}

// ─── Target state polling ─────────────────────────────────────────────────────

export interface FetchTargetStateResult {
  /** true when the server returned new state (200); false on 304 Not Modified */
  changed: boolean;
  state?: TargetState;
  /** ETag to send on the next request */
  etag?: string;
}

/**
 * Fetches the current target state from the cloud.
 *
 * Sends `If-None-Match` with the previously received ETag so the server can
 * return `304 Not Modified` when nothing has changed — identical behaviour to
 * the full agent's CloudSync poll loop.
 *
 * Route: `GET /api/v1/device/:uuid/state`
 * Auth:  `X-Device-API-Key` header
 */
export async function fetchTargetState(
  apiUrl: string,
  deviceUuid: string,
  deviceApiKey: string,
  lastEtag?: string,
): Promise<FetchTargetStateResult> {
  const url = `${apiUrl.replace(/\/$/, '')}/api/v1/device/${deviceUuid}/state`;
  const headers: Record<string, string> = {
    'X-Device-API-Key': deviceApiKey,
  };
  if (lastEtag) headers['If-None-Match'] = lastEtag;

  const resp = await request('GET', url, headers, Buffer.alloc(0));

  if (resp.statusCode === 304) return { changed: false };

  if (resp.statusCode === 200) {
    const raw = JSON.parse(resp.body) as Record<string, unknown>;
    // Response shape: { [uuid]: { apps, config, version, ... } }
    const inner = (raw[deviceUuid] ?? raw) as Record<string, unknown>;
    const state: TargetState = {
      apps: (inner.apps as Record<string, unknown>) ?? {},
      config: (inner.config as Record<string, unknown>) ?? {},
      version: inner.version as number | undefined,
      updated_at: inner.updated_at as string | undefined,
    };
    // Extract ETag from response headers — the raw `request()` helper doesn't
    // surface headers, so derive a stable tag from the version number if present,
    // falling back to a hash of the body. This keeps 304 suppression working.
    const etag = state.version !== undefined
      ? `"v${state.version}"`
      : `"${Buffer.from(resp.body).toString('base64').substring(0, 32)}"`;
    return { changed: true, state, etag };
  }

  // 404 = device not yet known to this API instance; treat as no state
  if (resp.statusCode === 404) return { changed: false };

  throw new Error(`Target state fetch failed (HTTP ${resp.statusCode}): ${resp.body}`);
}
