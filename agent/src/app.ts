/**
 * Device Application Entry Point
 * 
 * This is the main entry point for the device-side code.
 * Runs on the device (Raspberry Pi, etc.) and manages:
 * - Container lifecycle
 * - Device provisioning
 * - System monitoring
 * - Device API (for cloud communication)
 */

import process from 'process';
import { writeHeapSnapshot } from 'v8';
import { mkdirSync } from 'fs';
import { join } from 'path';
import Agent from './agent.js';
import { startWatchdog, notifySystemd, notifyReady } from './system/watchdog';
import { HealthArbiter } from './health/arbiter.js';
import { healthcheck } from './system/memory';
import { CloudMqttClient } from './mqtt';
import { DatabaseModel } from './db/models';
import { setHealthReporter } from './api/actions';

// Heap profiling for memory leak investigation
// Enable with: ENABLE_HEAP_PROFILING=true HEAP_SNAPSHOT_INTERVAL_MIN=5
if (process.env.ENABLE_HEAP_PROFILING === 'true') {
	const intervalMin = parseInt(process.env.HEAP_SNAPSHOT_INTERVAL_MIN || '5', 10);
	const snapshotDir = process.env.HEAP_SNAPSHOT_DIR || '/tmp/heap-snapshots';
	
	try {
		mkdirSync(snapshotDir, { recursive: true });
		console.log(`[PROFILING] Heap profiling enabled - snapshots every ${intervalMin} min → ${snapshotDir}`);
		
		setInterval(() => {
			try {
				const filename = join(snapshotDir, `heap-${Date.now()}.heapsnapshot`);
				writeHeapSnapshot(filename);
				const stats = process.memoryUsage();
				console.log(`[PROFILING] Heap snapshot written: ${filename}`, {
					heapUsedMB: (stats.heapUsed / 1024 / 1024).toFixed(2),
					heapTotalMB: (stats.heapTotal / 1024 / 1024).toFixed(2),
					rssMB: (stats.rss / 1024 / 1024).toFixed(2)
				});
			} catch (err) {
				console.error('[PROFILING] Failed to write heap snapshot:', err);
			}
		}, intervalMin * 60 * 1000);
	} catch (err) {
		console.error(`[PROFILING] Failed to create snapshot directory ${snapshotDir}:`, err);
	}
}

// Start the device agent
const agent = new Agent();

// Create centralized health arbiter (single source of truth for all subsystem health)
// Logger will be set after agent.init() completes
const health = new HealthArbiter();

// Register memory health subsystem (critical - memory leaks must trigger restart)
health.registerSubsystem('memory', async () => {
	const ok = await healthcheck();
	if (!ok) {
		// Memory leaks on edge devices are non-recoverable → latch fatal immediately
		agent.agentLogger?.errorSync('Memory health check failed - marking fatal', undefined, {
			component: 'main',
			operation: 'memoryHealth',
			action: 'markFatal'
		});
		health.markFatal('memory-health-failed');
	}
	return ok;
}, {
	critical: true,
	description: 'V8 heap memory health - detects leaks via growth rate analysis'
});

