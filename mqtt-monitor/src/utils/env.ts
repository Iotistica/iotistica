import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const separatorIndex = trimmed.indexOf('=');
  if (separatorIndex <= 0) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  const value = parseEnvValue(trimmed.slice(separatorIndex + 1));

  if (!key) {
    return null;
  }

  return [key, value];
}

export function loadEnvFile(filePath: string): void {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    return;
  }

  const content = readFileSync(resolvedPath, 'utf-8');
  for (const line of content.split(/\r?\n/u)) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      continue;
    }

    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadDefaultEnvFiles(): void {
  loadEnvFile('.env');

  if (process.env.NODE_ENV) {
    loadEnvFile(`.env.${process.env.NODE_ENV}`);
  }
}
