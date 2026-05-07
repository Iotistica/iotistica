/**
 * Agent Updater
 * 
 * Handles remote agent updates via MQTT commands.
 * Supports both Docker and systemd deployments with scheduled updates.
 */

import { existsSync, writeFileSync, unlinkSync, readFileSync, statSync, mkdirSync } from 'fs';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { createHmac, timingSafeEqual } from 'crypto';
import { join } from 'path';
import { type AgentLogger } from './logging/agent-logger.js';
import { LogComponents } from './logging/types.js';
import { CloudMqttClient, createJsonPayload } from './mqtt/manager.js';
import { notifySystemd } from './system/watchdog.js';
import { agentTopic } from './mqtt/topics.js';

const execAsync = promisify(exec);

// Update script path (immutable, hardcoded for security)
const UPDATE_SCRIPT_SYSTEMD = '/usr/local/bin/update.sh';

// Update lock file path (prevents concurrent updates)
const UPDATE_LOCK_FILE = '/var/lib/iotistic/agent/update.lock';

// Pending update file path (survives restarts)
const PENDING_UPDATE_FILE = '/var/lib/iotistic/agent/pending-update.json';

// Last update timestamp file (rate limiting)
const LAST_UPDATE_FILE = '/var/lib/iotistic/agent/last-update.json';

// Update status file written by update script (confirms success)
const UPDATE_STATUS_FILE = '/var/lib/iotistic/agent/update-status.json';

// Rate limit: 1 update per 24 hours (unless force=true)
const UPDATE_RATE_LIMIT_MS = 24 * 60 * 60 * 1000; // 24 hours

interface PendingUpdate {
  version: string;
  scheduled_time: string;
  force: boolean;
  created_at: number;
}

interface LastUpdateRecord {
  version: string;
  timestamp: number;
}

interface UpdateStatusRecord {
  version: string;
  success: boolean;
  completed_at: number;
  deployment_type: string;
}

/**
 * Compare semantic versions (e.g., "1.0.228" vs "1.0.230")
 * Returns: -1 if a < b, 0 if a === b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
	const aParts = a.split('.').map(Number);
	const bParts = b.split('.').map(Number);
  
	for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
		const aPart = aParts[i] || 0;
		const bPart = bParts[i] || 0;
    
		if (aPart < bPart) return -1;
		if (aPart > bPart) return 1;
	}
  
	return 0;
}

/**
 * Validate semantic version format
 */
function isValidVersion(version: string): boolean {
	return /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version);
}

/**
 * Detect actual binary version from package.json
 * This ensures we always use the real version after self-updates,
 * not stale version from injected config.
 */
function detectBinaryVersion(logger?: AgentLogger): string {
	try {
		// Try to read package.json from agent directory
		// In production: /app/package.json or /opt/iotistic/agent/package.json
		const possiblePaths = [
			'/app/package.json',
			'/opt/iotistic/agent/package.json',
			join(process.cwd(), 'package.json')
		];

		for (const pkgPath of possiblePaths) {
			if (existsSync(pkgPath)) {
				const pkgData = JSON.parse(readFileSync(pkgPath, 'utf-8'));
				if (pkgData.version && isValidVersion(pkgData.version)) {
					logger?.debugSync('Version detected', {
						component: LogComponents.agentUpdater,
						path: pkgPath,
						version: pkgData.version
					});
					return pkgData.version;
				} else {
					logger?.warnSync('Invalid version in package.json', {
						component: LogComponents.agentUpdater,
						path: pkgPath,
						version: pkgData.version
					});
				}
			}
		}

		// Fallback: try to read from environment (set by launcher)
		if (process.env.AGENT_VERSION && isValidVersion(process.env.AGENT_VERSION)) {
			logger?.debugSync('Version from env', {
				component: LogComponents.agentUpdater,
				version: process.env.AGENT_VERSION
			});
			return process.env.AGENT_VERSION;
		}

		// Last resort: unknown version
		logger?.warnSync('Version detection failed, all paths checked', {
			component: LogComponents.agentUpdater,
			possiblePaths
		});
		return '0.0.0';
	} catch (error) {
		// If detection fails, return unknown version
		logger?.errorSync('Version detection error', error as Error, {
			component: LogComponents.agentUpdater
		});
		return '0.0.0';
	}
}

/**
 * Verify HMAC signature of update command (prevents replay attacks)
 */
function verifyCommandSignature(command: UpdateCommand, secret: string): boolean {
	if (!command.signature || !command.issued_at) {
		return false;
	}

	// Create canonical string from command fields (excluding signature)
	const canonicalString = [
		command.action,
		command.version,
		command.issued_at.toString(),
		command.expires_at?.toString() || '',
		command.scheduled_time || '',
		command.force?.toString() || ''
	].join('|');

	// Compute expected HMAC
	const expectedSignature = createHmac('sha256', secret)
		.update(canonicalString)
		.digest('hex');

	// Timing-safe comparison (prevents timing attacks)
	try {
		return timingSafeEqual(
			Buffer.from(command.signature, 'hex'),
			Buffer.from(expectedSignature, 'hex')
		);
	} catch {
		return false; // Invalid signature format
	}
}

export interface UpdateCommand {
  action: 'update';
  version: string;
  scheduled_time?: string;
  force?: boolean;
  timestamp?: number; // Legacy field (kept for backward compatibility)
  
  // Security fields (prevents replay attacks and stale messages)
  issued_at: number;      // Unix timestamp when command was issued
  expires_at?: number;    // Unix timestamp when command expires (optional)
  signature: string;      // HMAC-SHA256 signature of command fields
}

