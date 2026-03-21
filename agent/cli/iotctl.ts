#!/usr/bin/env node
/**
 * iotctl - IoT Control CLI
 * ========================
 * Iotistic device management and configuration tool
 * 
 * Error Handling Pattern:
 *   - Validation errors: throw new CLIError(message, 1, {context})
 *   - API errors: Let apiRequest throw, caught by main()
 *   - Centralized handling: main().catch() handles all errors and calls process.exit
 *   - Benefits: Testable, reusable in scripts/REPLs, clean separation of concerns
 * 
 * TODO: Complete migration of all process.exit(1) calls to throw new CLIError()
 *       Pattern: Replace logger.error() + process.exit(1) with throw new CLIError()
 * 
 * Usage:
 *   iotctl provision <key>            - Provision device with cloud
 *   iotctl config set-api <url>       - Update cloud API endpoint
 *   iotctl config get-api             - Show current API endpoint
 *   iotctl config show                - Show all configuration
 *   iotctl status                     - Show device status
 *   iotctl apps list                  - List all applications
 *   iotctl apps start <appId>         - Start an application
 *   iotctl apps stop <appId>          - Stop an application
 *   iotctl apps restart <appId>       - Restart an application
 *   iotctl db backup                  - Create SQLite backup
 *   iotctl db list                    - List SQLite backups
 *   iotctl db verify latest           - Verify backup integrity/checksum
 *   iotctl db restore <file> --yes    - Restore from backup
 *   iotctl db prune --keep 24         - Prune old backups
 *   iotctl buffer status              - Show offline buffer summary
 *   iotctl help                       - Show this help
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { spawn, execSync } from 'child_process';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';


// Configuration paths
const CONFIG_DIR = process.env.CONFIG_DIR || '/app/data';
const DB_PATH = join(CONFIG_DIR, 'device.sqlite');

// Device API endpoint - construct from DEVICE_API_PORT or fall back to DEVICE_API_URL
const DEVICE_API_PORT = process.env.DEVICE_API_PORT || '48484';
const DEVICE_API_BASE = process.env.DEVICE_API_URL || `http://localhost:${DEVICE_API_PORT}`;
const DEVICE_API_V1 = `${DEVICE_API_BASE}/v1`;

// Environment detection (once at startup)
const ENV = {
	isContainer: existsSync('/.dockerenv'),
	hasDocker: (() => {
		try {
			execSync('docker --version', { stdio: 'ignore' });
			return true;
		} catch {
			return false;
		}
	})()
};

// ============================================================================
// Error Handling
// ============================================================================

/**
 * CLIError - Custom error for CLI operations
 * 
 * Usage Pattern (New - Preferred):
 *   // Input validation
 *   if (!input) {
 *     throw new CLIError('Message', 1, { context });
 *   }
 * 
 *   // Operation failure
 *   catch (error) {
 *     throw new CLIError('Operation failed', 1);
 *   }
 * 
 * Old Pattern (Still exists in ~40 places - TODO: migrate):
 *   logger.error('Message', error, { context });
 *   process.exit(1);
 * 
 * Benefits:
 *   - Testable: Functions can be unit tested without process.exit
 *   - Reusable: Can embed CLI in scripts/REPLs without exiting process
 *   - Centralized: All errors handled in main().catch()
 */
class CLIError extends Error {
	constructor(message: string, public exitCode: number = 1, public context?: Record<string, any>) {
		super(message);
		this.name = 'CLIError';
	}
}

