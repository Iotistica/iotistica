import { existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

export const CONFIG_DIR = process.env.CONFIG_DIR || '/app/data';
export const DB_PATH = join(CONFIG_DIR, 'agent.sqlite');

const DEVICE_API_PORT = process.env.DEVICE_API_PORT || '48484';
export const DEVICE_API_BASE = process.env.DEVICE_API_URL || `http://localhost:${DEVICE_API_PORT}`;
export const DEVICE_API_V1 = `${DEVICE_API_BASE}/v1`;

export const ENV = {
  isContainer: existsSync('/.dockerenv'),
  hasDocker: (() => {
    try {
      execSync('docker --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })(),
};

export class CLIError extends Error {
  constructor(message: string, public exitCode: number = 1, public context?: Record<string, any>) {
    super(message);
    this.name = 'CLIError';
  }
}

export class CLILogger {
  info(message: string, context?: Record<string, any>): void {
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    console.log(`[INFO] ${message}${contextStr}`);
  }

  error(message: string, error?: Error, context?: Record<string, any>): void {
    const errorStr = error ? ` - ${error.message}` : '';
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    console.error(`[ERROR] ${message}${errorStr}${contextStr}`);
  }

  warn(message: string, context?: Record<string, any>): void {
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    console.warn(`[WARN] ${message}${contextStr}`);
  }

  debug(message: string, context?: Record<string, any>): void {
    if (process.env.DEBUG === 'true') {
      const contextStr = context ? ` ${JSON.stringify(context)}` : '';
      console.log(`[DEBUG] ${message}${contextStr}`);
    }
  }
}

export const logger = new CLILogger();

const apiCache = new Map<string, Promise<any>>();

export async function apiCached(endpoint: string): Promise<any> {
  if (!apiCache.has(endpoint)) {
    apiCache.set(endpoint, apiRequest(endpoint));
  }
  return apiCache.get(endpoint)!;
}

export function clearApiCache(): void {
  apiCache.clear();
}

export async function apiRequest(endpoint: string, options: RequestInit = {}): Promise<any> {
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
  } catch (error) {
    if ((error as any).code === 'ECONNREFUSED') {
      throw new CLIError('Cannot connect to agent', 1, {
        endpoint: DEVICE_API_BASE,
        hint: 'Make sure the agent is running',
      });
    }
    throw error;
  }
}

export async function apiProbe(endpoint: string, options: RequestInit = {}): Promise<{
  ok: boolean;
  status?: number;
  data?: any;
  error?: string;
}> {
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
    let parsed: any = undefined;
    if (text && text !== 'OK') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      data: parsed,
    };
  } catch (error: any) {
    return {
      ok: false,
      error: error.message,
    };
  }
}

export function getFlagValue(flag: string): string | undefined {
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

export function normalizePositionalArg(arg?: string): string | undefined {
  if (!arg || arg.startsWith('--')) {
    return undefined;
  }

  return arg;
}

export function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function requireConfirmation(message: string): void {
  const args = process.argv.slice(2);
  if (!args.includes('--yes')) {
    console.log(`\n⚠️  ${message}`);
    console.log('Use --yes flag to confirm this action\n');
    throw new CLIError('Confirmation required', 1, {
      hint: 'Add --yes flag to confirm',
    });
  }
}

export function redact(value: string | undefined | null): string {
  if (!value || value.length <= 8) {
    return value ? '****' : 'not set';
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getDbSizeMb(): string | null {
  if (!existsSync(DB_PATH)) {
    return null;
  }
  const stats = statSync(DB_PATH);
  return (stats.size / 1024 / 1024).toFixed(2);
}
