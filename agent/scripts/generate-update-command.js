#!/usr/bin/env node

/**
 * Generate Signed Update Command
 * 
 * Creates a cryptographically signed update command for the agent.
 * Prevents replay attacks and stale message execution.
 * 
 * Usage:
 *   UPDATE_COMMAND_SECRET=your-secret node generate-update-command.js <version> [options]
 * 
 * Options:
 *   --force                Force update even if same version
 *   --schedule <ISO8601>   Schedule update for specific time
 *   --ttl <seconds>        Time-to-live (default: 3600 = 1 hour)
 * 
 * Example:
 *   UPDATE_COMMAND_SECRET=mysecret node generate-update-command.js 1.0.230
 *   UPDATE_COMMAND_SECRET=mysecret node generate-update-command.js 1.0.230 --force --ttl 7200
 *   UPDATE_COMMAND_SECRET=mysecret node generate-update-command.js 1.0.230 --schedule "2025-12-26T10:00:00Z"
 */

const crypto = require('crypto');

// Parse arguments
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log('Usage: UPDATE_COMMAND_SECRET=secret node generate-update-command.js <version> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --force                Force update even if same version');
  console.log('  --schedule <ISO8601>   Schedule update for specific time');
  console.log('  --ttl <seconds>        Time-to-live in seconds (default: 3600 = 1 hour)');
  console.log('');
  console.log('Example:');
  console.log('  UPDATE_COMMAND_SECRET=mysecret node generate-update-command.js 1.0.230');
  console.log('  UPDATE_COMMAND_SECRET=mysecret node generate-update-command.js 1.0.230 --force --ttl 7200');
  console.log('  UPDATE_COMMAND_SECRET=mysecret node generate-update-command.js 1.0.230 --schedule "2025-12-26T10:00:00Z"');
  process.exit(0);
}

const version = args[0];
let force = false;
let scheduledTime = null;
let ttl = 3600; // Default: 1 hour

// Parse options
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--force') {
    force = true;
  } else if (args[i] === '--schedule') {
    scheduledTime = args[++i];
  } else if (args[i] === '--ttl') {
    ttl = parseInt(args[++i], 10);
  }
}

// Validate inputs
const secret = process.env.UPDATE_COMMAND_SECRET;
if (!secret) {
  console.error('Error: UPDATE_COMMAND_SECRET environment variable not set');
  console.error('Set it with: export UPDATE_COMMAND_SECRET=your-secret-key');
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`Error: Invalid version format: ${version}`);
  console.error('Expected semver format (e.g., 1.0.230)');
  process.exit(1);
}

if (isNaN(ttl) || ttl <= 0) {
  console.error(`Error: Invalid TTL: ${ttl}`);
  console.error('TTL must be a positive number (seconds)');
  process.exit(1);
}

// Build command
const issuedAt = Date.now();
const expiresAt = issuedAt + (ttl * 1000);

const command = {
  action: 'update',
  version,
  issued_at: issuedAt,
  expires_at: expiresAt
};

if (force) {
  command.force = true;
}

if (scheduledTime) {
  command.scheduled_time = scheduledTime;
}

// Create canonical string (must match agent logic exactly)
const canonicalString = [
  command.action,
  command.version,
  command.issued_at.toString(),
  command.expires_at?.toString() || '',
  command.scheduled_time || '',
  command.force?.toString() || ''
].join('|');

// Compute HMAC-SHA256 signature
const signature = crypto
  .createHmac('sha256', secret)
  .update(canonicalString)
  .digest('hex');

command.signature = signature;

// Output
console.log('Signed Update Command:');
console.log('='.repeat(80));
console.log(JSON.stringify(command, null, 2));
console.log('='.repeat(80));
console.log('');
console.log('Command Details:');
console.log(`  Version:        ${version}`);
console.log(`  Force:          ${force}`);
console.log(`  Scheduled:      ${scheduledTime || 'immediate'}`);
console.log(`  Issued At:      ${new Date(issuedAt).toISOString()}`);
console.log(`  Expires At:     ${new Date(expiresAt).toISOString()}`);
console.log(`  TTL:            ${ttl} seconds (${Math.round(ttl / 60)} minutes)`);
console.log(`  Signature:      ${signature.substring(0, 16)}...`);
console.log('');
console.log('Publish to MQTT:');
console.log(`  mosquitto_pub -h <broker> -t "iot/device/<uuid>/agent/update" -m '${JSON.stringify(command)}'`);
console.log('');
