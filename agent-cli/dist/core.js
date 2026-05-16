"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.CLILogger = exports.CLIError = exports.ENV = exports.DEVICE_API_V1 = exports.DEVICE_API_BASE = exports.DB_PATH = exports.CONFIG_DIR = void 0;
exports.apiCached = apiCached;
exports.clearApiCache = clearApiCache;
exports.apiRequest = apiRequest;
exports.apiProbe = apiProbe;
exports.getFlagValue = getFlagValue;
exports.normalizePositionalArg = normalizePositionalArg;
exports.validateUrl = validateUrl;
exports.requireConfirmation = requireConfirmation;
exports.redact = redact;
exports.sleep = sleep;
exports.getDbSizeMb = getDbSizeMb;
const fs_1 = require("fs");
const child_process_1 = require("child_process");
const path_1 = require("path");
exports.CONFIG_DIR = process.env.CONFIG_DIR || '/app/data';
exports.DB_PATH = (0, path_1.join)(exports.CONFIG_DIR, 'agent.sqlite');
const DEVICE_API_PORT = process.env.DEVICE_API_PORT || '48484';
exports.DEVICE_API_BASE = process.env.DEVICE_API_URL || `http://localhost:${DEVICE_API_PORT}`;
exports.DEVICE_API_V1 = `${exports.DEVICE_API_BASE}/v1`;
exports.ENV = {
    isContainer: (0, fs_1.existsSync)('/.dockerenv'),
    hasDocker: (() => {
        try {
            (0, child_process_1.execSync)('docker --version', { stdio: 'ignore' });
            return true;
        }
        catch {
            return false;
        }
    })(),
};
class CLIError extends Error {
    exitCode;
    context;
    constructor(message, exitCode = 1, context) {
        super(message);
        this.exitCode = exitCode;
        this.context = context;
        this.name = 'CLIError';
    }
}
exports.CLIError = CLIError;
class CLILogger {
    info(message, context) {
        const contextStr = context ? ` ${JSON.stringify(context)}` : '';
        console.log(`[INFO] ${message}${contextStr}`);
    }
    error(message, error, context) {
        const errorStr = error ? ` - ${error.message}` : '';
        const contextStr = context ? ` ${JSON.stringify(context)}` : '';
        console.error(`[ERROR] ${message}${errorStr}${contextStr}`);
    }
    warn(message, context) {
        const contextStr = context ? ` ${JSON.stringify(context)}` : '';
        console.warn(`[WARN] ${message}${contextStr}`);
    }
    debug(message, context) {
        if (process.env.DEBUG === 'true') {
            const contextStr = context ? ` ${JSON.stringify(context)}` : '';
            console.log(`[DEBUG] ${message}${contextStr}`);
        }
    }
}
exports.CLILogger = CLILogger;
exports.logger = new CLILogger();
const apiCache = new Map();
async function apiCached(endpoint) {
    if (!apiCache.has(endpoint)) {
        apiCache.set(endpoint, apiRequest(endpoint));
    }
    return apiCache.get(endpoint);
}
function clearApiCache() {
    apiCache.clear();
}
async function apiRequest(endpoint, options = {}) {
    try {
        const response = await fetch(endpoint, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
            signal: options.signal ?? AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`HTTP ${response.status}: ${error}`);
        }
        const text = await response.text();
        if (!text || text === 'OK') {
            return { success: true };
        }
        const json = JSON.parse(text);
        return json.Data ?? json;
    }
    catch (error) {
        if (error.code === 'ECONNREFUSED') {
            throw new CLIError('Cannot connect to agent', 1, {
                endpoint: exports.DEVICE_API_BASE,
                hint: 'Make sure the agent is running',
            });
        }
        throw error;
    }
}
async function apiProbe(endpoint, options = {}) {
    try {
        const response = await fetch(endpoint, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
            signal: options.signal ?? AbortSignal.timeout(5000),
        });
        const text = await response.text();
        let parsed = undefined;
        if (text && text !== 'OK') {
            try {
                parsed = JSON.parse(text);
            }
            catch {
                parsed = text;
            }
        }
        return {
            ok: response.ok,
            status: response.status,
            data: parsed,
        };
    }
    catch (error) {
        return {
            ok: false,
            error: error.message,
        };
    }
}
function getFlagValue(flag) {
    const args = process.argv.slice(2);
    const byEquals = args.find((arg) => arg.startsWith(`${flag}=`));
    if (byEquals) {
        return byEquals.split('=')[1];
    }
    const index = args.indexOf(flag);
    if (index === -1 || !args[index + 1]) {
        return undefined;
    }
    return args[index + 1];
}
function normalizePositionalArg(arg) {
    if (!arg || arg.startsWith('--')) {
        return undefined;
    }
    return arg;
}
function validateUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    }
    catch {
        return false;
    }
}
function requireConfirmation(message) {
    const args = process.argv.slice(2);
    if (!args.includes('--yes')) {
        console.log(`\n⚠️  ${message}`);
        console.log('Use --yes flag to confirm this action\n');
        throw new CLIError('Confirmation required', 1, {
            hint: 'Add --yes flag to confirm',
        });
    }
}
function redact(value) {
    if (!value || value.length <= 8) {
        return value ? '****' : 'not set';
    }
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function getDbSizeMb() {
    if (!(0, fs_1.existsSync)(exports.DB_PATH)) {
        return null;
    }
    const stats = (0, fs_1.statSync)(exports.DB_PATH);
    return (stats.size / 1024 / 1024).toFixed(2);
}
//# sourceMappingURL=core.js.map