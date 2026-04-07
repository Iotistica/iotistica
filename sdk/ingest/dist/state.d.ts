import type { DeviceState } from './types';
/**
 * Loads persisted device identity (uuid + api key) from a JSON file, or returns
 * null if the file does not exist yet (first run).
 */
export declare function loadState(filePath: string): DeviceState | null;
/**
 * Persists device identity atomically (write-to-temp + rename) so a crash
 * mid-write never leaves a corrupt state file.
 */
export declare function saveState(filePath: string, state: DeviceState): void;
//# sourceMappingURL=state.d.ts.map