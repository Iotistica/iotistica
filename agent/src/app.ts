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
import DeviceAgent from './agent';
import { startWatchdog, notifySystemd, notifyReady } from './system/systemd-watchdog';
import { HealthArbiter } from './health/health-arbiter';
import { healthcheck } from './system/memory';
import { version as packageVersion } from '../package.json';

// Start the device agent
const agent = new DeviceAgent();

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

// TODO: Add other subsystems as they're integrated:
// health.registerSubsystem('mqtt', () => mqttClient?.connected ?? false, { critical: true });
// health.registerSubsystem('vpn', () => vpnTunnel?.isConnected() ?? false, { critical: true });
// health.registerSubsystem('cloudSync', () => cloudSync?.isHealthy() ?? false, { critical: true });
// health.registerSubsystem('discovery', () => discoveryService?.isResponsive() ?? false, { critical: false });

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
		await notifySystemd('STOPPING=1');

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
  .then(() => {
    // Verify agent is fully operational before marking ready
    // READY=1 semantics: "Restarting me after this point is meaningful"
    if (!agent.isFullyOperational()) {
      throw new Error('Agent initialized but not fully operational - missing critical components');
    }

		// Log service context for observability/post-mortems
		agent.agentLogger?.infoSync('Service context', {
			component: 'main',
			operation: 'startup_context',
			unit: process.env.SYSTEMD_UNIT || 'unknown',
			invocation: process.env.INVOCATION_ID || 'unknown',
			watchdogUsec: process.env.WATCHDOG_USEC || 'unknown',
			agentVersion: packageVersion
		});
    
    // Set logger after agent initialization
    health.setLogger(agent.agentLogger);
		// Start periodic health checks (includes memory) on fixed cadence
		health.startPeriodicChecks();
    
    // Mark agent as ready - enables watchdog pings
    // IMPORTANT: Set this BEFORE notifyReady() to ensure health checks work
    ready = true;
    
    // Notify systemd agent is fully initialized and ready
    // Only after: database, logging, device API, MQTT (if provisioned), CloudSync (if provisioned)
    // From this point, watchdog timeout (WatchdogSec) applies, not startup timeout
    notifyReady();
    agent.agentLogger?.infoSync('Agent fully operational, systemd notified READY=1', { 
      component: 'main',
      provisioned: agent.getDeviceManager().isProvisioned()
    });
  })
  .catch((error) => {
    console.error('Failed to initialize device agent:', error);
    process.exit(1);
  });
