/**
 * Health Arbiter - Centralized Health State Management
 * 
 * Single source of truth for all subsystem health across the agent.
 * Prevents one subsystem from masking failures in another.
 * 
 * Critical for edge devices where:
 * - Watchdog depends on comprehensive health state
 * - Cloud telemetry reports detailed subsystem status
 * - False "healthy" signals must be eliminated
 * 
 * Architecture:
 * - Each subsystem registers with health arbiter
 * - Arbiter periodically checks all subsystems
 * - Watchdog queries arbiter for overall health
 * - Cloud telemetry includes detailed health report
 * 
 * Usage:
 *   const health = new HealthArbiter(logger);
 *   
 *   // Register subsystems
 *   health.registerSubsystem('mqtt', () => mqttClient.connected, { critical: true });
 *   health.registerSubsystem('memory', () => memoryHealthy(), { critical: true });
 *   
 *   // Watchdog uses centralized health
 *   startWatchdog(() => health.isHealthy(), logger);
 *   
 *   // Cloud telemetry includes health state
 *   cloudSync.report({ health: health.getHealthReport() });
 */

import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

/**
 * Subsystem health check function
 * Returns true if subsystem is healthy, false otherwise
 * Supports both synchronous and asynchronous checks
 */
export type SubsystemCheckFn = () => boolean | Promise<boolean>;

/**
 * Subsystem registration options
 */
export interface SubsystemOptions {
  /** If true, subsystem failure causes overall health failure */
  critical?: boolean;
  /** Human-readable description of subsystem */
  description?: string;
  /** Check interval in milliseconds (default: 30s) */
  checkIntervalMs?: number;
  /**
   * Cooldown period (ms) before allowing recovery after failure
   * Prevents flapping subsystems from masking failures
   * Default: 30s for critical, 0 for non-critical
   */
  recoveryCooldownMs?: number;
  /**
   * Minimum consecutive failures before permanently latching a critical subsystem.
   * Default: 2. The immediate startup check counts as failure #1 — requiring 2+ means
   * at least one periodic check must confirm the failure before the subsystem is latched.
   */
  minFailuresBeforeLatch?: number;
}

/**
 * Subsystem health state
 */
interface SubsystemHealth {
  name: string;
  checkFn: SubsystemCheckFn;
  critical: boolean;
  description?: string;
  healthy: boolean;
  lastCheck: number;
  lastError?: string;
  consecutiveFailures: number;
  checkIntervalMs: number;
  recoveryCooldownMs: number;
  minFailuresBeforeLatch: number;
  lastFailureTime: number;
  latched: boolean;
}

/**
 * Health report for telemetry
 */
export interface HealthReport {
  overall: boolean;
  subsystems: Array<{
    name: string;
    healthy: boolean;
    critical: boolean;
    description?: string;
    lastCheck: number;
    lastError?: string;
    consecutiveFailures: number;
  }>;
  unhealthySubsystems: string[];
  criticalFailures: string[];
}

/**
 * Centralized Health Arbiter
 * 
 * Manages health state for all agent subsystems.
 * Single source of truth for watchdog and telemetry.
 * 
 * Edge semantics (fail-fast over limp mode):
 * - Critical subsystem failures are latched permanently
 * - Cooldown periods prevent flapping
 * - Explicit markFatal() for unrecoverable errors
 */
export class HealthArbiter {
	private subsystems = new Map<string, SubsystemHealth>();
	private checkInterval: NodeJS.Timeout | null = null;
	private readonly DEFAULT_CHECK_INTERVAL_MS = 30000; // 30 seconds
	private readonly DEFAULT_CRITICAL_COOLDOWN_MS = 30000; // 30s cooldown for critical subsystems
	private fatalError: string | null = null; // Tracks fatal errors (unhandled rejections, etc.)
  
	constructor(private logger?: AgentLogger) {}
  
	/**
   * Set or update logger instance
   * Call after agent initialization completes
   */
	setLogger(logger: AgentLogger): void {
		this.logger = logger;
	}
  
	/**
   * Register a subsystem for health monitoring
   * 
   * @param name - Unique subsystem identifier (e.g., 'mqtt', 'vpn', 'memory')
   * @param checkFn - Function that returns true if subsystem is healthy
   * @param options - Registration options (critical, description, etc.)
   */
	registerSubsystem(
		name: string,
		checkFn: SubsystemCheckFn,
		options: SubsystemOptions = {}
	): void {
		const {
			critical = false,
			description,
			checkIntervalMs = this.DEFAULT_CHECK_INTERVAL_MS,
			recoveryCooldownMs = critical ? this.DEFAULT_CRITICAL_COOLDOWN_MS : 0,
			minFailuresBeforeLatch = 2,
		} = options;

		if (this.subsystems.has(name)) {
			this.logger?.warnSync('Subsystem already registered - replacing', {
				component: LogComponents.agent,
				operation: 'registerSubsystem',
				subsystem: name
			});
		}

		this.subsystems.set(name, {
			name,
			checkFn,
			critical,
			description,
			healthy: false,
			lastCheck: 0,
			consecutiveFailures: 0,
			checkIntervalMs,
			recoveryCooldownMs,
			minFailuresBeforeLatch,
			lastFailureTime: 0,
			latched: false
		});
    
		this.logger?.debugSync('Subsystem registered', {
			component: LogComponents.agent,
			operation: 'registerSubsystem',
			subsystem: name,
			critical,
			recoveryCooldownMs,
			description
		});
    
		// Perform immediate check for newly registered subsystem
		// Fire-and-forget: don't block registration
		void this.checkSubsystem(name);
	}
  