class CLILogger {
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

const logger = new CLILogger();

interface DeviceConfig {
	cloudApiEndpoint?: string;
	pollInterval?: number;
	reportInterval?: number;
	metricsInterval?: number;
	enableRemoteAccess?: boolean;
	deviceName?: string;
	[key: string]: any;
}

type DbBackupServiceModule = {
	getDefaultBackupDir: (dbPath: string) => string;
	createDbBackup: (params: { dbPath: string; backupDir?: string; name?: string }) => Promise<any>;
	listDbBackups: (params: { backupDir: string }) => Array<any>;
	verifyDbBackup: (params: { backupPath: string; requireMetadata?: boolean }) => Promise<any>;
	restoreDbFromBackup: (params: {
		dbPath: string;
		backupPath: string;
		backupDir?: string;
		createPreRestoreBackup?: boolean;
	}) => Promise<any>;
	pruneDbBackups: (params: { backupDir: string; keep: number }) => { deleted: string[]; kept: number };
};

let dbBackupServiceCache: DbBackupServiceModule | null = null;

async function loadDbBackupService(): Promise<DbBackupServiceModule> {
	if (dbBackupServiceCache) {
		return dbBackupServiceCache;
	}

	const candidates = [
		join(__dirname, '..', 'db', 'backup-service.js'),
		join(__dirname, '..', 'src', 'db', 'backup-service.js'),
		join(process.cwd(), 'dist', 'db', 'backup-service.js'),
		join(process.cwd(), 'dist', 'src', 'db', 'backup-service.js'),
		join(process.cwd(), 'src', 'db', 'backup-service.js'),
	];

	for (const candidatePath of candidates) {
		if (!existsSync(candidatePath)) {
			continue;
		}

		const loaded = require(candidatePath);
		const service = loaded as DbBackupServiceModule;

		if (
			typeof service.createDbBackup === 'function' &&
			typeof service.listDbBackups === 'function' &&
			typeof service.verifyDbBackup === 'function' &&
			typeof service.restoreDbFromBackup === 'function' &&
			typeof service.pruneDbBackups === 'function'
		) {
			dbBackupServiceCache = service;
			return service;
		}
	}

	throw new CLIError('DB backup service module not found', 1, {
		hint: 'Run npm run build so dist/db/backup-service.js is available',
	});
}

function getFlagValue(flag: string): string | undefined {
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

function normalizePositionalArg(arg?: string): string | undefined {
	if (!arg || arg.startsWith('--')) {
		return undefined;
	}

	return arg;
}

function resolveBackupPathFromTarget(
	backups: Array<{ fileName: string; backupPath: string }>,
	target?: string,
): string {
	if (backups.length === 0) {
		throw new CLIError('No backups found', 1, {
			hint: 'Run iotctl db backup first',
		});
	}

	if (!target || target === 'latest') {
		return backups[0].backupPath;
	}

	if (existsSync(target)) {
		return target;
	}

	const byName = backups.find((item) => item.fileName === target);
	if (byName) {
		return byName.backupPath;
	}

	throw new CLIError('Backup target not found', 1, {
		target,
		hint: 'Use iotctl db list to see available backups',
	});
}

async function dbBackup(nameArg?: string): Promise<void> {
	const service = await loadDbBackupService();
	const backupDir = service.getDefaultBackupDir(DB_PATH);
	const name = normalizePositionalArg(nameArg) || getFlagValue('--name');

	const result = await service.createDbBackup({
		dbPath: DB_PATH,
		backupDir,
		name,
	});

	logger.info('Database backup created', {
		file: result.fileName,
		path: result.backupPath,
		sizeBytes: result.sizeBytes,
		checksumSha256: result.checksumSha256,
	});
}

async function dbList(): Promise<void> {
	const service = await loadDbBackupService();
	const backupDir = service.getDefaultBackupDir(DB_PATH);
	const backups = service.listDbBackups({ backupDir });

	if (backups.length === 0) {
		logger.info('No database backups found', { backupDir });
		return;
	}

	logger.info('Database backups', {
		backupDir,
		count: backups.length,
	});

	for (const backup of backups) {
		logger.info(backup.fileName, {
			createdAt: backup.createdAt,
			sizeBytes: backup.sizeBytes,
			checksumSha256: backup.checksumSha256 || 'metadata-missing',
		});
	}
}

async function dbVerify(targetArg?: string): Promise<void> {
	const service = await loadDbBackupService();
	const backupDir = service.getDefaultBackupDir(DB_PATH);
	const backups = service.listDbBackups({ backupDir });
	const targetPath = resolveBackupPathFromTarget(
		backups,
		normalizePositionalArg(targetArg) || getFlagValue('--target')
	);

	const result = await service.verifyDbBackup({
		backupPath: targetPath,
		requireMetadata: true,
	});

	if (!result.ok) {
		throw new CLIError('Backup verification failed', 1, {
			backupPath: targetPath,
			integrity: result.integrity,
			checksumMatch: result.checksumMatch,
		});
	}

	logger.info('Backup verified', {
		backupPath: targetPath,
		integrity: result.integrity,
		checksumSha256: result.checksumCurrent,
	});
}

async function dbRestore(targetArg?: string): Promise<void> {
	requireConfirmation('Database restore will overwrite current SQLite data.');

	const liveAllowed = process.argv.includes('--force-live');
	if (!liveAllowed) {
		const probe = await apiProbe(`${DEVICE_API_V1}/healthy`);
		if (probe.ok) {
			throw new CLIError('Refusing restore while agent API is reachable', 1, {
				hint: 'Stop the agent first or pass --force-live to override',
			});
		}
	}

	const service = await loadDbBackupService();
	const backupDir = service.getDefaultBackupDir(DB_PATH);
	const backups = service.listDbBackups({ backupDir });
	const targetPath = resolveBackupPathFromTarget(
		backups,
		normalizePositionalArg(targetArg) || getFlagValue('--target')
	);

	const result = await service.restoreDbFromBackup({
		dbPath: DB_PATH,
		backupPath: targetPath,
		backupDir,
		createPreRestoreBackup: true,
	});

	logger.info('Database restore completed', {
		restoredPath: result.restoredPath,
		preRestoreBackupPath: result.preRestoreBackupPath,
		checksumSha256: result.checksumSha256,
	});
}

async function dbPrune(keepArg?: string): Promise<void> {
	const service = await loadDbBackupService();
	const backupDir = service.getDefaultBackupDir(DB_PATH);
	const keepValue = normalizePositionalArg(keepArg) || getFlagValue('--keep') || '24';
	const keep = Number.parseInt(keepValue, 10);

	if (!Number.isFinite(keep) || keep < 1) {
		throw new CLIError('Invalid --keep value', 1, {
			keep: keepValue,
			hint: 'Use an integer >= 1',
		});
	}

	const result = service.pruneDbBackups({ backupDir, keep });
	logger.info('Database backup prune complete', {
		backupDir,
		kept: result.kept,
		deletedCount: result.deleted.length,
		deleted: result.deleted,
	});
}

// ============================================================================
// Device API Client with Request Coalescing
// ============================================================================

// In-memory cache for API responses during a single CLI invocation
// Prevents duplicate API calls when multiple commands query the same endpoint
// Cache is cleared between CLI invocations (process exit)
const apiCache = new Map<string, Promise<any>>();

/**
 * Cached API request - prevents duplicate calls to same endpoint
 * Use this instead of apiRequest() for idempotent GET requests
 */
async function apiCached(endpoint: string): Promise<any> {
	if (!apiCache.has(endpoint)) {
		apiCache.set(endpoint, apiRequest(endpoint));
	}
	return apiCache.get(endpoint)!;
}

/**
 * Clear API cache (called before each command)
 * Ensures fresh data for each CLI invocation
 */
function clearApiCache(): void {
	apiCache.clear();
}

async function apiRequest(endpoint: string, options: RequestInit = {}): Promise<any> {
	try {
		const response = await fetch(endpoint, {
			...options,
			headers: {
				'Content-Type': 'application/json',
				...options.headers,
			},
			// Default 5s timeout for edge devices (prevents hangs)
			signal: options.signal ?? AbortSignal.timeout(5000)
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`HTTP ${response.status}: ${error}`);
		}

		// Handle empty responses
		const text = await response.text();
		if (!text || text === 'OK') {
			return { success: true };
		}

		// Parse and normalize response (unwrap .Data if present)
		const json = JSON.parse(text);
		return json.Data ?? json;
	} catch (error) {
		if ((error as any).code === 'ECONNREFUSED') {
			throw new CLIError('Cannot connect to agent', 1, {
				endpoint: DEVICE_API_BASE,
				hint: 'Make sure the agent is running'
			});
		}
		throw error;
	}
}

async function apiProbe(endpoint: string, options: RequestInit = {}): Promise<{
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

const RESTART_POLL_INTERVAL_MS = 1000;
const RESTART_WAIT_TIMEOUT_MS = 60000;

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function summarizeRestartState(state: string, ready: boolean): string {
	switch (state) {
		case 'STOPPING':
			return 'Stopping runtime services';
		case 'STOPPED':
			return 'Runtime services stopped, waiting to reinitialize';
		case 'INIT':
			return 'Initializing core services';
		case 'READY':
			return 'Core initialization complete';
		case 'RUNNING':
			return ready ? 'Restart complete' : 'Final readiness checks still running';
		case 'ERROR':
			return 'Restart entered error state';
		default:
			return ready ? 'Restart in progress, agent reports ready' : 'Restart in progress';
	}
}

async function waitForRestartCompletion(initialState: string): Promise<void> {
	const startedAt = Date.now();
	let lastState = initialState;
	let lastReady: boolean | undefined;
	let sawTransition = false;

	while (Date.now() - startedAt < RESTART_WAIT_TIMEOUT_MS) {
		const readiness = await apiProbe(`${DEVICE_API_V1}/readiness`);
		const state = readiness.data?.state || readiness.data?.lifecycleState || (readiness.ok ? 'UNKNOWN' : 'UNREACHABLE');
		const ready = readiness.data?.ready === true;
		const criticalFailures = Array.isArray(readiness.data?.criticalFailures)
			? readiness.data.criticalFailures
			: undefined;

		if (state !== lastState || ready !== lastReady) {
			sawTransition = true;
			logger.info('Restart progress', {
				state,
				ready,
				phase: summarizeRestartState(state, ready),
				...(criticalFailures && criticalFailures.length > 0 ? { criticalFailures } : {})
			});
			lastState = state;
			lastReady = ready;
		}

		if (state === 'RUNNING' && ready) {
			logger.info('Agent services restarted', {
				state,
				ready,
				elapsedMs: Date.now() - startedAt
			});
			return;
		}

		if (state === 'ERROR') {
			throw new CLIError('Agent entered ERROR state during restart', 1, {
				criticalFailures,
				elapsedMs: Date.now() - startedAt
			});
		}

		await sleep(RESTART_POLL_INTERVAL_MS);
	}

	throw new CLIError('Timed out waiting for agent restart to complete', 1, {
		lastState,
		lastReady,
		sawTransition,
		timeoutMs: RESTART_WAIT_TIMEOUT_MS,
		hint: 'Check agent logs or run iotctl status for current lifecycle state'
	});
}

// ============================================================================
// Utility Functions
// ============================================================================

function validateUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * Require confirmation for dangerous operations
 * Checks for --yes flag, otherwise prompts user and exits
 */
function requireConfirmation(message: string): void {
	const args = process.argv.slice(2);
	if (!args.includes('--yes')) {
		console.log(`\n⚠️  ${message}`);
		console.log('Use --yes flag to confirm this action\n');
		throw new CLIError('Confirmation required', 1, {
			hint: 'Add --yes flag to confirm'
		});
	}
}

/**
 * Redact sensitive values for safe logging
 * Shows first 4 and last 4 characters, redacts the middle
 */
function redact(value: string | undefined | null): string {
	if (!value || value.length <= 8) {
		return value ? '****' : 'not set';
	}
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

// ============================================================================
// Commands
// ============================================================================

function showHelp(): void {
	console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                           iotctl - IoT Control                             ║
║                        Iotistica Device Management CLI                      ║
╚═══════════════════════════════════════════════════════════════════════════╝

PROVISIONING COMMANDS:

  provision <key>                   Provision device with provisioning key
                                    Options: --api <endpoint> --name <name> --type <type>
                                    Example: iotctl provision abc123 --api https://api.iotistic.com

  provision status                  Show device provisioning status

  deprovision [--yes]               Remove cloud registration (keeps UUID and deviceApiKey)
                                    Clears: deviceId, MQTT credentials, cloud endpoint
                                    Preserves: UUID, deviceApiKey for re-provisioning
                                    --yes : Skip confirmation prompt

  factory-reset [--yes]             WARNING: Complete data wipe
                                    Deletes: All apps, services, state, sensors, credentials
                                    Preserves: Only device UUID
                                    This action cannot be undone!
                                    --yes : Skip confirmation prompt

CONFIGURATION COMMANDS:

  config set-api <url>              Update cloud API endpoint
                                    Example: iotctl config set-api https://api.example.com

  config get-api                    Show current API endpoint

  config set <key> <value>          Set any configuration value
                                    Example: iotctl config set pollInterval 60000

  config get <key>                  Get specific configuration value

  config show                       Show all configuration settings

  config reset                      Reset to default configuration


DEVICE MANAGEMENT:

	status                            Show device status, lifecycle state, and health

  restart                           Restart agent services (API and MQTT stay running)

  logs [--follow] [-n <lines>]      Show device logs
                                    --follow, -f : Follow log output
                                    -n <lines>   : Number of lines to show


CONTAINER/APPLICATION MANAGEMENT:

  apps list                         List all applications and their services

  apps start <appId>                Start all services in an application

  apps stop <appId>                 Stop all services in an application

  apps restart <appId>              Restart all services in an application

  apps info <appId>                 Show application details

  apps purge <appId> [--yes]        Purge application data (volumes)
                                    --yes : Skip confirmation prompt

  services list [<appId>]           List all services (optionally filtered by app)

  services start <serviceId>        Start a specific service container

  services stop <serviceId>         Stop a specific service container

  services restart <serviceId>      Restart a specific service container

  services logs <serviceId> [-f]    View logs from a specific service
                                    -f, --follow : Follow log output

  services info <serviceId>         Show detailed service information


SYSTEM:

	diagnostics, diag                 Run system diagnostics (API, lifecycle, database, MQTT, cloud)

	buffer status                     Show offline buffer summary

	db backup [--name <name>]         Create SQLite backup with integrity and checksum gates

	db list                           List available SQLite backups

	db verify [<file>|latest]         Verify backup integrity and checksum metadata

	db restore <file|latest> [--yes]  Restore SQLite backup with pre-restore safety backup
																		Use --force-live to override API-running safety gate

	db prune [--keep <count>]         Prune old backups (default keep: 24)

  help                              Show this help message

  version                           Show CLI version


EXAMPLES:

  # Set cloud API endpoint
  iotctl config set-api https://cloud.iotistic.ca

  # View current configuration
  iotctl config show

  # Check device status
  iotctl status

  # List all running applications and services
  iotctl apps list

  # Start/stop entire application stack
  iotctl apps start 1001
  iotctl apps stop 1001

  # List all services (containers)
  iotctl services list

  # List services for specific app
  iotctl services list 1001


DISCOVERY:

  discover [protocol]               Run device discovery for all or specific protocol
                                    Protocols: modbus, opcua, snmp, mqtt, bacnet, can
                                    --validate : Include validation phase (slower, reads device info)
                                    --protocol <name> : Specify protocol to discover
                                    Examples:
                                      iotctl discover                    # All protocols
                                      iotctl discover modbus             # Modbus only


DEVICES (SENSORS):

  devices list [protocol]           List all configured devices/sensors
                                    Optional protocol filter: modbus, opcua, mqtt, can, snmp, bacnet
                                    Examples:
                                      iotctl devices list                # All devices
                                      iotctl devices list modbus         # Modbus devices only

  devices show <name>               Show detailed device information including
                                    connection details, data points, and metadata
                                      iotctl discover --validate         # All with validation
                                      iotctl discover --protocol=snmp    # SNMP only


MQTT MANAGEMENT:

  mqtt users                        List all MQTT users from device database
                                    Shows: username, superuser status, active status
                                    Example: iotctl mqtt users


EXAMPLES:

  # Manage individual service container
  iotctl services start myapp-web-1
  iotctl services restart myapp-api-2
  iotctl services logs myapp-web-1 -f

  # Follow agent logs in real-time
  iotctl logs --follow

  # Set custom poll interval (60 seconds)
  iotctl config set pollInterval 60000

  # List MQTT users synced from target endpoints
  iotctl mqtt users

`);
}

async function configSetApi(url: string): Promise<void> {
	if (!url) {
		throw new CLIError('API URL is required', 1, {
			usage: 'iotctl config set-api <url>'
		});
	}
	
	if (!validateUrl(url)) {
		throw new CLIError('Invalid URL format', 1, {
			hint: 'URL must start with http:// or https://'
		});
	}
	
	// Remove trailing slash
	url = url.replace(/\/$/, '');
	
	try {
		await apiRequest(`${DEVICE_API_V1}/config`, {
			method: 'POST',
			body: JSON.stringify({ cloudApiEndpoint: url })
		});
		
		logger.info('Cloud API endpoint updated', { endpoint: url });
		logger.warn('Restart required', {
			hint: 'Run: iotctl restart'
		});
	} catch (error) {
		throw new CLIError('Failed to update API endpoint', 1);
	}
}

async function configGetApi(): Promise<void> {
	clearApiCache(); // Ensure fresh data
	try {
		const provisionStatus = await apiCached(`${DEVICE_API_V1}/provision/status`);
		
		if (provisionStatus.apiEndpoint) {
			logger.info('Cloud API Endpoint', { endpoint: provisionStatus.apiEndpoint });
		} else {
			logger.warn('Cloud API endpoint not configured');
		}
	} catch (error) {
		throw new CLIError('Failed to retrieve API endpoint', 1);
	}
}

async function configSet(key: string, value: string): Promise<void> {
	if (!key || !value) {
		logger.error('Both key and value are required', undefined, {
			usage: 'iotctl config set <key> <value>'
		});
		process.exit(1);
	}
	
	// Try to parse as JSON (for numbers, booleans, objects)
	let parsedValue: any = value;
	try {
		parsedValue = JSON.parse(value);
	} catch {
		// Keep as string if not valid JSON
	}
	
	try {
		await apiRequest(`${DEVICE_API_V1}/config`, {
			method: 'POST',
			body: JSON.stringify({ [key]: parsedValue })
		});
		
		logger.info('Configuration updated', { key, value: parsedValue });
	} catch (error) {
		logger.error('Failed to update configuration', error as Error);
		process.exit(1);
	}
}

async function configGet(key: string): Promise<void> {
	if (!key) {
		logger.error('Key is required', undefined, {
			usage: 'iotctl config get <key>'
		});
		process.exit(1);
	}
	
	clearApiCache(); // Ensure fresh data for this command
	try {
		const deviceState = await apiCached(`${DEVICE_API_V1}/device`);
		const config = deviceState.config || {};
		
		if (key in config) {
			logger.info('Configuration value', { key, value: config[key] });
		} else {
			logger.warn('Configuration key not found', { key });
		}
	} catch (error) {
		logger.error('Failed to retrieve configuration', error as Error);
		process.exit(1);
	}
}

async function configShow(): Promise<void> {
	clearApiCache(); // Ensure fresh data for this command
	try {
		// Get device state from API (cached)
		const deviceState = await apiCached(`${DEVICE_API_V1}/device`);
		
		// Get provision status for additional config (cached)
		const provisionStatus = await apiCached(`${DEVICE_API_V1}/provision/status`);
		
		const config = {
			uuid: redact(deviceState.uuid),
			deviceId: redact(provisionStatus.deviceId),
			deviceName: provisionStatus.deviceName || 'not set',
			cloudApiEndpoint: provisionStatus.apiEndpoint || 'not configured',
			mqttConfigured: provisionStatus.mqttConfigured || false,
			provisioned: provisionStatus.provisioned || false,
			online: deviceState.is_online || false,
			version: deviceState.version || 0
		};
		
		logger.info('Device Configuration', config);
	} catch (error) {
		logger.error('Failed to retrieve configuration', error as Error, {
			hint: 'Ensure the agent is running'
		});
	}
}

async function configReset(): Promise<void> {
	try {
		await apiRequest(`${DEVICE_API_V1}/factory-reset`, {
			method: 'POST'
		});
		logger.info('Configuration reset to factory defaults');
		logger.warn('Device needs to be re-provisioned');
	} catch (error) {
		logger.error('Failed to reset configuration', error as Error);
		process.exit(1);
	}
}

async function showStatusEnhanced(): Promise<void> {
	clearApiCache(); // Ensure fresh data for this command
	logger.info('Checking device health...');
	
	try {
		// Read lifecycle/readiness from dedicated health endpoints
		const [healthyProbe, readinessProbe, healthReportProbe] = await Promise.all([
			apiProbe(`${DEVICE_API_V1}/healthy`),
			apiProbe(`${DEVICE_API_V1}/readiness`),
			apiProbe(`${DEVICE_API_V1}/health/report`),
		]);
		const healthyPayload = healthyProbe.data || {};
		const readinessPayload = readinessProbe.data || {};
		const healthReportPayload = healthReportProbe.data || {};
		const report = healthReportPayload.report || {};
		const criticalFailures = Array.isArray(report.criticalFailures) ? report.criticalFailures : [];
		const unhealthySubsystems = Array.isArray(report.unhealthySubsystems) ? report.unhealthySubsystems : [];

		// Check agent API connectivity (cached)
		const deviceState = await apiCached(`${DEVICE_API_V1}/device`);
		logger.info('Agent running', {
			uuid: redact(deviceState.uuid),
			online: deviceState.is_online
		});

		logger.info('Lifecycle', {
			state: healthyPayload.state || readinessPayload.state || healthyPayload.lifecycleState || readinessPayload.lifecycleState || 'UNKNOWN',
			ready: readinessPayload.ready === true,
			health: healthyPayload.status || 'unknown',
			criticalFailures,
			unhealthySubsystems,
		});
		
		// Environment info
		logger.info('Environment', {
			isContainer: ENV.isContainer,
			hasDocker: ENV.hasDocker
		});
		
		// Count apps
		const apps = deviceState.apps || {};
		const appCount = Object.keys(apps).length;
		
		// Show running services count
		let runningCount = 0;
		for (const appId in apps) {
			const app = apps[appId];
			if (app.services) {
				runningCount += app.services.filter((s: any) => s.status === 'Running').length;
			}
		}
		
		logger.info('Applications', {
			configured: appCount,
			runningServices: runningCount
		});
		
		// Cloud connection info from provision status
		try {
			const provisionStatus = await apiRequest(`${DEVICE_API_V1}/provision/status`);
			if (provisionStatus.apiEndpoint) {
				logger.info('Cloud connection', {
					endpoint: provisionStatus.apiEndpoint,
					status: deviceState.is_online ? 'Connected' : 'Disconnected'
				});
			}
		} catch {
			// Ignore if provision status unavailable
		}
		
		// Database size
		if (existsSync(DB_PATH)) {
			const stats = statSync(DB_PATH);
			logger.info('Database', {
				size_mb: (stats.size / 1024 / 1024).toFixed(2)
			});
		}
	} catch (error) {
		logger.error('Agent not running or unreachable', error as Error, {
			hint: `Verify DEVICE_API_PORT/DEVICE_API_URL and confirm device API is listening (current target: ${DEVICE_API_BASE})`
		});
	}
}

function formatMaybeAge(hours?: number): string {
	if (hours === undefined || hours === null) {
		return 'n/a';
	}
	return `${hours}h`;
}

function formatMaybeTime(value?: string): string {
	if (!value) {
		return 'never';
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return date.toLocaleString();
}

async function bufferStatus(): Promise<void> {
	clearApiCache();
	logger.info('Checking offline buffer status...');

	try {
		const result = await apiRequest(`${DEVICE_API_V1}/buffer/status`);

		logger.info('Buffer mode', { mode: result.mode });
		logger.info('Cloud report buffer', {
			cloudReportQueueCount: result.cloudReportQueueCount,
			cloudReportOldestAge: formatMaybeAge(result.cloudReportOldestAge),
			lastFlushAttempt: formatMaybeTime(result.lastFlushAttempt),
			lastFlushSuccess: formatMaybeTime(result.lastFlushSuccess),
		});
		logger.info('MQTT message buffer', {
			mqttMessageBufferCount: result.mqttMessageBufferCount,
			mqttBufferBytes: result.mqttBufferBytes,
			mqttBufferOldestAge: formatMaybeAge(result.mqttBufferOldestAge),
		});

		if (result.agentLogBufferEnabled) {
			logger.info('Agent log buffer', {
				agentLogBufferLogs: result.agentLogBufferLogs,
				agentLogBufferBytes: result.agentLogBufferBytes,
				agentLogPendingBatches: result.agentLogPendingBatches,
				agentLogDroppedTotal: result.agentLogDroppedTotal,
				agentLogCircuitOpen: result.agentLogCircuitOpen,
				agentLogLastFlushAttempt: formatMaybeTime(result.agentLogLastFlushAttempt),
				agentLogLastFlushSuccess: formatMaybeTime(result.agentLogLastFlushSuccess),
				agentLogLastFlushError: result.agentLogLastFlushError || 'none',
			});
		} else {
			logger.info('Agent log buffer', {
				status: 'not-enabled'
			});
		}
	} catch (error) {
		logger.error('Failed to read buffer status', error as Error);
	}
}

// ============================================================================
// Application/Container Commands
// ============================================================================

async function appsList(): Promise<void> {
	clearApiCache(); // Ensure fresh data
	try {
		const deviceState = await apiCached(`${DEVICE_API_V1}/device`);
		const apps = deviceState.apps || {};
		
		if (Object.keys(apps).length === 0) {
			logger.info('No applications configured');
			return;
		}
		
		logger.info('Applications');
		
		for (const appId in apps) {
			const app = apps[appId];
			const appInfo: any = {
				appId,
				appName: app.appName || 'Unknown'
			};
			
			if (app.services && app.services.length > 0) {
				appInfo.services = app.services.map((service: any) => ({
					name: service.serviceName,
					status: service.status,
					containerId: service.containerId?.substring(0, 12)
				}));
			}
			
			logger.info(`App ${appId}`, appInfo);
		}
	} catch (error) {
		logger.error('Failed to list applications', error as Error);
		process.exit(1);
	}
}

async function appsStart(appId: string): Promise<void> {
	if (!appId) {
		logger.error('Application ID is required', undefined, {
			usage: 'iotctl apps start <appId>'
		});
		process.exit(1);
	}
	
	try {
		logger.info('Starting application', { appId });
		const result = await apiRequest(`${DEVICE_API_V1}/apps/${appId}/start`, {
			method: 'POST',
			body: JSON.stringify({ force: false })
		});
		
		logger.info('Application started', { 
			appId, 
			containerId: result.containerId 
		});
	} catch (error) {
		logger.error('Failed to start application', error as Error, { appId });
		process.exit(1);
	}
}

async function appsStop(appId: string): Promise<void> {
	if (!appId) {
		logger.error('Application ID is required', undefined, {
			usage: 'iotctl apps stop <appId>'
		});
		process.exit(1);
	}
	
	try {
		logger.info('Stopping application', { appId });
		const result = await apiRequest(`${DEVICE_API_V1}/apps/${appId}/stop`, {
			method: 'POST',
			body: JSON.stringify({ force: false })
		});
		
		logger.info('Application stopped', { 
			appId, 
			containerId: result.containerId 
		});
	} catch (error) {
		logger.error('Failed to stop application', error as Error, { appId });
		process.exit(1);
	}
}

async function appsRestart(appId: string): Promise<void> {
	if (!appId) {
		logger.error('Application ID is required', undefined, {
			usage: 'iotctl apps restart <appId>'
		});
		process.exit(1);
	}
	
	try {
		logger.info('Restarting application', { appId });
		await apiRequest(`${DEVICE_API_V1}/restart`, {
			method: 'POST',
			body: JSON.stringify({ appId, force: false })
		});
		
		logger.info('Application restarted', { appId });
	} catch (error) {
		logger.error('Failed to restart application', error as Error, { appId });
		process.exit(1);
	}
}

async function appsInfo(appId: string): Promise<void> {
	if (!appId) {
		logger.error('Application ID is required', undefined, {
			usage: 'iotctl apps info <appId>'
		});
		process.exit(1);
	}
	
	try {
		const app = await apiRequest(`${DEVICE_API_V1}/apps/${appId}`);
		logger.info('Application details', { appId, details: app });
	} catch (error) {
		logger.error('Failed to get application info', error as Error, { appId });
		process.exit(1);
	}
}

async function appsPurge(appId: string): Promise<void> {
	if (!appId) {
		logger.error('Application ID is required', undefined, {
			usage: 'iotctl apps purge <appId>'
		});
		process.exit(1);
	}
	
	try {
		logger.warn('Purging application data', { 
			appId,
			warning: 'This removes all volumes and data'
		});
		
		// Require explicit confirmation
		requireConfirmation(`Purge will remove ALL data for app ${appId}. This cannot be undone.`);
		
		await apiRequest(`${DEVICE_API_V1}/purge`, {
			method: 'POST',
			body: JSON.stringify({ appId, force: true })
		});
		
		logger.info('Application data purged', { appId });
	} catch (error) {
		logger.error('Failed to purge application', error as Error, { appId });
		process.exit(1);
	}
}

// ============================================================================
// Service/Container Commands
// ============================================================================

async function servicesList(appId?: string): Promise<void> {
	clearApiCache(); // Ensure fresh data
	try {
		const deviceState = await apiCached(`${DEVICE_API_V1}/device`);
		const apps = deviceState.apps || {};
		
		let totalServices = 0;
		
		for (const currentAppId in apps) {
			// Filter by appId if provided
			if (appId && currentAppId !== appId) {
				continue;
			}
			
			const app = apps[currentAppId];
			const services = app.services || [];
			
			if (services.length === 0) {
				continue;
			}
			
			logger.info(`App ${currentAppId} (${app.appName || 'Unknown'})`, {
				serviceCount: services.length
			});
			
			for (const service of services) {
				logger.info(`  Service: ${service.serviceName}`, {
					serviceId: service.serviceId,
					status: service.status,
					containerId: service.containerId?.substring(0, 12),
					image: service.imageName,
					state: service.state || 'running'
				});
				totalServices++;
			}
		}
		
		if (totalServices === 0) {
			if (appId) {
				logger.info('No services found for application', { appId });
			} else {
				logger.info('No services configured');
			}
		} else {
			logger.info(`Total services: ${totalServices}`);
		}
	} catch (error) {
		logger.error('Failed to list services', error as Error);
		process.exit(1);
	}
}

async function servicesStart(serviceId: string): Promise<void> {
	if (!serviceId) {
		logger.error('Service ID is required', undefined, {
			usage: 'iotctl services start <serviceId>'
		});
		process.exit(1);
	}
	
	try {
		logger.info('Starting service', { serviceId });
		const result = await apiRequest(`${DEVICE_API_V1}/services/${serviceId}/start`, {
			method: 'POST'
		});
		
		logger.info('Service started', {
			serviceId,
			containerId: result.containerId,
			status: result.status
		});
	} catch (error) {
		logger.error('Failed to start service', error as Error, { serviceId });
		process.exit(1);
	}
}

async function servicesStop(serviceId: string): Promise<void> {
	if (!serviceId) {
		logger.error('Service ID is required', undefined, {
			usage: 'iotctl services stop <serviceId>'
		});
		process.exit(1);
	}
	
	try {
		logger.info('Stopping service', { serviceId });
		const result = await apiRequest(`${DEVICE_API_V1}/services/${serviceId}/stop`, {
			method: 'POST'
		});
		
		logger.info('Service stopped', {
			serviceId,
			containerId: result.containerId,
			status: result.status
		});
	} catch (error) {
		logger.error('Failed to stop service', error as Error, { serviceId });
		process.exit(1);
	}
}

async function servicesRestart(serviceId: string): Promise<void> {
	if (!serviceId) {
		logger.error('Service ID is required', undefined, {
			usage: 'iotctl services restart <serviceId>'
		});
		process.exit(1);
	}
	
	try {
		logger.info('Restarting service', { serviceId });
		const result = await apiRequest(`${DEVICE_API_V1}/services/${serviceId}/restart`, {
			method: 'POST'
		});
		
		logger.info('Service restarted', {
			serviceId,
			containerId: result.containerId,
			status: result.status
		});
	} catch (error) {
		logger.error('Failed to restart service', error as Error, { serviceId });
		process.exit(1);
	}
}

async function servicesLogs(serviceId: string, follow: boolean = false): Promise<void> {
	clearApiCache();
	if (!serviceId) {
		logger.error('Service ID is required', undefined, {
			usage: 'iotctl services logs <serviceId> [-f]'
		});
		process.exit(1);
	}
	
	try {
		// TODO: API Optimization - Over-fetching entire device state
		// Current: Fetch entire device graph just to find one service's containerId
		// Better: GET /v1/services/:id (returns single service with containerId)
		// Alternative: GET /v1/device?include=apps.services (filtered response)
		// Impact: Reduces payload size and parsing time, especially with many apps/services
		const deviceState = await apiCached(`${DEVICE_API_V1}/device`);
		const apps = deviceState.apps || {};
		
		let containerId: string | undefined;
		for (const appId in apps) {
			const services = apps[appId].services || [];
			const service = services.find((s: any) => s.serviceId === serviceId);
			if (service) {
				containerId = service.containerId;
				break;
			}
		}
		
		if (!containerId) {
			logger.error('Service not found', undefined, { serviceId });
			process.exit(1);
		}
		
		// Check if Docker is available
		if (!ENV.hasDocker) {
			throw new CLIError('Docker is not available', 1, {
				hint: 'Install Docker or ensure it is in your PATH'
			});
		}
		
		logger.info('Service logs', { serviceId, containerId: containerId.substring(0, 12) });
		
		// Use docker logs command
		const args = ['logs'];
		if (follow) {
			args.push('-f');
		} else {
			args.push('--tail', '100');
		}
		args.push(containerId);
		
		const docker = spawn('docker', args, {
			stdio: 'inherit'
		});
		
		docker.on('error', (err) => {
			logger.error('Failed to get service logs', err, {
				hint: `docker logs ${containerId}`
			});
			process.exit(1);
		});
	} catch (error) {
		logger.error('Failed to retrieve service logs', error as Error, { serviceId });
		process.exit(1);
	}
}

async function servicesInfo(serviceId: string): Promise<void> {
	clearApiCache();
	if (!serviceId) {
		logger.error('Service ID is required', undefined, {
			usage: 'iotctl services info <serviceId>'
		});
		process.exit(1);
	}
	
	try {
		// TODO: API Optimization - Over-fetching entire device state
		// Current: Fetch entire device graph just to find one service's details
		// Better: GET /v1/services/:id (returns single service object)
		// Alternative: GET /v1/device?include=apps.services (filtered response)
		// Impact: Reduces payload size and parsing time, especially with many apps/services
		const deviceState = await apiCached(`${DEVICE_API_V1}/device`);
		const apps = deviceState.apps || {};
		
		for (const appId in apps) {
			const app = apps[appId];
			const services = app.services || [];
			const service = services.find((s: any) => s.serviceId === serviceId);
			
			if (service) {
				logger.info('Service details', {
					serviceId: service.serviceId,
					serviceName: service.serviceName,
					appId: appId,
					appName: app.appName,
					status: service.status,
					state: service.state || 'running',
					containerId: service.containerId,
					imageName: service.imageName,
					ports: service.ports || [],
					volumes: service.volumes || [],
					environment: service.environment || {}
				});
				return;
			}
		}
		
		logger.error('Service not found', undefined, { serviceId });
		process.exit(1);
	} catch (error) {
		logger.error('Failed to get service info', error as Error, { serviceId });
		process.exit(1);
	}
}

// ============================================================================
// System Commands
// ============================================================================

async function restart(): Promise<void> {
	try {
		const readiness = await apiProbe(`${DEVICE_API_V1}/readiness`);
		const readinessState = readiness.data?.state || readiness.data?.lifecycleState || 'UNKNOWN';
		const readinessFlag = readiness.data?.ready === true;

		logger.info('Restarting agent services...', {
			state: readinessState,
			ready: readinessFlag
		});
		
		const response = await apiRequest(`${DEVICE_API_V1}/reboot`, {
			method: 'POST'
		});
		
		logger.info('Agent services restarting', {
			note: 'All services will reinitialize (API and MQTT stay running)',
			state: response.state || response.lifecycleState || readinessState
		});

		await waitForRestartCompletion(response.state || response.lifecycleState || readinessState);
	} catch (error) {
		logger.error('Failed to restart agent services', error as Error);
		process.exit(1);
	}
}

/**
 * Format connection details for display
 */
function formatConnection(protocol: string, connection: Record<string, any>): string {
	switch (protocol) {
		case 'modbus':
			const slaveInfo = connection.slaveId || connection.slaveRange;
			if (connection.type === 'tcp') {
				return `${connection.host}:${connection.port} (TCP, Slave: ${slaveInfo})`;
			} else {
				return `${connection.path} (Serial, Slave: ${slaveInfo})`;
			}
		case 'opcua':
			return connection.endpointUrl || 'opc.tcp://...';
		case 'mqtt':
			return `${connection.host || connection.broker}:${connection.port || 1883}`;
		case 'snmp':
			return `${connection.host}:${connection.port || 161}`;
		case 'bacnet':
			return `Device ID: ${connection.deviceId}`;
		case 'can':
			return `${connection.interface} (${connection.protocol || 'CAN'})`;
		default:
			return JSON.stringify(connection);
	}
}

async function discover(protocolArg?: string): Promise<void> {
	clearApiCache();
	try {
		// Parse flags from args
		let validate = false;
		let protocol: string | undefined = protocolArg;

		// Check for --validate flag
		if (process.argv.includes('--validate')) {
			validate = true;
		}

		// Check for --protocol flag (overrides positional argument)
		const protocolFlagIndex = process.argv.findIndex((arg: string) => arg.startsWith('--protocol='));
		if (protocolFlagIndex !== -1) {
			const flagValue = process.argv[protocolFlagIndex].split('=')[1];
			if (flagValue) {
				protocol = flagValue;
			}
		}

		// Build request body
		const body: any = {
			trigger: 'manual',
			validate
		};

		if (protocol) {
			body.protocols = [protocol];
			logger.info(`Running discovery for ${protocol}${validate ? ' with validation' : ''}...`);
		} else {
			logger.info(`Running discovery for all protocols${validate ? ' with validation' : ''}...`);
		}

		if (protocol === 'modbus' || !protocol) {
			logger.info('(Modbus scanning slave IDs - this may take 30-60 seconds...)');
		}

		const result = await apiRequest(`${DEVICE_API_V1}/discover`, {
			method: 'POST',
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(120000)  // 2-minute timeout for discovery (scanning slave IDs is slow)
		});

		const devices = result.devices || [];

		if (devices.length === 0) {
			logger.info('No devices discovered');
			return;
		}

		logger.info(`Discovered ${devices.length} device${devices.length === 1 ? '' : 's'}`);
		console.log('');

		// Format as table
		for (const device of devices) {
			const connectionStr = formatConnection(device.protocol, device.connection);
			const confidenceIcon = device.confidence === 'high' ? '●' : device.confidence === 'medium' ? '◐' : '○';
			const validatedIcon = device.validated ? ' [V]' : '';
			const statusEnabled = device.enabled === true ? 'enabled' : 'disabled';
			
			logger.info(device.name, {
				protocol: device.protocol,
				connection: connectionStr,
				confidence: `${confidenceIcon} ${device.confidence}${validatedIcon}`,
				status: statusEnabled,
				discoveredAt: new Date(device.discoveredAt).toLocaleString()
			});
		}

		console.log('');
		logger.info('Legend: ● = high confidence, ◐ = medium, ○ = low, [V] = validated');
	} catch (error) {
		logger.error('Failed to run discovery', error as Error);
		process.exit(1);
	}
}

/**
 * List all configured endpoints/sensors
 */
async function endpointsList(protocolFilter?: string): Promise<void> {
	clearApiCache();
	try {
		const query = protocolFilter ? `?protocol=${protocolFilter}` : '';
		const result = await apiRequest(`${DEVICE_API_V1}/endpoints${query}`);
		const endpoints = result.endpoints || [];

		if (endpoints.length === 0) {
			logger.info('No endpoints configured');
			return;
		}

		logger.info(`Found ${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}${protocolFilter ? ` (${protocolFilter})` : ''}`);
		console.log('');

		// Group by protocol
		const byProtocol = endpoints.reduce((acc: Record<string, any[]>, endpoint: any) => {
			const proto = endpoint.protocol || 'unknown';
			if (!acc[proto]) acc[proto] = [];
			acc[proto].push(endpoint);
			return acc;
		}, {} as Record<string, any[]>);

		// Display by protocol groups
		for (const [protocol, protoEndpoints] of Object.entries(byProtocol)) {
			console.log(`\n${protocol.toUpperCase()} Endpoints:`);
			console.log('━'.repeat(60));

			for (const endpoint of protoEndpoints as any[]) {
				const enabledIcon = endpoint.enabled ? '✓' : '✗';
				const connectionStr = formatConnection(endpoint.protocol, endpoint.connection);
				
				logger.info(`${enabledIcon} ${endpoint.name}`, {
					connection: connectionStr,
					pollInterval: `${endpoint.poll_interval}ms`,
					dataPoints: endpoint.data_points?.length || 0
				});
			}
		}

		console.log('');
	} catch (error) {
		logger.error('Failed to list endpoints', error as Error);
		process.exit(1);
	}
}

/**
 * Show detailed information for a specific endpoint
 */
async function endpointsShow(endpointName?: string): Promise<void> {
	clearApiCache();
	try {
		const result = await apiRequest(`${DEVICE_API_V1}/endpoints`);
		const endpoints = result.endpoints || [];

		// If no name provided, show all devices
		if (!endpointName) {
			if (endpoints.length === 0) {
				logger.info('No devices configured');
				return;
			}

			logger.info(`Found ${endpoints.length} device${endpoints.length === 1 ? '' : 's'}`);
			console.log('');

			// Group by protocol
			const byProtocol = endpoints.reduce((acc: Record<string, any[]>, endpoint: any) => {
				const proto = endpoint.protocol || 'unknown';
				if (!acc[proto]) acc[proto] = [];
				acc[proto].push(endpoint);
				return acc;
			}, {} as Record<string, any[]>);

			// Display by protocol groups
			for (const [protocol, protoEndpoints] of Object.entries(byProtocol)) {
				console.log(`\n${protocol.toUpperCase()} Devices:`);
				console.log('━'.repeat(80));

				for (const endpoint of protoEndpoints as any[]) {
					const enabledIcon = endpoint.enabled ? '✓' : '✗';
					const connectionStr = formatConnection(endpoint.protocol, endpoint.connection);
					
					logger.info(`${enabledIcon} ${endpoint.name}`, {
						enabled: !!endpoint.enabled,
						connection: connectionStr,
						pollInterval: `${endpoint.poll_interval}ms`,
						dataPoints: endpoint.data_points?.length || 0
					});
				}
			}

			console.log('');
			return;
		}

		// If name provided, show detailed view
		const endpoint = endpoints.find((e: any) => e.name === endpointName);

		if (!endpoint) {
			logger.error(`Device not found: ${endpointName}`);
			process.exit(1);
		}

		console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
		console.log('║                    DEVICE DETAILS                                 ║');
		console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

		logger.info('Name', { value: endpoint.name });
		logger.info('Protocol', { value: endpoint.protocol });
		logger.info('Enabled', { value: endpoint.enabled ? 'Yes' : 'No' });
		logger.info('Poll Interval', { value: `${endpoint.poll_interval}ms` });
		logger.info('Connection', { value: formatConnection(endpoint.protocol, endpoint.connection) });

		if (endpoint.data_points && endpoint.data_points.length > 0) {
			console.log('\nData Points:');
			console.log('━'.repeat(60));
			for (const dp of endpoint.data_points) {
				const dpInfo: any = {};
				if (endpoint.protocol === 'modbus') {
					dpInfo.address = dp.address;
					dpInfo.type = dp.type;
					dpInfo.dataType = dp.dataType;
				} else if (endpoint.protocol === 'opcua') {
					dpInfo.nodeId = dp.nodeId;
					dpInfo.dataType = dp.dataType;
				} else if (endpoint.protocol === 'mqtt') {
					dpInfo.topic = dp.topic;
				}
				logger.info(`  • ${dp.name || dp.label || 'unnamed'}`, dpInfo);
			}
		}

		if (endpoint.metadata && Object.keys(endpoint.metadata).length > 0) {
			console.log('\nMetadata:');
			console.log('━'.repeat(60));
			for (const [key, value] of Object.entries(endpoint.metadata)) {
				logger.info(`  ${key}`, { value });
			}
		}

		console.log('');
	} catch (error) {
		logger.error('Failed to show device details', error as Error);
		process.exit(1);
	}
}

function describeCloudFetchError(error: any): string {
	if (error.message?.includes('timeout')) return 'Connection timeout (5s)';
	const cause = error.cause;
	if (cause) {
		const code: string | undefined = cause.code;
		if (code === 'ECONNREFUSED') return 'Connection refused - is the cloud API running?';
		if (code === 'ECONNRESET') return 'Connection reset by remote host';
		if (code === 'ENOTFOUND') return `DNS lookup failed for host`;
		if (code === 'CERT_HAS_EXPIRED') return 'TLS certificate has expired';
		if (code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT')
			return 'TLS: self-signed certificate not trusted';
		if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'TLS: unable to verify certificate';
		if (cause.message) return cause.message;
	}
	return error.message || 'Unknown fetch error';
}

async function runDiagnostics(): Promise<void> {
	logger.info('Running system diagnostics...');
	
	const results: { [key: string]: { status: string; message: string; details?: any } } = {};
	
	// Helper functions for each diagnostic check
	const checkDeviceApi = async () => {
		try {
			const response = await fetch(`${DEVICE_API_V1}/device`);
			if (response.ok) {
				const json: any = await response.json();
				const data = json.Data ?? json;
				results['Device API'] = {
					status: '✓ OK',
					message: `Connected to ${DEVICE_API_BASE}`,
					details: { uuid: redact(data.uuid), provisioned: data.provisioned }
				};
			} else {
				results['Device API'] = {
					status: '✗ FAIL',
					message: `HTTP ${response.status}`,
					details: { endpoint: DEVICE_API_BASE }
				};
			}
		} catch (error: any) {
			results['Device API'] = {
				status: '✗ FAIL',
				message: error.message,
				details: { endpoint: DEVICE_API_BASE }
			};
		}
	};
	
	const checkDatabase = async () => {
		try {
			if (existsSync(DB_PATH)) {
				const stats = statSync(DB_PATH);
				results['Database'] = {
					status: '✓ OK',
					message: `SQLite database exists`,
					details: { path: DB_PATH, size: `${(stats.size / 1024).toFixed(2)} KB` }
				};
			} else {
				results['Database'] = {
					status: '✗ FAIL',
					message: 'Database file not found',
					details: { path: DB_PATH }
				};
			}
		} catch (error: any) {
			results['Database'] = {
				status: '✗ FAIL',
				message: error.message,
				details: { path: DB_PATH }
			};
		}
	};
	
	const checkProvisioning = async () => {
		try {
			const response = await fetch(`${DEVICE_API_V1}/provision/status`);
			if (response.ok) {
				const json: any = await response.json();
				const data = json.Data ?? json;
				const provisioned = data.provisioned;
				results['Provisioning'] = {
					status: provisioned ? '✓ OK' : '⚠ WARN',
					message: provisioned ? 'Device is provisioned' : 'Device not provisioned',
					details: {
						apiEndpoint: data.apiEndpoint,
						deviceId: redact(data.deviceId),
						mqttBroker: data.mqttBrokerUrl || 'not set'
					}
				};
			} else {
				results['Provisioning'] = {
					status: '✗ FAIL',
					message: `Cannot check status (HTTP ${response.status})`
				};
			}
		} catch (error: any) {
			results['Provisioning'] = {
				status: '✗ FAIL',
				message: error.message
			};
		}
	};
	
	const checkInternet = async () => {
		try {
			const testUrls = [
				'https://www.google.com',
				'https://1.1.1.1', // Cloudflare DNS
				'https://8.8.8.8'  // Google DNS
			];
			
			let connected = false;
			let successUrl = '';
			
			for (const url of testUrls) {
				try {
					const response = await fetch(url, {
						method: 'HEAD',
						signal: AbortSignal.timeout(3000)
					});
					if (response.ok || response.status < 500) {
						connected = true;
						successUrl = url;
						break;
					}
				} catch {
					// Try next URL
					continue;
				}
			}
			
			if (connected) {
				results['Internet'] = {
					status: '✓ OK',
					message: 'Internet connection available',
					details: { testedUrl: successUrl }
				};
			} else {
				results['Internet'] = {
					status: '✗ FAIL',
					message: 'No internet connectivity detected',
					details: { note: 'Tested Google, Cloudflare, and Google DNS' }
				};
			}
		} catch (error: any) {
			results['Internet'] = {
				status: '✗ FAIL',
				message: 'Internet check failed',
				details: { error: error.message }
			};
		}
	};
	
	const checkEnvironment = async () => {
		const envVars = {
			DEVICE_API_PORT: process.env.DEVICE_API_PORT || '(default: 48484)',
			IOTISTICA_API: process.env.IOTISTICA_API || '(not set)',
			PROVISIONING_API_KEY: process.env.PROVISIONING_API_KEY ? '(set)' : '(not set)',
			CONFIG_DIR: process.env.CONFIG_DIR || '/app/data'
		};
		results['Environment'] = {
			status: '⊘ INFO',
			message: 'Configuration variables',
			details: envVars
		};
	};

	const checkLifecycle = async () => {
		try {
			const [healthyProbe, readinessProbe, healthReportProbe] = await Promise.all([
				apiProbe(`${DEVICE_API_V1}/healthy`),
				apiProbe(`${DEVICE_API_V1}/readiness`),
				apiProbe(`${DEVICE_API_V1}/health/report`),
			]);
			const healthy = healthyProbe.data || {};
			const readiness = readinessProbe.data || {};
			const healthReport = healthReportProbe.data || {};
			const report = healthReport.report || {};
			const criticalFailures = Array.isArray(report.criticalFailures) ? report.criticalFailures : [];
			const unhealthySubsystems = Array.isArray(report.unhealthySubsystems) ? report.unhealthySubsystems : [];

			const state = readiness.state || healthy.state || readiness.lifecycleState || healthy.lifecycleState || 'UNKNOWN';
			const ready = readiness.ready === true;
			const healthStatus = healthy.status || (healthyProbe.ok ? 'healthy' : 'unhealthy');
			const hasCriticalFailures = criticalFailures.length > 0;

			results['Lifecycle'] = {
				status: hasCriticalFailures ? '✗ FAIL' : (ready ? '✓ OK' : '⚠ WARN'),
				message: `State=${state}, Ready=${ready}, Health=${healthStatus}`,
				details: {
					state,
					ready,
					health: healthStatus,
					healthHttpStatus: healthyProbe.status,
					readinessHttpStatus: readinessProbe.status,
					healthReportHttpStatus: healthReportProbe.status,
					criticalFailures,
					unhealthySubsystems,
				}
			};
		} catch (error: any) {
			results['Lifecycle'] = {
				status: '✗ FAIL',
				message: error.message,
				details: {
					hint: 'Unable to query /v1/healthy or /v1/readiness'
				}
			};
		}
	};
	
	// Run core checks concurrently
	await Promise.allSettled([
		checkDeviceApi(),
		checkLifecycle(),
		checkDatabase(),
		checkProvisioning(),
		checkInternet(),
		checkEnvironment()
	]);
	
	// Cloud API check depends on provisioning results
	if (results['Provisioning']?.details?.apiEndpoint) {
		const cloudEndpoint = results['Provisioning'].details.apiEndpoint;
		try {
			// For localhost HTTPS endpoints (local dev / VPN), skip TLS verification
			// because self-signed certs are common in that setup.
			const isLocalhost = /^https:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(cloudEndpoint);
			const fetchFn = isLocalhost
				? (url: string, init?: RequestInit) =>
						undiciFetch(url, {
							...(init as object),
							dispatcher: new UndiciAgent({ connect: { rejectUnauthorized: false } }),
						} as Parameters<typeof undiciFetch>[1])
				: fetch;
			const response = await fetchFn(`${cloudEndpoint}/health`, {
				signal: AbortSignal.timeout(5000)
			} as RequestInit);
			if (response.ok) {
				results['Cloud API'] = {
					status: '✓ OK',
					message: 'Cloud API reachable',
					details: { endpoint: cloudEndpoint }
				};
			} else {
				results['Cloud API'] = {
					status: '✗ FAIL',
					message: `HTTP ${response.status}`,
					details: { endpoint: cloudEndpoint }
				};
			}
		} catch (error: any) {
			results['Cloud API'] = {
				status: '✗ FAIL',
				message: describeCloudFetchError(error),
				details: { endpoint: cloudEndpoint }
			};
		}
	} else {
		results['Cloud API'] = {
			status: '⊘ SKIP',
			message: 'Not provisioned - skipping cloud check'
		};
	}
	
	// MQTT broker info depends on provisioning results
	if (results['Provisioning']?.details?.mqttBroker) {
		const mqttBroker = results['Provisioning'].details.mqttBroker;
		results['MQTT Broker'] = {
			status: '⊘ INFO',
			message: 'Configured broker',
			details: { url: mqttBroker, note: 'Cannot test connection from CLI' }
		};
	} else {
		results['MQTT Broker'] = {
			status: '⊘ SKIP',
			message: 'Not provisioned - no MQTT broker configured'
		};
	}
	
	// Print results
	console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
	console.log('║                    SYSTEM DIAGNOSTICS                             ║');
	console.log('╚═══════════════════════════════════════════════════════════════════╝\n');
	
	for (const [component, result] of Object.entries(results)) {
		console.log(`${result.status.padEnd(10)} ${component}`);
		console.log(`           ${result.message}`);
		if (result.details) {
			console.log(`           ${JSON.stringify(result.details, null, 2).split('\n').join('\n           ')}`);
		}
		console.log();
	}
	
	// Overall status
	const failures = Object.values(results).filter(r => r.status.includes('✗')).length;
	const warnings = Object.values(results).filter(r => r.status.includes('⚠')).length;
	
	if (failures > 0) {
		console.log(`\n❌ Diagnostics completed with ${failures} failure(s) and ${warnings} warning(s)`);
		process.exit(1);
	} else if (warnings > 0) {
		console.log(`\n⚠️  Diagnostics completed with ${warnings} warning(s)`);
	} else {
		console.log('\n✅ All diagnostics passed!');
	}
}

function showLogs(follow: boolean = false, lines: number = 50): void {
	// Agent logs are not accessible from inside the container
	// User must run docker logs from the host
	logger.error('Agent logs not available from inside container', undefined, {
		note: 'Run from host machine instead',
		hint_docker: follow 
			? 'docker logs -f agent-1' 
			: `docker logs --tail ${lines} agent-1`,
		hint_compose: follow
			? 'docker-compose logs -f agent-1'
			: `docker-compose logs --tail=${lines} agent-1`
	});
	process.exit(1);
}

function showVersion(): void {
	// Try to read package.json version from multiple possible locations
	const possiblePaths = [
		join(process.cwd(), 'package.json'),           // Running from agent/
		join(process.cwd(), '..', 'package.json'),     // Running from agent/cli/
		'/app/package.json',                           // Container path
	];
	
	for (const packagePath of possiblePaths) {
		try {
			if (existsSync(packagePath)) {
				const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));
				logger.info('iotctl - IoT Control CLI', { version: packageJson.version });
				return;
			}
		} catch {
			continue;
		}
	}
	
	// Fallback version
	logger.info('iotctl - IoT Control CLI', { version: '1.0.0' });
}

// ============================================================================
// Provisioning Commands
// ============================================================================

async function provisionWithKey(key: string): Promise<void> {
	if (!key) {
		throw new CLIError('Provisioning key is required', 1, {
			usage: 'iotctl provision <key> [--api <endpoint>] [--name <device-name>]'
		});
	}
	
	try {
		// Parse optional flags
		const args = process.argv.slice(2);
		const apiIndex = args.indexOf('--api');
		const nameIndex = args.indexOf('--name');
		const typeIndex = args.indexOf('--type');
		
		const config: any = {
			provisioningApiKey: key
		};
		
		if (apiIndex !== -1 && args[apiIndex + 1]) {
			config.apiEndpoint = args[apiIndex + 1];
		}
		
		if (nameIndex !== -1 && args[nameIndex + 1]) {
			config.deviceName = args[nameIndex + 1];
		}
		
		if (typeIndex !== -1 && args[typeIndex + 1]) {
			config.deviceType = args[typeIndex + 1];
		}
		
		logger.info('Provisioning device', { 
			apiEndpoint: config.apiEndpoint || 'default',
			deviceName: config.deviceName || 'auto-generated'
		});
		
		const result = await apiRequest(`${DEVICE_API_V1}/provision`, {
			method: 'POST',
			body: JSON.stringify(config)
		});
		
		logger.info('Device provisioned successfully', {
			uuid: redact(result.device.uuid),
			deviceId: redact(result.device.deviceId),
			deviceName: result.device.deviceName,
			mqttBrokerUrl: redact(result.device.mqttBrokerUrl)
		});
	} catch (error) {
		throw new CLIError('Provisioning failed', 1);
	}
}

async function provisionStatus(): Promise<void> {
	clearApiCache();
	try {
		const status = await apiCached(`${DEVICE_API_V1}/provision/status`);
		
		logger.info('Provisioning status', {
			provisioned: status.provisioned,
			uuid: redact(status.uuid),
			deviceId: redact(status.deviceId),
			deviceName: status.deviceName || 'not set',
			apiEndpoint: status.apiEndpoint || 'not set',
			mqttConfigured: status.mqttConfigured
		});
		
		if (!status.provisioned) {
			logger.info('Device not provisioned', {
				hint: 'Use "iotctl provision <key>" to provision this device'
			});
		}
	} catch (error) {
		throw new CLIError('Failed to get provisioning status', 1);
	}
}

async function deprovision(): Promise<void> {
	try {
		logger.warn('Deprovisioning device - this will remove cloud registration');
		
		// Require explicit confirmation
		requireConfirmation('Deprovision will remove cloud registration. Continue?');
		
		const result = await apiRequest(`${DEVICE_API_V1}/deprovision`, {
			method: 'POST'
		});
		
		logger.info('Device deprovisioned', {
			message: result.message,
			status: result.status
		});
	} catch (error) {
		logger.error('Deprovision failed', error as Error);
		process.exit(1);
	}
}

/**
 * List all MQTT users from local device SQLite
 * These users are synced from target endpoints and used by mosquitto broker
 */
async function mqttListUsers(): Promise<void> {
	clearApiCache();
	try {
		const result = await apiRequest(`${DEVICE_API_V1}/mqtt/users`);
		
		const users = result.users || [];
		const count = result.count || 0;

		if (count === 0) {
			logger.info('No MQTT users configured');
			return;
		}

		console.log(`\n📊 MQTT Users (${count} total)\n`);
		console.log('┌─────────────────────────────────┬──────────────┬──────────┐');
		console.log('│ Username                          │ Superuser    │ Active   │');
		console.log('├─────────────────────────────────┼──────────────┼──────────┤');

		for (const user of users) {
			const username = (user.username || '').padEnd(32, ' ');
			const superuser = user.is_superuser ? 'Yes' : 'No';
			const active = user.is_active ? 'Yes' : 'No';
			console.log(`│ ${username} │ ${superuser.padEnd(12, ' ')} │ ${active.padEnd(8, ' ')} │`);
		}

		console.log('└─────────────────────────────────┴──────────────┴──────────┘\n');
	} catch (error) {
		if ((error as any).code === 'ECONNREFUSED') {
			logger.error('Cannot connect to agent API', undefined, {
				endpoint: DEVICE_API_BASE,
				hint: 'Make sure the agent is running'
			});
		} else {
			logger.error('Failed to retrieve MQTT users', error as Error);
		}
		process.exit(1);
	}
}

async function factoryReset(): Promise<void> {
	try {
		logger.warn('WARNING: Factory reset will DELETE ALL DATA');
		logger.warn('This includes all apps, services, state snapshots, and sensor data');
		logger.warn('Only the device UUID will be preserved');
		logger.warn('This action cannot be undone');
		
		// Require explicit confirmation
		requireConfirmation('Factory reset will DELETE ALL DATA. This cannot be undone.');
		
		const result = await apiRequest(`${DEVICE_API_V1}/factory-reset`, {
			method: 'POST'
		});
		
		logger.info('Factory reset complete', {
			message: result.message,
			status: result.status
		});
	} catch (error) {
		throw new CLIError('Factory reset failed', 1);
	}
}

// ============================================================================
// Main CLI Parser
// ============================================================================

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	
	if (args.length === 0) {
		showHelp();
		return;
	}
	
	const command = args[0];
	const subcommand = args[1];
	const arg1 = args[2];
	const arg2 = args[3];
	
	// Table-driven command dispatch
	const commands: Record<string, any> = {
		provision: {
			_default: (key?: string) => {
				// iotctl provision <key> or iotctl provision --flags
				if (!key) {
					throw new CLIError('Provisioning key is required', 1, {
						usage: 'iotctl provision <key> [--api <endpoint>] [--name <device-name>]'
					});
				}
				provisionWithKey(key);
			},
			status: provisionStatus
		},
		deprovision: {
			_default: deprovision
		},
		'factory-reset': {
			_default: factoryReset
		},
		config: {
			'set-api': configSetApi,
			'get-api': configGetApi,
			set: configSet,
			get: configGet,
			show: configShow,
			reset: configReset
		},
		apps: {
			list: appsList,
			start: appsStart,
			stop: appsStop,
			restart: appsRestart,
			info: appsInfo,
			purge: appsPurge
		},
		services: {
			list: servicesList,
			start: servicesStart,
			stop: servicesStop,
			restart: servicesRestart,
			logs: (serviceId: string) => {
				const followLogs = args.includes('--follow') || args.includes('-f');
				return servicesLogs(serviceId, followLogs);
			},
			info: servicesInfo
		},
		status: {
			_default: showStatusEnhanced
		},
		discover: {
			_default: discover
		},
		devices: {
			list: endpointsList,
			show: endpointsShow,
			_default: endpointsList
		},
		endpoints: {
			// Backward compatibility alias for devices
			list: endpointsList,
			show: endpointsShow,
			_default: endpointsList
		},
		mqtt: {
			users: mqttListUsers,
			_default: mqttListUsers
		},
		diagnostics: {
			_default: runDiagnostics
		},
		db: {
			backup: dbBackup,
			list: dbList,
			verify: dbVerify,
			restore: dbRestore,
			prune: dbPrune,
			_default: dbList,
		},
		buffer: {
			status: bufferStatus,
			_default: bufferStatus,
		},
		diag: {
			_default: runDiagnostics
		},
		restart: {
			_default: restart
		},
		logs: {
			_default: () => {
				const follow = args.includes('--follow') || args.includes('-f');
				const linesIndex = args.indexOf('-n');
				const lines = linesIndex !== -1 && args[linesIndex + 1] 
					? parseInt(args[linesIndex + 1]) 
					: 50;
				return showLogs(follow, lines);
			}
		},
		help: {
			_default: showHelp
		},
		'--help': {
			_default: showHelp
		},
		'-h': {
			_default: showHelp
		},
		version: {
			_default: showVersion
		},
		'--version': {
			_default: showVersion
		},
		'-v': {
			_default: showVersion
		}
	};
	
	// Dispatch command
	const commandGroup = commands[command];
	if (!commandGroup) {
		throw new CLIError('Unknown command', 1, {
			command,
			hint: 'Use "iotctl help" for usage information'
		});
	}
	
	// Handle subcommands or default action
	if (subcommand && commandGroup[subcommand]) {
		// Subcommand exists
		await commandGroup[subcommand](arg1, arg2);
	} else if (commandGroup._default) {
		// No subcommand or invalid subcommand - use default handler
		await commandGroup._default(subcommand, arg1, arg2);
	} else {
		// No valid subcommand or default
		throw new CLIError(`Unknown ${command} command`, 1, {
			command: subcommand,
			hint: 'Use "iotctl help" for usage information'
		});
	}
}

// Error handler
function handleError(error: any): void {
	if (error instanceof CLIError) {
		logger.error(error.message, undefined, error.context);
	} else {
		logger.error('Unexpected error', error);
	}
}

// Run CLI with centralized error handling
main().catch((error) => {
	handleError(error);
	process.exit(error.exitCode ?? 1);
});
