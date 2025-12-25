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
import { startWatchdog, notifySystemd } from './systemd-watchdog';

// Start the device agent
const agent = new DeviceAgent();

// Start systemd watchdog (automatically detects if running under systemd)
const stopWatchdog = startWatchdog();

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
		notifySystemd('STOPPING=1');
		
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
agent.init().catch((error) => {
	console.error('Failed to initialize device agent:', error);
	process.exit(1);
});
