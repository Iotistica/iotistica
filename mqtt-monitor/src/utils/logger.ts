import { Writable } from 'stream';
import pino, { stdSerializers, type Logger as PinoLogger } from 'pino';

export interface AppLogger {
  info(message: string): void;
  info(message: string, meta: unknown): void;
  info(meta: unknown, message?: string): void;
  warn(message: string): void;
  warn(message: string, meta: unknown): void;
  warn(meta: unknown, message?: string): void;
  error(message: string): void;
  error(message: string, meta: unknown): void;
  error(meta: unknown, message?: string): void;
  debug(message: string): void;
  debug(message: string, meta: unknown): void;
  debug(meta: unknown, message?: string): void;
  child(bindings: Record<string, unknown>): AppLogger;
}

type LogLevel = 'info' | 'warn' | 'error' | 'debug';
type PinoLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface ConsoleLogRecord {
  level?: number;
  time?: string;
  msg?: string;
  service?: string;
  [key: string]: unknown;
}

interface NormalizedLogArgs {
  msg?: string;
  meta?: Record<string, unknown>;
}

const PINO_LEVEL_LABELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal'
};

const ANSI_RESET = '\u001b[0m';

const LEVEL_COLORS: Partial<Record<string, string>> = {
  trace: '\u001b[90m',
  debug: '\u001b[34m',
  info: '\u001b[32m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  fatal: '\u001b[31m'
};

function getConfiguredLevel(): PinoLevel {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeError(error: Error): Record<string, unknown> {
  return {
    error: error.message,
    name: error.name,
    stack: error.stack
  };
}

function normalizeMeta(value: unknown): Record<string, unknown> | undefined {
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

function normalizeArgs(first: unknown, second?: unknown): NormalizedLogArgs {
  if (typeof first === 'string') {
    if (second === undefined) {
      return { msg: first };
    }

    if (typeof second === 'string' || typeof second === 'number' || typeof second === 'boolean' || typeof second === 'bigint') {
      return { msg: `${first} ${String(second)}` };
    }

    return {
      msg: first,
      meta: normalizeMeta(second)
    };
  }

  if (first instanceof Error) {
    return {
      msg: typeof second === 'string' ? second : first.message,
      meta: normalizeError(first)
    };
  }

  if (second === undefined) {
    return {
      meta: normalizeMeta(first)
    };
  }

  if (typeof second === 'string') {
    return {
      msg: second,
      meta: normalizeMeta(first)
    };
  }

  return {
    msg: typeof first === 'undefined' ? undefined : String(first),
    meta: normalizeMeta(second)
  };
}

function getDisplayTime(value?: string): string {
  if (!value) {
    return new Date().toISOString().slice(11, 19);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString().slice(11, 19);
}

function getLevelLabel(level?: number): string {
  if (!level) {
    return 'info';
  }

  return PINO_LEVEL_LABELS[level] ?? String(level);
}

function colorizeLevel(level: string): string {
  if (!process.stdout.isTTY) {
    return level;
  }

  const color = LEVEL_COLORS[level];
  if (!color) {
    return level;
  }

  return `${color}${level}${ANSI_RESET}`;
}

function formatConsoleMeta(record: ConsoleLogRecord): string {
  const { level, time, msg, service, pid, hostname, ...meta } = record;

  if (Object.keys(meta).length === 0) {
    return '';
  }

  return ` ${JSON.stringify(meta)}`;
}

function formatConsoleLine(record: ConsoleLogRecord): string {
  const timestamp = getDisplayTime(record.time);
  const level = getLevelLabel(record.level);
  const displayLevel = colorizeLevel(level);
  const message = record.msg ?? '';
  return `${timestamp} [${displayLevel}]: ${message}${formatConsoleMeta(record)}`;
}

function createPrettyConsoleStream(): Writable {
  let buffered = '';

  const flushLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const parsed = JSON.parse(trimmed) as ConsoleLogRecord;
      process.stdout.write(`${formatConsoleLine(parsed)}\n`);
    } catch {
      process.stdout.write(`${trimmed}\n`);
    }
  };

  return new Writable({
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
    }
  });
}

function writeLog(loggerInstance: PinoLogger, level: LogLevel, first: unknown, second?: unknown): void {
  const { msg, meta } = normalizeArgs(first, second);

  switch (level) {
    case 'info':
      if (meta && msg) {
        loggerInstance.info(meta, msg);
      } else if (meta) {
        loggerInstance.info(meta);
      } else if (msg) {
        loggerInstance.info(msg);
      }
      return;
    case 'warn':
      if (meta && msg) {
        loggerInstance.warn(meta, msg);
      } else if (meta) {
        loggerInstance.warn(meta);
      } else if (msg) {
        loggerInstance.warn(msg);
      }
      return;
    case 'error':
      if (meta && msg) {
        loggerInstance.error(meta, msg);
      } else if (meta) {
        loggerInstance.error(meta);
      } else if (msg) {
        loggerInstance.error(msg);
      }
      return;
    case 'debug':
      if (meta && msg) {
        loggerInstance.debug(meta, msg);
      } else if (meta) {
        loggerInstance.debug(meta);
      } else if (msg) {
        loggerInstance.debug(msg);
      }
      return;
  }
}

function wrapLogger(loggerInstance: PinoLogger): AppLogger {
  return {
    info(first: unknown, second?: unknown) {
      writeLog(loggerInstance, 'info', first, second);
    },
    warn(first: unknown, second?: unknown) {
      writeLog(loggerInstance, 'warn', first, second);
    },
    error(first: unknown, second?: unknown) {
      writeLog(loggerInstance, 'error', first, second);
    },
    debug(first: unknown, second?: unknown) {
      writeLog(loggerInstance, 'debug', first, second);
    },
    child(bindings: Record<string, unknown>) {
      return wrapLogger(loggerInstance.child(bindings));
    }
  };
}

const pinoLogger = pino(
  {
    level: getConfiguredLevel(),
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      service: 'mqtt-monitor'
    },
    serializers: {
      err: stdSerializers.err,
      error: stdSerializers.err
    }
  },
  createPrettyConsoleStream()
);

const logger = wrapLogger(pinoLogger);

export default logger;
export { logger, pinoLogger };
