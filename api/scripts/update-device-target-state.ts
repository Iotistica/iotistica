/**
 * Update Device Target State
 * 
 * This script updates the target state config for an existing device.
 * Use this to fix devices that were created before the default config changes.
 * 
 * Usage:
 *   npm run ts-node api/scripts/update-device-target-state.ts <device-uuid>
 */

import { query } from '../src/db/connection';
import { generateDefaultTargetState } from '../src/services/default-target-state-generator';
import { configService } from '../src/services/config.service';

async function updateDeviceTargetState(deviceUuid: string): Promise<void> {
  console.log(`\n📋 Updating target state for device: ${deviceUuid}\n`);

  try {
    // Check if device exists
    const deviceCheck = await query(
      'SELECT uuid, device_name FROM devices WHERE uuid = $1',
      [deviceUuid]
    );

    if (deviceCheck.rows.length === 0) {
      console.error(`❌ Device ${deviceUuid} not found in database`);
      process.exit(1);
    }

    const device = deviceCheck.rows[0];
    console.log(`✅ Found device: ${device.device_name || 'Unknown'} (${deviceUuid})\n`);

    // Get current target state
    const currentStateResult = await query(
      'SELECT * FROM device_target_state WHERE device_uuid = $1',
      [deviceUuid]
    );

    if (currentStateResult.rows.length === 0) {
      console.log('⚠️  No target state found - will create new one');
    } else {
      const currentState = currentStateResult.rows[0];
      console.log('Current target state:');
      console.log(`  - Version: ${currentState.version}`);
      console.log(`  - Apps: ${JSON.stringify(currentState.apps).substring(0, 100)}...`);
      console.log(`  - Config keys: ${Object.keys(currentState.config || {}).join(', ') || 'EMPTY'}`);
      console.log(`  - Needs deployment: ${currentState.needs_deployment}`);
      console.log(`  - Last updated: ${currentState.updated_at}\n`);
    }

    // Generate new default config
    const licenseData = await configService.get('license_data');
    const { apps, config } = generateDefaultTargetState(licenseData);

    console.log('Generated new config with keys:');
    console.log(`  - ${Object.keys(config).join(', ')}\n`);

    console.log('Config details:');
    if (config.intervals) {
      console.log('  Intervals:');
      console.log(`    - Discovery light: ${config.intervals.discoveryLightIntervalMs}ms`);
      console.log(`    - Discovery full: ${config.intervals.discoveryFullIntervalMs}ms`);
    }
    if (config.protocols) {
      console.log('  Protocols:');
      const protocols = Object.keys(config.protocols);
      protocols.forEach(protocol => {
        const protoConfig = config.protocols[protocol];
        console.log(`    - ${protocol}: enabled=${protoConfig.enabled}, tcpHost=${protoConfig.tcpHost || 'N/A'}`);
      });
    }
    if (config.features) {
      console.log('  Features:');
      Object.entries(config.features).forEach(([key, value]) => {
        console.log(`    - ${key}: ${value}`);
      });
    }
    console.log('');

    // Update target state
    const result = await query(
      `UPDATE device_target_state SET
         config = $2,
         needs_deployment = false,
         updated_at = CURRENT_TIMESTAMP
       WHERE device_uuid = $1
       RETURNING *`,
      [deviceUuid, JSON.stringify(config)]
    );

    if (result.rows.length === 0) {
      // No existing state - insert new one
      console.log('Creating new target state...');
      await query(
        `INSERT INTO device_target_state (device_uuid, apps, config, version, needs_deployment, updated_at)
         VALUES ($1, $2, $3, 1, false, CURRENT_TIMESTAMP)`,
        [deviceUuid, JSON.stringify(apps), JSON.stringify(config)]
      );
    }

    console.log('✅ Target state updated successfully!\n');
    console.log('📡 The device will pick up the new config on its next poll (within 60 seconds).\n');

  } catch (error: any) {
    console.error('❌ Error updating target state:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

// Get device UUID from command line
const deviceUuid = process.argv[2];

if (!deviceUuid) {
  console.error('Usage: npm run ts-node api/scripts/update-device-target-state.ts <device-uuid>');
  process.exit(1);
}

updateDeviceTargetState(deviceUuid);