function registerRuntimeHealthSubsystems(): void {
	const isProvisioned = agent.isProvisioned();

	health.registerSubsystem('lifecycle', async () => {
		// Only checks lifecycle state — individual subsystem checks (mqtt, cloud-sync, database,
		// etc.) already cover their respective components. Calling isFullyOperational() here
		// creates a circular runtime re-check that triggers spurious restarts.
		return agent.getLifecycleState() === 'RUNNING';
	}, {
		critical: true,
		description: 'Agent lifecycle state (must be RUNNING)',
	});

	health.registerSubsystem('container-manager', async () => {
		try {
			agent.getContainerManager().getStatus();
			return true;
		} catch {
			return false;
		}
	}, {
		critical: true,
		description: 'Container manager status query',
	});

	health.registerSubsystem('database', async () => {
		try {
			return DatabaseModel.ping();
		} catch {
			return false;
		}
	}, {
		critical: true,
		description: 'SQLite query check',
	});

	health.registerSubsystem('agent-api', async () => {
		try {
			const port = process.env.DEVICE_API_PORT || '48484';
			const response = await fetch(`http://127.0.0.1:${port}/ping`, {
				signal: AbortSignal.timeout(3000),
			});
			return response.ok;
		} catch (err) {
			agent.agentLogger?.warnSync('Agent API ping failed', {
				component: 'agent',
				operation: 'health-agent-api',
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}, {
		// For provisioned devices (state loaded from SQLite), local API loss is degraded mode only.
		// For unprovisioned devices, keep critical so setup/provisioning remains restartable.
		// minFailuresBeforeLatch=2: the immediate startup check may fail transiently (busy event loop);
		// require a periodic check to confirm before permanently latching.
		critical: !isProvisioned,
		description: 'Local Agent API ping check',
		minFailuresBeforeLatch: 2,
	});

	health.registerSubsystem('mqtt', async () => {
		if (!isProvisioned) {
			return true;
		}
		return CloudMqttClient.getInstance().isConnected();
	}, {
		// Non-critical: temporary broker restarts must not force agent restarts.
		// MQTT has built-in reconnect; restarting the agent won't fix a downed broker.
		critical: false,
		description: 'MQTT broker connectivity',
	});

	health.registerSubsystem('cloud-sync', async () => {
		if (!isProvisioned) {
			return true;
		}
		return agent.getCloudSync()?.isOperational() === true;
	}, {
		// Non-critical: cloud outages must NOT trigger systemd restarts — the device must
		// operate standalone when the cloud is temporarily unreachable.
		critical: false,
		description: 'Cloud synchronization loop health',
	});
}

// Ready flag - prevents watchdog pings until agent fully initialized
// This ensures systemd startup timeout (not watchdog timeout) governs agent.init() duration
let ready = false;

// Start systemd watchdog with centralized health check
// CRITICAL: Watchdog is suppressed until READY=1 is sent to systemd
// This prevents premature timeouts during slow initialization (network, VPN, MQTT, TPM)
const stopWatchdog = startWatchdog(() => {
	if (!ready) return false; // Suppress pings until agent.init() completes
	return health.isHealthy(); // Check all critical subsystems
});

// Track if shutdown is in progress
let shuttingDown = false;

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
	if (shuttingDown) {
		console.log(`Already shutting down, ignoring ${signal}`);
		return;
	}
	
	shuttingDown = true;
	console.log(`\n${signal} received. Starting graceful shutdown...`);

	// Hard timeout to avoid hang during shutdown (edge devices may stall)
	const shutdownTimeout = setTimeout(() => {
		console.error('Graceful shutdown timed out, forcing exit');
		process.exit(1);
	}, 20_000);

	try {
		// Stop health checks first so watchdog stops sending pings
		health.stop();

		// Stop watchdog timer next (no further WATCHDOG=1 messages)
		stopWatchdog();

		// Notify systemd we're stopping (final meaningful signal)
		notifySystemd('STOPPING=1');

		// Stop the agent (closes Device API, MQTT, etc.)
		await agent.stop();
		clearTimeout(shutdownTimeout);
		process.exit(0);
	} catch (error) {
		clearTimeout(shutdownTimeout);
		console.error('Error during shutdown:', error);
		process.exit(1);
	}
}

// Register signal handlers for graceful shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGQUIT', () => gracefulShutdown('SIGQUIT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Handle unhandled promise rejections
// DO NOT immediately shutdown - let systemd restart us via watchdog
process.on('unhandledRejection', (reason, promise) => {
	const errorMsg = reason instanceof Error ? reason.message : String(reason);
	const stack = reason instanceof Error ? reason.stack : undefined;
	
	// Log error with full context (visible in journalctl)
	agent.agentLogger?.errorSync('Unhandled promise rejection detected', reason instanceof Error ? reason : undefined, {
		component: 'main',
		operation: 'unhandledRejection',
		reason: errorMsg,
		stack,
		promise: String(promise)
	});
	
	// Mark health as fatal - watchdog will withhold pings → systemd restarts us
	// This is SAFER than process.exit() because:
	// - systemd handles restart cleanly
	// - No racing shutdown logic
	// - Restart reason is observable in logs
	// - No risk of half-alive process
	health.markFatal(`unhandledRejection: ${errorMsg}`);
	
	// Do NOT call gracefulShutdown or process.exit here
	// Let systemd restart us after WatchdogSec timeout
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
	// Log error with full context
	agent.agentLogger?.errorSync('Uncaught exception detected', error, {
		component: 'main',
		operation: 'uncaughtException',
		message: error.message,
		stack: error.stack
	});
	
	// Mark health as fatal - systemd will restart us
	health.markFatal(`uncaughtException: ${error.message}`);
	
	// Do NOT call process.exit here - let systemd restart us
});

// Start the device agent
agent.init()
	.then(async () => {
		const ciReadyMode = process.env.CI === 'true' || process.env.SYSTEMD_READY_MODE === 'ci';

		// Verify agent is fully operational before marking ready
		// READY=1 semantics: "Restarting me after this point is meaningful"
		if (!ciReadyMode && !agent.isFullyOperational()) {
			throw new Error('Agent initialized but not fully operational - missing critical components');
		}

		if (ciReadyMode && !agent.isFullyOperational()) {
			console.warn('[READY] CI readiness mode active - skipping strict isFullyOperational gate');
		}
    
		// Set logger after agent initialization
		health.setLogger(agent.agentLogger);
		setHealthReporter(() => health.getHealthReport());
		registerRuntimeHealthSubsystems();
		// Start periodic health checks (includes memory) on fixed cadence
		health.startPeriodicChecks(parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '30000', 10));
    
		// Mark agent as ready - enables watchdog pings
		// IMPORTANT: Set this BEFORE notifyReady() to ensure health checks work
		ready = true;
    
		// Notify systemd agent is fully initialized and ready
		// Only after: database, logging, device API, MQTT (if provisioned), CloudSync (if provisioned)
		// From this point, watchdog timeout (WatchdogSec) applies, not startup timeout
		await notifyReady();

	})
	.catch((error) => {
		console.error('Failed to initialize device agent:', error);
		process.exit(1);
	});