	/**
   * Unregister a subsystem from health monitoring
   */
	unregisterSubsystem(name: string): void {
		if (this.subsystems.delete(name)) {
			this.logger?.debugSync('Subsystem unregistered', {
				component: LogComponents.agent,
				operation: 'unregisterSubsystem',
				subsystem: name
			});
		}
	}
  
	/**
   * Check health of a specific subsystem
   * 
   * Edge semantics:
   * - Critical subsystem failures are latched (permanent until restart)
   * - Recovery cooldown prevents flapping
   * - Fail-fast over limp mode
   * 
   * @param name - Subsystem name
   * @returns true if healthy, false otherwise
   */
	private async checkSubsystem(name: string): Promise<boolean> {
		const subsystem = this.subsystems.get(name);
		if (!subsystem) {
			this.logger?.warnSync('Attempted to check unknown subsystem', {
				component: LogComponents.agent,
				operation: 'checkSubsystem',
				subsystem: name
			});
			return false;
		}
    
		// If subsystem is latched, it's permanently failed
		if (subsystem.latched) {
			this.logger?.debugSync('Subsystem check skipped - permanently latched', {
				component: LogComponents.agent,
				operation: 'checkSubsystem',
				subsystem: name,
				critical: subsystem.critical
			});
			return false;
		}
    
		try {
			const healthy = await subsystem.checkFn();
			const now = Date.now();
      
			// State transition: unhealthy → healthy
			if (healthy && !subsystem.healthy) {
				const previousFailures = subsystem.consecutiveFailures;

				// Enforce cooldown period for critical subsystems (prevents flapping)
				if (subsystem.critical && subsystem.lastFailureTime > 0) {
					const timeSinceFailure = now - subsystem.lastFailureTime;
					if (timeSinceFailure < subsystem.recoveryCooldownMs) {
						this.logger?.debugSync('Subsystem recovery suppressed - cooldown period active', {
							component: LogComponents.agent,
							operation: 'checkSubsystem',
							subsystem: name,
							timeSinceFailureMs: timeSinceFailure,
							cooldownRemainingMs: subsystem.recoveryCooldownMs - timeSinceFailure,
							reason: 'prevent_flapping'
						});
						// Keep unhealthy during cooldown
						subsystem.lastCheck = now;
						return false;
					}
				}

				// Suppress noisy initial transition logs at startup (0 prior failures).
				if (previousFailures > 0) {
					this.logger?.infoSync('Subsystem recovered', {
						component: LogComponents.agent,
						operation: 'checkSubsystem',
						subsystem: name,
						critical: subsystem.critical,
						previousFailures
					});
				}
			}
      
			// State transition: healthy → unhealthy
			if (!healthy) {
				subsystem.consecutiveFailures++;
				subsystem.lastFailureTime = now;
				subsystem.lastError = 'health_check_failed';

				// Latch critical subsystems permanently only after minFailuresBeforeLatch consecutive failures.
				// The immediate startup check counts as failure #1, so a threshold of 2 means
				// at least one periodic check must confirm failure before the subsystem is latched.
				if (subsystem.critical && subsystem.consecutiveFailures >= subsystem.minFailuresBeforeLatch) {
					subsystem.latched = true;
				}

				this.logger?.errorSync('Subsystem health check failed', undefined, {
					component: LogComponents.agent,
					operation: 'checkSubsystem',
					subsystem: name,
					critical: subsystem.critical,
					consecutiveFailures: subsystem.consecutiveFailures,
					description: subsystem.description,
					latched: subsystem.latched
				});
			} else {
				subsystem.consecutiveFailures = 0;
			}
      
			subsystem.healthy = healthy && !subsystem.latched; // Latched failures stay unhealthy
			subsystem.lastCheck = now;
			subsystem.lastError = healthy ? undefined : subsystem.lastError;
      
			return subsystem.healthy;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			subsystem.healthy = false;
			subsystem.lastCheck = Date.now();
			subsystem.lastError = errorMsg;
			subsystem.consecutiveFailures++;
      
			this.logger?.errorSync('Subsystem health check threw error', error instanceof Error ? error : undefined, {
				component: LogComponents.agent,
				operation: 'checkSubsystem',
				subsystem: name,
				critical: subsystem.critical,
				consecutiveFailures: subsystem.consecutiveFailures
			});
      
			return false;
		}
	}
  
