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

// Start the device agent
const agent = new DeviceAgent();

// Create centralized health arbiter (single source of truth for all subsystem health)
// Logger will be set after agent.init() completes
const health = new HealthArbiter();

// Register memory health subsystem (critical - memory leaks must trigger restart)
health.registerSubsystem('memory', () => healthcheck(), {
  critical: true,
  description: 'V8 heap memory health - detects leaks via growth rate analysis'
});

// TODO: Add other subsystems as they're integrated:
// health.registerSubsystem('mqtt', () => mqttClient?.connected ?? false, { critical: true });
// health.registerSubsystem('vpn', () => vpnTunnel?.isConnected() ?? false, { critical: true });
// health.registerSubsystem('cloudSync', () => cloudSync?.isHealthy() ?? false, { critical: true });
// health.registerSubsystem('discovery', () => discoveryService?.isResponsive() ?? false, { critical: false });

// Start systemd watchdog with centralized health check
// Watchdog only sends WATCHDOG=1 if ALL critical subsystems are healthy
// Logger will be set after agent.init() completes
const stopWatchdog = startWatchdog(() => health.isHealthy());

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

	try {
		// Notify systemd we're stopping
		await notifySystemd('STOPPING=1');
		
		// Stop health arbiter (prevents watchdog pings during shutdown)
		health.stop();
		
		// Stop watchdog
		stopWatchdog();
		
		// Stop the agent (closes Device API, MQTT, etc.)
		await agent.stop();
		process.exit(0);
	} catch (error) {
		console.error('Error during shutdown:', error);
		process.exit(1);
	}
}

// Register signal handlers for graceful shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Catch unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
	console.error('Unhandled Rejection at:', promise, 'reason:', reason);
	// Don't exit immediately - try graceful shutdown first
	gracefulShutdown('unhandledRejection');
});

// Start the device agent
agent.init()
  .then(() => {
    // Set loggers after agent initialization
    health.setLogger(agent.agentLogger);
    // Note: Watchdog logger is set via startWatchdog call, but we can't update it dynamically
    // This is acceptable since watchdog logging is less critical than health arbiter logging
    
    // Notify systemd agent is fully initialized and ready
    // Only after: config loaded, API started, MQTT connected, etc.
    notifyReady();
    agent.agentLogger?.infoSync('Agent initialization complete, systemd notified', { component: 'main' });
  })
  .catch((error) => {
    console.error('Failed to initialize device agent:', error);
    process.exit(1);
  });
