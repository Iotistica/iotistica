"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpTransport = void 0;
exports.registerDevice = registerDevice;
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const zlib = __importStar(require("zlib"));
const crypto_1 = require("crypto");
/** Exponential backoff with full jitter: 2^attempt * 100ms ± 50% */
function backoffMs(attempt) {
    const base = Math.min(100 * Math.pow(2, attempt), 30000);
    return Math.floor(base * (0.5 + Math.random() * 0.5));
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/** Gzip-compress a Buffer using Node's built-in zlib. */
function gzip(data) {
    return new Promise((resolve, reject) => zlib.gzip(data, (err, result) => (err ? reject(err) : resolve(result))));
}
/** Make a raw HTTPS/HTTP request — zero external dependencies. */
function request(method, urlStr, headers, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const options = {
            method,
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            headers: { ...headers, 'Content-Length': String(body.length) },
        };
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(options, res => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                statusCode: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
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
class HttpTransport {
    constructor(opts) {
        this.opts = opts;
    }
    async send(entries) {
        if (entries.length === 0)
            return true;
        const batchId = (0, crypto_1.randomUUID)();
        const ndjson = entries.map(e => JSON.stringify(e)).join('\n');
        const compressed = await gzip(Buffer.from(ndjson, 'utf8'));
        const url = `${this.opts.apiUrl.replace(/\/$/, '')}/api/v1/device/${this.opts.deviceUuid}/logs`;
        for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
            if (attempt > 0)
                await sleep(backoffMs(attempt - 1));
            try {
                const resp = await request('POST', url, {
                    'Content-Type': 'application/x-ndjson',
                    'Content-Encoding': 'gzip',
                    'X-Device-API-Key': this.opts.deviceApiKey,
                    'X-Batch-Id': batchId,
                    'X-Batch-Attempt': String(attempt + 1),
                }, compressed);
                // 200/202 = success; 200 with duplicate:true is also success (idempotent)
                if (resp.statusCode >= 200 && resp.statusCode < 300)
                    return true;
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
            }
            catch {
                // Network error → retry
            }
        }
        this.opts.onDropped?.(entries, `Failed after ${this.opts.maxRetries} retries`);
        return false;
    }
}
exports.HttpTransport = HttpTransport;
/**
 * Registers this device with the Iotistica platform using a provisioning key.
 * Only called once per device lifecycle; result is persisted to the state file.
 * Throws on any non-200 response.
 */
async function registerDevice(opts) {
    const url = `${opts.apiUrl.replace(/\/$/, '')}/api/v1/device/register`;
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
    if (resp.statusCode === 200 || resp.statusCode === 201)
        return;
    // 409 = already registered with this UUID — treat as success so a partially
    // completed first-run (state saved but process crashed before returning) is safe.
    if (resp.statusCode === 409)
        return;
    throw new Error(`Device registration failed (HTTP ${resp.statusCode}): ${resp.body}`);
}
//# sourceMappingURL=http.js.map