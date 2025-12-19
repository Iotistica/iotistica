/**
 * Quick script to inject default config for specific device
 * Run with: ts-node inject-config-for-device-direct.ts
 */

import { query } from '../../src/db/connection';
import { SystemConfigModel } from '../../src/db/system-config-model';
import { generateDefaultTargetState } from '../../src/services/default-target-state-generator';

const DEVICE_UUID = 'cad1a747-44e0-4530-87c8-944d4981a42c';

async function injectConfig() {
  console.log('🔧 Injecting default target state config...');
  console.log(`   Device UUID: ${DEVICE_UUID}\n`);

  try {
    // Check if device exists
    const deviceCheck = await query(
      'SELECT uuid, device_name, provisioned_at FROM devices WHERE uuid = $1',
      [DEVICE_UUID]
    );

    if (deviceCheck.rows.length === 0) {
      console.error(`❌ Device ${DEVICE_UUID} not found!`);
      process.exit(1);
    }

    const device = deviceCheck.rows[0];
    console.log(`✅ Device found: ${device.device_name || 'Unnamed'}`);
    console.log(`   Provisioned: ${device.provisioned_at?.toISOString() || 'unknown'}\n`);

    // Get license data
    const licenseData = await SystemConfigModel.get('license_data');
    
    if (!licenseData) {
      console.log('⚠️  No license data found - using default trial config');
    } else {
      console.log(`📋 License: ${licenseData.plan || 'unknown'} plan`);
      console.log(`   Subscription: ${licenseData.subscription?.status || 'unknown'}\n`);
    }

    // Generate default config
    const { apps, config } = await generateDefaultTargetState(licenseData);

    console.log('Generated config:');
    console.log(`   - Metrics Interval: ${config.settings.metricsIntervalMs}ms (${config.settings.metricsIntervalMs / 1000}s)`);
    console.log(`   - Device Report Interval: ${config.settings.deviceReportIntervalMs}ms`);
    console.log(`   - State Report Interval: ${config.settings.stateReportIntervalMs}ms`);
    console.log(`   - Cloud Jobs: ${config.features.enableCloudJobs ? 'Enabled' : 'Disabled'}`);
    console.log(`   - Metrics Export: ${config.features.enableMetricsExport ? 'Enabled' : 'Disabled'}`);
    console.log(`   - Logging Level: ${config.logging.level}\n`);

    // Insert or update target state
    const result = await query(
      `INSERT INTO device_target_state (device_uuid, apps, config, version, updated_at)
       VALUES ($1, $2, $3, 1, CURRENT_TIMESTAMP)
       ON CONFLICT (device_uuid) DO UPDATE SET
         apps = $2,
         config = $3,
         version = device_target_state.version + 1,
         updated_at = CURRENT_TIMESTAMP
       RETURNING device_uuid, version, updated_at`,
      [DEVICE_UUID, JSON.stringify(apps), JSON.stringify(config)]
    );

    const updated = result.rows[0];
    console.log('✅ Target state created/updated successfully!');
    console.log(`   Version: ${updated.version}`);
    console.log(`   Updated: ${updated.updated_at.toISOString()}\n`);

    console.log('💡 Agent will pick up new config within 10 seconds');
    console.log(`   Metrics should start appearing within ${config.settings.metricsIntervalMs / 1000}s!`);

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }

  process.exit(0);
}

injectConfig();