	/**
   * Check overall system health
   * 
   * Returns false if ANY critical subsystem is unhealthy OR if fatal error marked.
   * This is the function watchdog should call.
   * 
   * @returns true if all critical subsystems healthy, false otherwise
   */
	async isHealthy(): Promise<boolean> {
		// Fail immediately if fatal error marked (unhandled rejection, uncaught exception)
		if (this.fatalError) {
			this.logger?.debugSync('Overall health check failed - fatal error marked', {
				component: LogComponents.agent,
				operation: 'isHealthy',
				fatalError: this.fatalError
			});
			return false;
		}
    
		// Check all subsystems on-demand
		for (const name of this.subsystems.keys()) {
			await this.checkSubsystem(name);
		}
    
		// Fail if ANY critical subsystem is unhealthy
		for (const [name, subsystem] of this.subsystems) {
			if (subsystem.critical && !subsystem.healthy) {
				this.logger?.debugSync('Overall health check failed', {
					component: LogComponents.agent,
					operation: 'isHealthy',
					failedSubsystem: name,
					consecutiveFailures: subsystem.consecutiveFailures
				});
				return false; // Fail fast
			}
		}
    
		return true;
	}
  
	/**
   * Mark agent as fatally unhealthy
   * 
   * This causes isHealthy() to return false, which withholds watchdog pings,
   * triggering systemd restart. Use for unrecoverable errors like:
   * - Unhandled promise rejections
   * - Uncaught exceptions
   * - Critical resource exhaustion
   * 
   * This is SAFER than calling process.exit() because:
   * - systemd handles the restart cleanly
   * - Avoids racing shutdown logic
   * - Restart reason is observable
   * - No risk of half-alive process
   * 
   * @param reason - Fatal error description (for observability)
   */
	markFatal(reason: string): void {
		this.fatalError = reason;
    
		this.logger?.errorSync('Agent marked as fatally unhealthy - systemd will restart', undefined, {
			component: LogComponents.agent,
			operation: 'markFatal',
			reason,
			consequence: 'watchdog_withheld_systemd_restart'
		});
	}
  
	/**
   * Get detailed health report for telemetry
   * 
   * Includes status of all subsystems (critical and non-critical).
   * Use this for cloud reporting and diagnostics.
   */
	getHealthReport(): HealthReport {
		const subsystems = Array.from(this.subsystems.values()).map(s => ({
			name: s.name,
			healthy: s.healthy,
			critical: s.critical,
			description: s.description,
			lastCheck: s.lastCheck,
			lastError: s.lastError,
			consecutiveFailures: s.consecutiveFailures
		}));
    
		const unhealthySubsystems = subsystems
			.filter(s => !s.healthy)
			.map(s => s.name);
    
		const criticalFailures = subsystems
			.filter(s => s.critical && !s.healthy)
			.map(s => s.name);
    
		const overall = criticalFailures.length === 0;
    
		return {
			overall,
			subsystems,
			unhealthySubsystems,
			criticalFailures
		};
	}
  
	/**
   * Start periodic health checks for all subsystems
   * 
   * @param intervalMs - Global check interval (default: 30s)
   */
	startPeriodicChecks(intervalMs: number = this.DEFAULT_CHECK_INTERVAL_MS): void {
		if (this.checkInterval) {
			this.logger?.warnSync('Periodic health checks already running', {
				component: LogComponents.agent,
				operation: 'startPeriodicChecks'
			});
			return;
		}
    
		this.logger?.debugSync('Starting periodic health checks', {
			component: LogComponents.agent,
			operation: 'startPeriodicChecks',
			intervalMs,
			registeredSubsystems: Array.from(this.subsystems.keys())
		});
    
		// Immediate check on start (fire-and-forget)
		void this.isHealthy();
    
		// Periodic checks
		this.checkInterval = setInterval(() => {
			void this.isHealthy(); // Fire-and-forget: checks all subsystems
		}, intervalMs);
	}
  
	/**
   * Stop periodic health checks and cleanup
   * Call during graceful shutdown
   */
	stop(): void {
		this.stopPeriodicChecks();
    
		this.logger?.infoSync('Health arbiter stopped', {
			component: LogComponents.agent,
			operation: 'stop'
		});
	}
  
	/**
   * Stop periodic health checks
   */
	stopPeriodicChecks(): void {
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
      
			this.logger?.infoSync('Periodic health checks stopped', {
				component: LogComponents.agent,
				operation: 'stopPeriodicChecks'
			});
		}
	}
}
