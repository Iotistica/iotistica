import * as fs from 'fs';
import * as path from 'path';
import type { DeviceState } from './types';

/**
 * Loads persisted device identity (uuid + api key) from a JSON file, or returns
 * null if the file does not exist yet (first run).
 */
export function loadState(filePath: string): DeviceState | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as DeviceState;
  } catch {
    return null;
  }
}

/**
 * Persists device identity atomically (write-to-temp + rename) so a crash
 * mid-write never leaves a corrupt state file.
 */
export function saveState(filePath: string, state: DeviceState): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}
