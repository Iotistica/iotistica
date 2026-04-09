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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pinoLogger = exports.logger = void 0;
exports.createAppLogger = createAppLogger;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const stream_1 = require("stream");
const pino_1 = __importStar(require("pino"));
const PINO_LEVEL_LABELS = {
    10: 'trace',
    20: 'debug',
    30: 'info',
    40: 'warn',
    50: 'error',
    60: 'fatal',
};
const ANSI_RESET = '\u001b[0m';
const LEVEL_COLORS = {
    trace: '\u001b[90m',
    debug: '\u001b[34m',
    info: '\u001b[32m',
    warn: '\u001b[33m',
    error: '\u001b[31m',
    fatal: '\u001b[31m',
};
function getConfiguredLevel() {
    const configuredLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
    switch (configuredLevel) {
        case 'trace':
        case 'debug':
        case 'info':
        case 'warn':
        case 'error':
        case 'fatal':
            return configuredLevel;
        default:
            return 'info';
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function normalizeError(error) {
    return {
        error: error.message,
        name: error.name,
        stack: error.stack,
    };
}
function normalizeMeta(value) {
    if (value === undefined) {
        return undefined;
    }
    if (value instanceof Error) {
        return normalizeError(value);
    }
    if (isRecord(value)) {
        return value;
    }
    return { value };
}
function normalizeArgs(first, second) {
    if (typeof first === 'string') {
        if (second === undefined) {
            return { msg: first };
        }
        if (typeof second === 'string' || typeof second === 'number' || typeof second === 'boolean' || typeof second === 'bigint') {
            return { msg: `${first} ${String(second)}` };
        }
        return { msg: first, meta: normalizeMeta(second) };
    }
    if (first instanceof Error) {
        return {
            msg: typeof second === 'string' ? second : first.message,
            meta: normalizeError(first),
        };
    }
    if (second === undefined) {
        return { meta: normalizeMeta(first), msg: undefined };
    }
    if (typeof second === 'string') {
        return { msg: second, meta: normalizeMeta(first) };
    }
    return { msg: typeof first === 'undefined' ? undefined : String(first), meta: normalizeMeta(second) };
}
function getDisplayTime(value) {
    if (!value) {
        return new Date().toISOString().slice(11, 19);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toISOString().slice(11, 19);
}
function getLevelLabel(level) {
    if (!level) {
        return 'info';
    }
    return PINO_LEVEL_LABELS[level] ?? String(level);
}
function colorizeLevel(level) {
    if (!process.stdout.isTTY) {
        return level;
    }
    const color = LEVEL_COLORS[level];
    if (!color) {
        return level;
    }
    return `${color}${level}${ANSI_RESET}`;
}
function formatConsoleMeta(record) {
    const { level, time, msg, service, operation, step, pid, hostname, ...meta } = record;
    if (Object.keys(meta).length === 0) {
        return '';
    }
    return ` ${JSON.stringify(meta)}`;
}
function formatConsoleLine(record) {
    const timestamp = getDisplayTime(record.time);
    const level = getLevelLabel(record.level);
    const displayLevel = colorizeLevel(level);
    const operationPrefix = record.operation ? `[${String(record.operation)}]${record.step ? ` ${String(record.step)} ->` : ''} ` : '';
    const message = record.msg ?? '';
    return `${timestamp} [${displayLevel}]: ${operationPrefix}${message}${formatConsoleMeta(record)}`;
}
function createPrettyConsoleStream() {
    let buffered = '';
    const flushLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }
        try {
            const parsed = JSON.parse(trimmed);
            process.stdout.write(`${formatConsoleLine(parsed)}\n`);
        }
        catch {
            process.stdout.write(`${trimmed}\n`);
        }
    };
    return new stream_1.Writable({
        write(chunk, _encoding, callback) {
            buffered += chunk.toString();
            const lines = buffered.split('\n');
            buffered = lines.pop() ?? '';
            for (const line of lines) {
                flushLine(line);
            }
            callback();
        },
        final(callback) {
            flushLine(buffered);
            buffered = '';
            callback();
        },
    });
}
function writeLog(loggerInstance, level, first, second) {
    const { msg, meta } = normalizeArgs(first, second);
    switch (level) {
        case 'info':
            if (meta && msg)
                loggerInstance.info(meta, msg);
            else if (meta)
                loggerInstance.info(meta);
            else if (msg)
                loggerInstance.info(msg);
            return;
        case 'warn':
            if (meta && msg)
                loggerInstance.warn(meta, msg);
            else if (meta)
                loggerInstance.warn(meta);
            else if (msg)
                loggerInstance.warn(msg);
            return;
        case 'error':
            if (meta && msg)
                loggerInstance.error(meta, msg);
            else if (meta)
                loggerInstance.error(meta);
            else if (msg)
                loggerInstance.error(msg);
            return;
        case 'debug':
            if (meta && msg)
                loggerInstance.debug(meta, msg);
            else if (meta)
                loggerInstance.debug(meta);
            else if (msg)
                loggerInstance.debug(msg);
            return;
    }
}
function wrapLogger(loggerInstance) {
    return {
        info(first, second) {
            writeLog(loggerInstance, 'info', first, second);
        },
        warn(first, second) {
            writeLog(loggerInstance, 'warn', first, second);
        },
        error(first, second) {
            writeLog(loggerInstance, 'error', first, second);
        },
        debug(first, second) {
            writeLog(loggerInstance, 'debug', first, second);
        },
        child(bindings) {
            return wrapLogger(loggerInstance.child(bindings));
        },
    };
}
function createStreams() {
    const configuredLevel = getConfiguredLevel();
    const streams = [{
            stream: createPrettyConsoleStream(),
            level: configuredLevel,
        }];
    if (!isKubernetes) {
        fs_1.default.mkdirSync(path_1.default.join(process.cwd(), 'logs'), { recursive: true });
        streams.push({ stream: (0, pino_1.destination)(path_1.default.join('logs', 'combined.log')), level: configuredLevel });
        streams.push({ stream: (0, pino_1.destination)(path_1.default.join('logs', 'error.log')), level: 'error' });
    }
    return (0, pino_1.multistream)(streams);
}
function createAppLogger(bindings) {
    const loggerInstance = bindings ? pinoLogger.child(bindings) : pinoLogger;
    return wrapLogger(loggerInstance);
}
const isKubernetes = !!process.env.KUBERNETES_SERVICE_HOST;
const pinoLogger = (0, pino_1.default)({
    level: getConfiguredLevel(),
    timestamp: pino_1.default.stdTimeFunctions.isoTime,
    base: {
        service: 'iotistic-ingestion',
    },
    serializers: {
        err: pino_1.stdSerializers.err,
        error: pino_1.stdSerializers.err,
    },
}, createStreams());
exports.pinoLogger = pinoLogger;
const logger = createAppLogger();
exports.logger = logger;
exports.default = logger;
//# sourceMappingURL=logger.js.map