export interface UpdaterConfig {
  deviceUuid: string;
  logger: AgentLogger;
}

/**
 * Agent Updater
 * 
 * Subscribes to MQTT update commands and orchestrates agent self-updates.
 */
export class AgentUpdater {
	private deviceUuid: string;
	private currentVersion: string;
	private logger: AgentLogger;
	private updateTopic: string;
	private statusTopic: string;
	private scheduledUpdateTimeout?: NodeJS.Timeout;

	constructor(config: UpdaterConfig) {
		this.deviceUuid = config.deviceUuid;
		this.logger = config.logger;
    
		// Detect actual binary version (critical after self-updates)
		// Using injected config would be stale after agent restart with new binary
		this.currentVersion = detectBinaryVersion(this.logger);
    
		this.logger.debugSync("Agent updater initialized with detected version", {
			component: LogComponents.agentUpdater,
			version: this.currentVersion,
			note: "Version detected from binary, not injected config (prevents staleness after self-update)"
		});
    
		// Follow standard IoT topic pattern: iot/{tenantId}/device/{uuid}/agent/{action}
		this.updateTopic = agentTopic(this.deviceUuid, 'agent', 'update');
		this.statusTopic = agentTopic(this.deviceUuid, 'agent', 'status');
	}

	/**
   * Get current agent version (for state reporting)
   */
	public getCurrentVersion(): string {
		return this.currentVersion;
	}

	/**
   * Reconcile current version with target version (declarative updates)
   * Called by StateReconciler during reconciliation loop
   */
	public async reconcileVersion(params: {
    targetVersion: string;
    scheduledAt?: string;
    force?: boolean;
    issuedAt?: number;
    expiresAt?: number;
    signature?: string;
  }): Promise<void> {
		const { targetVersion, scheduledAt, force = false, issuedAt, expiresAt, signature } = params;

		// Verify signature using the same logic as the MQTT push path
		const secret = process.env.UPDATE_COMMAND_SECRET;
		if (secret) {
			if (!signature || !issuedAt) {
				this.logger.errorSync(
					'Reconcile update rejected: signature or issued_at missing',
					new Error('Missing signature'),
					{
						component: LogComponents.agentUpdater,
						operation: 'reconcile-version',
						targetVersion,
						note: 'Set UPDATE_COMMAND_SECRET on the API side to auto-sign target state updates'
					}
				);
				await this.publishStatus({
					type: 'update_rejected',
					reason: 'missing_signature',
					target_version: targetVersion,
					timestamp: Date.now()
				});
				return;
			}

			// Check expiry
			if (expiresAt && Date.now() > expiresAt) {
				this.logger.warnSync('Reconcile update rejected: command expired', {
					component: LogComponents.agentUpdater,
					operation: 'reconcile-version',
					targetVersion,
					expires_at: new Date(expiresAt).toISOString(),
					age_seconds: Math.floor((Date.now() - expiresAt) / 1000)
				});
				await this.publishStatus({
					type: 'update_rejected',
					reason: 'command_expired',
					target_version: targetVersion,
					expires_at: new Date(expiresAt).toISOString(),
					timestamp: Date.now()
				});
				return;
			}

			// Reconstruct UpdateCommand and verify HMAC
			const command: UpdateCommand = {
				action: 'update',
				version: targetVersion,
				issued_at: issuedAt,
				expires_at: expiresAt,
				scheduled_time: scheduledAt,
				force,
				signature
			};

			if (!verifyCommandSignature(command, secret)) {
				this.logger.errorSync(
					'Reconcile update rejected: invalid signature',
					new Error('Invalid signature'),
					{
						component: LogComponents.agentUpdater,
						operation: 'reconcile-version',
						targetVersion,
						issued_at: issuedAt
					}
				);
				await this.publishStatus({
					type: 'update_rejected',
					reason: 'invalid_signature',
					target_version: targetVersion,
					timestamp: Date.now()
				});
				return;
			}
		} else {
			this.logger.warnSync('UPDATE_COMMAND_SECRET not set, skipping reconcile signature verification', {
				component: LogComponents.agentUpdater,
				note: 'Reconcile updates accepted without verification (INSECURE)'
			});
		}
    
		this.logger.infoSync('Reconciling agent version', {
			component: LogComponents.agentUpdater,
			operation: 'reconcile-version',
			currentVersion: this.currentVersion,
			targetVersion,
			scheduledAt,
			force
		});
    
		// If scheduled for future, save it as pending update
		if (scheduledAt) {
			const scheduledDate = new Date(scheduledAt);
			const delay = scheduledDate.getTime() - Date.now();
      
			if (delay > 0) {
				this.logger.infoSync('Reconciliation: Update scheduled for later', {
					component: LogComponents.agentUpdater,
					operation: 'reconcile-version',
					scheduledAt,
					delayMs: delay,
					delayHours: Math.round(delay / 3600000)
				});
        
				// Persist scheduled update (survives agent restart)
				await this.savePendingUpdate({
					version: targetVersion,
					scheduled_time: scheduledAt,
					force,
					created_at: Date.now()
				});
        
				// Schedule update execution
				this.scheduleUpdate(targetVersion, force, delay);
        
				await this.publishStatus({
					type: 'update_scheduled',
					version: targetVersion,
					scheduled_time: scheduledAt,
					timestamp: Date.now()
				});
        
				return;
			}
		}
    
		// Execute immediately - delegate to existing performUpdate()
		// This ensures identical security validation as MQTT-triggered updates
		await this.performUpdate(targetVersion, force);
	}

	/**
   * Initialize MQTT update listener and check for pending updates
   */
	async initialize(): Promise<void> {
		// Check for successful update from previous run (update script writes this)
		await this.checkUpdateStatus();
    
		// Check for pending updates from previous agent run (survives restarts)
		await this.loadPendingUpdate();

		const mqttManager = CloudMqttClient.getInstance();
    
		if (!mqttManager.isConnected()) {
			this.logger.debugSync("MQTT not connected - skipping update listener", {
				component: LogComponents.agentUpdater,
				note: "Update listener will not be available"
			});
			return;
		}
    
		try {
			// Subscribe to update commands with message handler
			await mqttManager.subscribe(this.updateTopic, undefined, async (topic: string, message: Buffer) => {
				await this.handleUpdateCommand(message);
			});
      
			this.logger.debugSync("MQTT update listener initialized", {
				component: LogComponents.agentUpdater,
				updateTopic: this.updateTopic,
				statusTopic: this.statusTopic
			});
      
		} catch (error) {
			this.logger.errorSync(
				"Failed to initialize MQTT update listener",
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agentUpdater
				}
			);
		}
	}

	/**
   * Handle incoming update command
   */
	private async handleUpdateCommand(message: Buffer): Promise<void> {
		try {
			const command: UpdateCommand = JSON.parse(message.toString());
      
			if (command.action !== 'update') {
				this.logger.warnSync("Unknown update command action", {
					component: LogComponents.agentUpdater,
					action: command.action
				});
				return;
			}

			// Verify command signature (prevents tampering and replay attacks)
			const secret = process.env.UPDATE_COMMAND_SECRET;
			if (!secret) {
				this.logger.warnSync("UPDATE_COMMAND_SECRET not set, skipping signature verification", {
					component: LogComponents.agentUpdater,
					note: "Commands will be accepted without verification (INSECURE)"
				});
			} else if (!verifyCommandSignature(command, secret)) {
				this.logger.errorSync(
					"Update command signature verification failed",
					new Error('Invalid signature'),
					{
						component: LogComponents.agentUpdater,
						version: command.version,
						issued_at: command.issued_at
					}
				);
        
				await this.publishStatus({
					type: 'update_rejected',
					reason: 'invalid_signature',
					version: command.version,
					timestamp: Date.now()
				});
        
				return;
			}

			// Check command expiry (prevents stale messages)
			if (command.expires_at && Date.now() > command.expires_at) {
				const ageSeconds = Math.floor((Date.now() - command.expires_at) / 1000);
        
				this.logger.warnSync("Update command expired", {
					component: LogComponents.agentUpdater,
					version: command.version,
					expires_at: new Date(command.expires_at).toISOString(),
					age_seconds: ageSeconds
				});
        
				await this.publishStatus({
					type: 'update_rejected',
					reason: 'command_expired',
					version: command.version,
					expires_at: new Date(command.expires_at).toISOString(),
					age_seconds: ageSeconds,
					timestamp: Date.now()
				});
        
				return;
			}

			const { version, scheduled_time, force } = command;
      
			this.logger.debugSync("Agent update command received", {
				component: LogComponents.agentUpdater,
				version,
				scheduled_time,
				force: !!force,
				issued_at: new Date(command.issued_at).toISOString(),
				expires_at: command.expires_at ? new Date(command.expires_at).toISOString() : undefined
			});

			// Report update command received
			await this.publishStatus({
				type: 'update_command_received',
				version,
				timestamp: Date.now()
			});

			// If scheduled, wait until that time
			if (scheduled_time) {
				const scheduledDate = new Date(scheduled_time);
				const delay = scheduledDate.getTime() - Date.now();
        
				if (delay > 0) {
					this.logger.debugSync("Update scheduled for later", {
						component: LogComponents.agentUpdater,
						scheduled_time,
						delay_ms: delay,
						delay_hours: Math.round(delay / 3600000)
					});
          
					await this.publishStatus({
						type: 'update_scheduled',
						version,
						scheduled_time,
						timestamp: Date.now()
					});
          
					// Persist scheduled update (survives agent restart)
					await this.savePendingUpdate({
						version,
						scheduled_time,
						force: !!force,
						created_at: Date.now()
					});
          
					// Schedule update execution
					this.scheduleUpdate(version, !!force, delay);
					return;
				}
			}

			// Execute immediately
			await this.performUpdate(version, force);
      
		} catch (error) {
			this.logger.errorSync(
				"Failed to process update command",
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agentUpdater,
					topic: this.updateTopic
				}
			);
		}
	}

	/**
   * Perform agent update
   */
	private async performUpdate(version: string, force: boolean = false): Promise<void> {
		// Validate version format
		if (!isValidVersion(version)) {
			this.logger.warnSync("Invalid version format", {
				component: LogComponents.agentUpdater,
				version,
				expected: "semver format (e.g., 1.0.230)"
			});
      
			await this.publishStatus({
				type: 'update_rejected',
				reason: 'invalid_version_format',
				version,
				timestamp: Date.now()
			});
      
			return;
		}

		// Check if already on target version
		if (!force && version === this.currentVersion) {
			this.logger.infoSync("Target version equals current version, skipping update", {
				component: LogComponents.agentUpdater,
				version,
				note: "Use force=true to reinstall"
			});
      
			await this.publishStatus({
				type: 'update_skipped',
				reason: 'same_version',
				current_version: this.currentVersion,
				target_version: version,
				timestamp: Date.now()
			});
      
			return;
		}

		// Check for downgrade (prevent unless force=true)
		const versionComparison = compareVersions(version, this.currentVersion);
		if (!force && versionComparison < 0) {
			this.logger.warnSync("Downgrade not allowed without force flag", {
				component: LogComponents.agentUpdater,
				currentVersion: this.currentVersion,
				targetVersion: version,
				note: "Use force=true to allow downgrade"
			});
      
			await this.publishStatus({
				type: 'update_rejected',
				reason: 'downgrade_not_allowed',
				current_version: this.currentVersion,
				target_version: version,
				timestamp: Date.now()
			});
      
			return;
		}

		// Ensure lock directory exists
		const lockDir = UPDATE_LOCK_FILE.substring(0, UPDATE_LOCK_FILE.lastIndexOf('/'));
		if (!existsSync(lockDir)) {
			mkdirSync(lockDir, { recursive: true });
		}

		// Check for existing update lock (prevent concurrent updates)
		if (existsSync(UPDATE_LOCK_FILE) && !force) {
			this.logger.warnSync("Update already in progress", {
				component: LogComponents.agentUpdater,
				lockFile: UPDATE_LOCK_FILE,
				note: "Use force=true to override"
			});
      
			await this.publishStatus({
				type: 'update_rejected',
				reason: 'update_in_progress',
				lock_file: UPDATE_LOCK_FILE,
				timestamp: Date.now()
			});
      
			return;
		}

		// Check rate limit (prevent excessive updates from backend)
		const rateLimitPassed = await this.checkRateLimit(version, force);
		if (!rateLimitPassed) {
			this.logger.warnSync("Update rate limit exceeded", {
				component: LogComponents.agentUpdater,
				version,
				note: "Max 1 update per 24 hours. Use force=true to override."
			});
			return;
		}

		// Run pre-flight checks (disk space, connectivity, etc.)
		const preflightPassed = await this.runPreflightChecks(version, force);
		if (!preflightPassed) {
			this.logger.warnSync("Pre-flight checks failed, aborting update", {
				component: LogComponents.agentUpdater,
				version,
				note: "Check disk space, connectivity, or use force=true to override"
			});
			return;
		}

		// Create update lock file (agent owns lock until successful script spawn)
		// OWNERSHIP: Agent creates lock, script removes it after successful spawn
		// Agent only removes lock on spawn failure (before transfer of ownership)
		try {
			writeFileSync(UPDATE_LOCK_FILE, JSON.stringify({
				version,
				started_at: Date.now(),
				current_version: this.currentVersion
			}));
      
			this.logger.debugSync("Update lock created", {
				component: LogComponents.agentUpdater,
				lockFile: UPDATE_LOCK_FILE
			});
		} catch (error) {
			this.logger.errorSync(
				"Failed to create update lock",
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agentUpdater,
					lockFile: UPDATE_LOCK_FILE
				}
			);
      
			await this.publishStatus({
				type: 'update_failed',
				reason: 'failed_to_create_lock',
				error: error instanceof Error ? error.message : String(error),
				timestamp: Date.now()
			});
      
			return;
		}

		const deploymentType = 'systemd';
    
		this.logger.infoSync("Starting agent self-update", {
			component: LogComponents.agentUpdater,
			currentVersion: this.currentVersion,
			targetVersion: version,
			deploymentType,
			force
		});

		// Report update started
		try {
			await this.publishStatus({
				type: 'update_started',
				current_version: this.currentVersion,
				target_version: version,
				deployment_type: deploymentType,
				timestamp: Date.now()
			});
		} catch (error) {
			this.logger.warnSync("Failed to publish update started status", {
				component: LogComponents.agentUpdater,
				error: error instanceof Error ? error.message : String(error)
			});
		}

		// Update script path (hardcoded for security)
		const updateScript = UPDATE_SCRIPT_SYSTEMD;
    
		// Verify script integrity (prevents local compromise → remote root execution)
		const scriptIntegrityCheck = this.verifyScriptIntegrity(updateScript);
		if (!scriptIntegrityCheck.valid) {
			// Gracefully skip update in development environments without update scripts
			if (scriptIntegrityCheck.reason === 'Script not found') {
				this.logger.warnSync(
					"Update skipped - running in development mode without update script",
					{
						component: LogComponents.agentUpdater,
						updateScript,
						currentVersion: this.currentVersion,
						targetVersion: version,
						note: "Install update script for production updates"
					}
				);
        
				await this.publishStatus({
					type: 'update_skipped',
					reason: 'development_mode_no_script',
					script_path: updateScript,
					current_version: this.currentVersion,
					target_version: version,
					note: 'Install update script at /usr/local/bin/update.sh',
					timestamp: Date.now()
				});
        
				// Remove update lock
				try {
					if (existsSync(UPDATE_LOCK_FILE)) {
						unlinkSync(UPDATE_LOCK_FILE);
					}
				} catch (cleanupError) {
					this.logger.warnSync("Failed to remove update lock", {
						component: LogComponents.agentUpdater,
						error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
					});
				}
        
				return;
			}
      
			// Actual integrity failures (not development mode)
			this.logger.errorSync(
				"Update script failed integrity check",
				new Error(scriptIntegrityCheck.reason || 'Integrity check failed'),
				{
					component: LogComponents.agentUpdater,
					updateScript,
					reason: scriptIntegrityCheck.reason,
					details: scriptIntegrityCheck.details
				}
			);
      
			await this.publishStatus({
				type: 'update_failed',
				reason: 'script_integrity_check_failed',
				script_path: updateScript,
				integrity_error: scriptIntegrityCheck.reason,
				timestamp: Date.now()
			});
      
			// Remove update lock
			try {
				if (existsSync(UPDATE_LOCK_FILE)) {
					unlinkSync(UPDATE_LOCK_FILE);
				}
			} catch (cleanupError) {
				this.logger.warnSync("Failed to remove update lock after integrity failure", {
					component: LogComponents.agentUpdater,
					error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
				});
			}
      
			return;
		}
    
		// Check if update script exists
		if (!existsSync(updateScript)) {
			this.logger.errorSync(
				"Update script not found",
				new Error(`Script not found: ${updateScript}`),
				{
					component: LogComponents.agentUpdater,
					updateScript,
					deploymentType
				}
			);
      
			await this.publishStatus({
				type: 'update_failed',
				reason: 'update_script_not_found',
				script_path: updateScript,
				timestamp: Date.now()
			});
      
			return;
		}

		this.logger.infoSync("Executing update script", {
			component: LogComponents.agentUpdater,
			script: updateScript,
			version,
			note: "Agent will restart shortly. Update script MUST: 1) Remove lock file, 2) Write status file on completion."
		});

		// Notify systemd of update sequence (prevents watchdog false positives)
		notifySystemd('STATUS=Starting agent update', this.logger);
		notifySystemd('STOPPING=1', this.logger);

		// Execute update script in background (agent will restart)
		// Pass version, force flag, and lock file path as arguments
		// Update script MUST remove lock file when done (success or failure)
		const forceFlag = force ? 'true' : 'false';
		const command = `${updateScript} ${version} ${forceFlag} ${UPDATE_LOCK_FILE} > /tmp/agent-update.log 2>&1 &`;
    
		// Use callback form to verify shell spawn (not async - we don't wait for completion)
		exec(command, async (err) => {
			if (err) {
				this.logger.errorSync(
					"Failed to spawn update script",
					err instanceof Error ? err : new Error(String(err)),
					{
						component: LogComponents.agentUpdater,
						script: updateScript,
						note: "Shell failed to start update script"
					}
				);
        
				await this.publishStatus({
					type: 'update_failed',
					reason: 'script_spawn_failed',
					error: err.message,
					timestamp: Date.now()
				});
        
				// Remove lock file on script spawn failure (agent still owns lock)
				// OWNERSHIP: Spawn failed, so agent retains ownership and must clean up
				try {
					if (existsSync(UPDATE_LOCK_FILE)) {
						unlinkSync(UPDATE_LOCK_FILE);
						this.logger.debugSync("Update lock removed after script spawn failure", {
							component: LogComponents.agentUpdater,
							lockFile: UPDATE_LOCK_FILE
						});
					}
				} catch (cleanupError) {
					this.logger.warnSync("Failed to remove update lock after spawn error", {
						component: LogComponents.agentUpdater,
						error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
					});
				}
			} else {
				// OWNERSHIP TRANSFER: Lock ownership transferred to update script
				// Agent MUST NOT touch lock file after this point - script owns cleanup
				// Violating this creates race conditions between exiting agent and running script
        
				this.logger.infoSync("Update script spawned successfully, exiting agent for systemd restart", {
					component: LogComponents.agentUpdater,
					deploymentType,
					note: "Agent exiting cleanly - systemd will restart after update completes. Update script must write status file on success."
				});

				// Do NOT record timestamp here - update hasn't completed yet
				// Update script will write status file, next agent boot will verify and record

				// Flush logs if async logger supports it
				const logger = this.logger as any;
				if (typeof logger.flush === 'function') {
					try {
						await logger.flush();
					} catch (flushError) {
						// Best effort - don't block on flush failure
						console.error('Failed to flush logs before exit:', flushError);
					}
				}

				// Exit cleanly so systemd restarts us (Restart=always policy)
				// This prevents split-brain state where:
				// - Agent is running with active watchdog
				// - Update script is trying to stop/update the service
				// - Race conditions, zombie processes, and partial state corruption
				process.exit(0);
			}
		});
	}

	/**
   * Publish status update to MQTT
   * Uses QoS 1 for guaranteed delivery and retain flag for last status
   * This ensures backend doesn't miss critical state transitions during network drops or restarts
   */
	private async publishStatus(payload: Record<string, any>): Promise<void> {
		const mqttManager = CloudMqttClient.getInstance();
    
		if (!mqttManager.isConnected()) {
			return;
		}

		try {
			// QoS 1: At least once delivery (survives network drops)
			// Retain: Backend can retrieve last status even if it was offline during update
			const msgIdGen = mqttManager.getMessageIdGenerator();
			const mqttPayload = createJsonPayload(payload, msgIdGen);
      
			await mqttManager.publish(
				this.statusTopic, 
				mqttPayload,
				{ qos: 1, retain: true }
			);
		} catch (error) {
			this.logger.warnSync("Failed to publish status update", {
				component: LogComponents.agentUpdater,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	/**
   * Run pre-flight checks before update (prevents bricking devices)
   */
	private async runPreflightChecks(version: string, force: boolean): Promise<boolean> {
		this.logger.infoSync("Running pre-flight checks", {
			component: LogComponents.agentUpdater,
			version
		});

		await this.publishStatus({
			type: 'preflight_started',
			version,
			timestamp: Date.now()
		});

		const checks = {
			diskSpace: false,
			connectivity: false,
			powerState: false
		};

		// Check 1: Disk space (require at least 500MB free)
		try {
			// Check root filesystem where binary is installed (/usr/local/bin)
			// Not /var/lib/iotistic which may be on different filesystem
			const { stdout } = await execAsync("df -BM / | tail -1 | awk '{print $4}' | sed 's/M//'");
			const freeSpaceMB = parseInt(stdout.trim(), 10);
			const requiredSpaceMB = 500;

			checks.diskSpace = freeSpaceMB >= requiredSpaceMB;

			this.logger.debugSync("Disk space check", {
				component: LogComponents.agentUpdater,
				filesystem: '/ (root)',
				freeSpaceMB,
				requiredSpaceMB,
				passed: checks.diskSpace,
				note: 'Checking root filesystem where binary is installed'
			});

			if (!checks.diskSpace) {
				this.logger.warnSync("Insufficient disk space", {
					component: LogComponents.agentUpdater,
					freeSpaceMB,
					requiredSpaceMB
				});
			}
		} catch (error) {
			this.logger.warnSync("Failed to check disk space", {
				component: LogComponents.agentUpdater,
				error: error instanceof Error ? error.message : String(error),
				note: "Assuming sufficient space"
			});
			checks.diskSpace = true; // Assume OK if check fails
		}

		// Check 2: Connectivity (MQTT connection active)
		const mqttManager = CloudMqttClient.getInstance();
		checks.connectivity = mqttManager.isConnected();

		this.logger.debugSync("Connectivity check", {
			component: LogComponents.agentUpdater,
			mqttConnected: checks.connectivity,
			passed: checks.connectivity
		});

		if (!checks.connectivity) {
			this.logger.warnSync("MQTT not connected", {
				component: LogComponents.agentUpdater,
				note: "Update may proceed offline but status reporting unavailable"
			});
		}

		// Check 3: Power state (if available via /sys/class/power_supply)
		try {
			if (existsSync('/sys/class/power_supply/AC/online')) {
				const { stdout } = await execAsync('cat /sys/class/power_supply/AC/online');
				const isPluggedIn = stdout.trim() === '1';
        
				checks.powerState = isPluggedIn;

				this.logger.debugSync("Power state check", {
					component: LogComponents.agentUpdater,
					isPluggedIn,
					passed: checks.powerState
				});

				if (!checks.powerState) {
					this.logger.warnSync("Device running on battery", {
						component: LogComponents.agentUpdater,
						note: "Update may fail if battery depletes during process"
					});
				}
			} else {
				// No power supply info available (desktop/VM)
				checks.powerState = true;
				this.logger.debugSync("Power state check skipped (not available)", {
					component: LogComponents.agentUpdater
				});
			}
		} catch (_error) {
			// Power state check not critical
			checks.powerState = true;
			this.logger.debugSync("Power state check skipped", {
				component: LogComponents.agentUpdater,
				note: "Not available on this device"
			});
		}

		// Evaluate results
		const allChecksPassed = checks.diskSpace && checks.connectivity && checks.powerState;

		await this.publishStatus({
			type: allChecksPassed ? 'preflight_passed' : 'preflight_failed',
			version,
			checks,
			timestamp: Date.now()
		});

		// Allow force to override failed checks (except critical disk space)
		if (!allChecksPassed && force) {
			if (!checks.diskSpace) {
				this.logger.errorSync(
					"Pre-flight failed: Insufficient disk space (cannot override with force)",
					new Error('Disk space critical'),
					{
						component: LogComponents.agentUpdater,
						checks
					}
				);

				await this.publishStatus({
					type: 'update_rejected',
					reason: 'insufficient_disk_space',
					checks,
					timestamp: Date.now()
				});

				return false;
			}

			this.logger.warnSync("Pre-flight checks failed but overridden by force flag", {
				component: LogComponents.agentUpdater,
				checks,
				note: "Proceeding with update despite warnings"
			});

			await this.publishStatus({
				type: 'preflight_overridden',
				version,
				checks,
				timestamp: Date.now()
			});

			return true;
		}

		if (!allChecksPassed) {
			await this.publishStatus({
				type: 'update_rejected',
				reason: 'preflight_failed',
				checks,
				timestamp: Date.now()
			});
		}

		return allChecksPassed;
	}

	/**
   * Check for successful update status from previous run
   * Update script writes this file on successful completion
   * We verify on next boot and record timestamp for rate limiting
   */
	private async checkUpdateStatus(): Promise<void> {
		if (!existsSync(UPDATE_STATUS_FILE)) {
			return;
		}

		try {
			const data = readFileSync(UPDATE_STATUS_FILE, 'utf-8');
			const status: UpdateStatusRecord = JSON.parse(data);

			if (status.success) {
				this.logger.infoSync("Previous update completed successfully, recording timestamp", {
					component: LogComponents.agentUpdater,
					version: status.version,
					current_version: this.currentVersion,
					completed_at: new Date(status.completed_at).toISOString()
				});

				// Record timestamp for rate limiting (only after confirmed success)
				this.recordUpdateTimestamp(status.version);

				// Publish success status
				await this.publishStatus({
					type: 'update_completed',
					version: status.version,
					deployment_type: status.deployment_type,
					completed_at: status.completed_at,
					timestamp: Date.now()
				});
			} else {
				this.logger.warnSync("Previous update failed", {
					component: LogComponents.agentUpdater,
					version: status.version,
					deployment_type: status.deployment_type
				});

				// Publish failure status
				await this.publishStatus({
					type: 'update_failed_verified',
					version: status.version,
					deployment_type: status.deployment_type,
					timestamp: Date.now()
				});
			}

			// Remove status file after processing
			unlinkSync(UPDATE_STATUS_FILE);
      
			this.logger.debugSync("Update status file processed and removed", {
				component: LogComponents.agentUpdater,
				file: UPDATE_STATUS_FILE
			});
      
		} catch (error) {
			this.logger.errorSync(
				"Failed to process update status file",
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agentUpdater,
					file: UPDATE_STATUS_FILE
				}
			);

			// Remove corrupted file
			try {
				unlinkSync(UPDATE_STATUS_FILE);
			} catch (_cleanupError) {
				// Ignore cleanup errors
			}
		}
	}

	/**
   * Cleanup - unsubscribe from MQTT topics and cancel scheduled updates
   */
	async cleanup(): Promise<void> {
		// Cancel any scheduled update
		if (this.scheduledUpdateTimeout) {
			clearTimeout(this.scheduledUpdateTimeout);
			this.scheduledUpdateTimeout = undefined;
		}

		const mqttManager = CloudMqttClient.getInstance();
    
		if (!mqttManager.isConnected()) {
			return;
		}

		try {
			await mqttManager.unsubscribe(this.updateTopic);
			this.logger.debugSync("Unsubscribed from update topic", {
				component: LogComponents.agentUpdater,
				topic: this.updateTopic
			});
		} catch (error) {
			this.logger.warnSync("Failed to unsubscribe from update topic", {
				component: LogComponents.agentUpdater,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	/**
   * Load pending update from disk (survives agent restarts)
   */
	private async loadPendingUpdate(): Promise<void> {
		if (!existsSync(PENDING_UPDATE_FILE)) {
			return;
		}

		try {
			const data = readFileSync(PENDING_UPDATE_FILE, 'utf-8');
			const pending: PendingUpdate = JSON.parse(data);

			const scheduledDate = new Date(pending.scheduled_time);
			const delay = scheduledDate.getTime() - Date.now();

			if (delay <= 0) {
				// Update is overdue - execute immediately
				this.logger.infoSync("Pending update is overdue, executing immediately", {
					component: LogComponents.agentUpdater,
					version: pending.version,
					scheduled_time: pending.scheduled_time,
					overdue_ms: Math.abs(delay)
				});

				await this.publishStatus({
					type: 'update_overdue',
					version: pending.version,
					scheduled_time: pending.scheduled_time,
					overdue_ms: Math.abs(delay),
					timestamp: Date.now()
				});

				// Remove pending update file before execution
				unlinkSync(PENDING_UPDATE_FILE);

				await this.performUpdate(pending.version, pending.force);
			} else {
				// Re-schedule the update
				this.logger.infoSync("Re-scheduling pending update after agent restart", {
					component: LogComponents.agentUpdater,
					version: pending.version,
					scheduled_time: pending.scheduled_time,
					remaining_ms: delay,
					remaining_hours: Math.round(delay / 3600000)
				});

				await this.publishStatus({
					type: 'update_rescheduled',
					version: pending.version,
					scheduled_time: pending.scheduled_time,
					remaining_ms: delay,
					timestamp: Date.now()
				});

				this.scheduleUpdate(pending.version, pending.force, delay);
			}
		} catch (error) {
			this.logger.errorSync(
				"Failed to load pending update",
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agentUpdater,
					file: PENDING_UPDATE_FILE
				}
			);

			// Remove corrupted file
			try {
				unlinkSync(PENDING_UPDATE_FILE);
			} catch (_cleanupError) {
				// Ignore cleanup errors
			}
		}
	}

	/**
   * Save pending update to disk (survives agent restarts)
   */
	private async savePendingUpdate(pending: PendingUpdate): Promise<void> {
		try {
			writeFileSync(PENDING_UPDATE_FILE, JSON.stringify(pending, null, 2));
			this.logger.debugSync("Pending update saved to disk", {
				component: LogComponents.agentUpdater,
				file: PENDING_UPDATE_FILE,
				version: pending.version,
				scheduled_time: pending.scheduled_time
			});
		} catch (error) {
			this.logger.errorSync(
				"Failed to save pending update",
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agentUpdater,
					file: PENDING_UPDATE_FILE
				}
			);
		}
	}

	/**
   * Check if update is within rate limit (max 1 update per 24 hours)
   */
	private async checkRateLimit(version: string, force: boolean): Promise<boolean> {
		if (force) {
			this.logger.debugSync("Rate limit check bypassed (force=true)", {
				component: LogComponents.agentUpdater,
				version
			});
			return true;
		}

		// Check if last update file exists
		if (!existsSync(LAST_UPDATE_FILE)) {
			this.logger.debugSync("No previous update record found", {
				component: LogComponents.agentUpdater
			});
			return true;
		}

		try {
			const lastUpdateData = readFileSync(LAST_UPDATE_FILE, 'utf-8');
			const lastUpdate: LastUpdateRecord = JSON.parse(lastUpdateData);

			const elapsed = Date.now() - lastUpdate.timestamp;
			const withinLimit = elapsed < UPDATE_RATE_LIMIT_MS;

			if (withinLimit) {
				const hoursRemaining = Math.ceil((UPDATE_RATE_LIMIT_MS - elapsed) / (1000 * 60 * 60));
        
				this.logger.warnSync("Update rate limit exceeded", {
					component: LogComponents.agentUpdater,
					last_version: lastUpdate.version,
					requested_version: version,
					hours_since_last: Math.floor(elapsed / (1000 * 60 * 60)),
					hours_until_next: hoursRemaining
				});

				await this.publishStatus({
					status: "update_rejected",
					reason: "rate_limit_exceeded",
					message: `Max 1 update per 24 hours. Last update: ${lastUpdate.version}. Try again in ${hoursRemaining} hours or use force=true.`,
					last_update: {
						version: lastUpdate.version,
						timestamp: new Date(lastUpdate.timestamp).toISOString()
					}
				});

				return false;
			}

			this.logger.debugSync("Rate limit check passed", {
				component: LogComponents.agentUpdater,
				hours_since_last: Math.floor(elapsed / (1000 * 60 * 60))
			});

			return true;
		} catch (error) {
			// If we can't read/parse the file, assume no rate limit (fail open)
			this.logger.warnSync("Failed to check rate limit, allowing update", {
				component: LogComponents.agentUpdater,
				error: error instanceof Error ? error.message : String(error)
			});
			return true;
		}
	}

	/**
   * Verify update script integrity (prevents local privilege escalation)
   * 
   * Requirements:
   * - Owner must be root (uid 0)
   * - Mode must be 0755 (readable/executable by all, writable only by root)
   * - Path must be hardcoded (not user-controllable)
   * 
   * This prevents: local user modifies script → triggers MQTT update → agent executes as root
   */
	private verifyScriptIntegrity(scriptPath: string): { valid: boolean; reason?: string; details?: any } {
		try {
			// Verify script is in hardcoded location (no path traversal)
			if (scriptPath !== UPDATE_SCRIPT_SYSTEMD) {
				return {
					valid: false,
					reason: 'Script path not in allowed list',
					details: { scriptPath, allowed: [UPDATE_SCRIPT_SYSTEMD] }
				};
			}

			// Check if script exists
			if (!existsSync(scriptPath)) {
				return {
					valid: false,
					reason: 'Script not found',
					details: { scriptPath }
				};
			}

			// Get file stats
			const stats = statSync(scriptPath);

			// Check owner is root (uid 0)
			if (stats.uid !== 0) {
				return {
					valid: false,
					reason: 'Script not owned by root',
					details: { scriptPath, uid: stats.uid, expected_uid: 0 }
				};
			}

			// Check permissions are 0755 (rwxr-xr-x)
			// Extract permission bits (last 9 bits of mode)
			const permissions = stats.mode & 0o777;
			if (permissions !== 0o755) {
				return {
					valid: false,
					reason: 'Script permissions incorrect',
					details: {
						scriptPath,
						mode: permissions.toString(8),
						expected_mode: '755'
					}
				};
			}

			// Check immutable bit (optional but recommended for hardening)
			// This blocks post-exploit script tampering
			// Don't fail if missing, just warn - some systems may not support it
			// Note: Using sync exec to avoid making verifyScriptIntegrity async
			try {
				const output = execSync(`lsattr ${scriptPath} 2>/dev/null || true`, { encoding: 'utf8' });
				const hasImmutableBit = output.includes('i');
        
				if (!hasImmutableBit) {
					this.logger.warnSync("Update script missing immutable bit (hardening recommended)", {
						component: LogComponents.agentUpdater,
						scriptPath,
						recommendation: `Run: sudo chattr +i ${scriptPath}`,
						note: "Immutable bit prevents post-exploit script tampering"
					});
				} else {
					this.logger.debugSync("Update script has immutable bit set (hardened)", {
						component: LogComponents.agentUpdater,
						scriptPath
					});
				}
			} catch (_error) {
				// lsattr not available or failed - not critical, just note it
				this.logger.debugSync("Could not check immutable bit (lsattr unavailable)", {
					component: LogComponents.agentUpdater,
					scriptPath,
					note: "This is optional - script integrity still verified by uid/mode"
				});
			}

			this.logger.debugSync("Script integrity verified", {
				component: LogComponents.agentUpdater,
				scriptPath,
				uid: stats.uid,
				mode: permissions.toString(8)
			});

			return { valid: true };
		} catch (error) {
			return {
				valid: false,
				reason: 'Failed to verify script integrity',
				details: {
					scriptPath,
					error: error instanceof Error ? error.message : String(error)
				}
			};
		}
	}

	/**
   * Record update timestamp for rate limiting
   */
	private recordUpdateTimestamp(version: string): void {
		try {
			const record: LastUpdateRecord = {
				version,
				timestamp: Date.now()
			};

			writeFileSync(LAST_UPDATE_FILE, JSON.stringify(record, null, 2));
      
			this.logger.debugSync("Update timestamp recorded", {
				component: LogComponents.agentUpdater,
				version,
				file: LAST_UPDATE_FILE
			});
		} catch (error) {
			// Log but don't throw - rate limiting is a safety feature, not critical
			this.logger.warnSync("Failed to record update timestamp", {
				component: LogComponents.agentUpdater,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	/**
   * Schedule update execution with setTimeout
   */
	private scheduleUpdate(version: string, force: boolean, delay: number): void {
		// Clear any existing scheduled update
		if (this.scheduledUpdateTimeout) {
			clearTimeout(this.scheduledUpdateTimeout);
		}

		this.scheduledUpdateTimeout = setTimeout(async () => {
			// Remove pending update file before execution
			try {
				if (existsSync(PENDING_UPDATE_FILE)) {
					unlinkSync(PENDING_UPDATE_FILE);
				}
			} catch (error) {
				this.logger.warnSync("Failed to remove pending update file", {
					component: LogComponents.agentUpdater,
					error: error instanceof Error ? error.message : String(error)
				});
			}

			await this.performUpdate(version, force);
		}, delay);
	}
}

