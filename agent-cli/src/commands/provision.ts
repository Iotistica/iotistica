import { DEVICE_API_BASE, DEVICE_API_V1, CLIError, logger, apiCached, apiRequest, clearApiCache, redact, requireConfirmation, validateUrl } from '../core';

/**
 * iotctl provision <key> --api <endpoint> [--name <device-name>] [--type <device-type>]
 */
export async function provisionWithKey(key: string): Promise<void> {
  if (!key) {
    throw new CLIError('Provisioning key is required', 1, {
      usage: 'iotctl provision <key> --api <endpoint> [--name <device-name>] [--type <device-type>]',
    });
  }

  try {
    const args = process.argv.slice(2);
    const apiIndex = args.indexOf('--api');
    const nameIndex = args.indexOf('--name');
    const typeIndex = args.indexOf('--type');

    const config: any = {
      provisioningApiKey: key,
    };

    if (apiIndex === -1 || !args[apiIndex + 1]) {
      throw new CLIError('The --api argument is required for provisioning', 1, {
        usage: 'iotctl provision <key> --api <endpoint> [--name <device-name>] [--type <device-type>]',
        hint: 'Example: iotctl provision <key> --api https://localhost:3443',
      });
    }

    config.apiEndpoint = args[apiIndex + 1];
    if (!validateUrl(config.apiEndpoint)) {
      throw new CLIError('Invalid --api endpoint', 1, {
        apiEndpoint: config.apiEndpoint,
        hint: 'Use a full http:// or https:// URL',
      });
    }

    if (nameIndex !== -1 && args[nameIndex + 1]) {
      config.deviceName = args[nameIndex + 1];
    }

    if (typeIndex !== -1 && args[typeIndex + 1]) {
      config.deviceType = args[typeIndex + 1];
    }

    logger.info('Provisioning device', {
      apiEndpoint: config.apiEndpoint,
      deviceName: config.deviceName || 'auto-generated',
    });

    const result = await apiRequest(`${DEVICE_API_V1}/provision`, {
      method: 'POST',
      body: JSON.stringify(config),
    });

    logger.info('Agent provisioned successfully', {
      uuid: redact(result.device.uuid),
      deviceId: redact(result.device.deviceId),
      deviceName: result.device.deviceName,
      mqttBrokerUrl: redact(result.device.mqttBrokerUrl),
    });

    logger.warn('Restart the agent to apply provisioned cloud configuration', {
      hint: 'Provisioning state is saved immediately, but MQTT/cloud-dependent features initialize on startup',
    });
  } catch {
    throw new CLIError('Provisioning failed', 1);
  }
}

/**
 * iotctl provision status
 */
export async function provisionStatus(): Promise<void> {
  clearApiCache();
  try {
    const status = await apiCached(`${DEVICE_API_V1}/provision/status`);

    logger.info('Provisioning status', {
      provisioned: status.provisioned,
      uuid: redact(status.uuid),
      deviceId: redact(status.deviceId),
      deviceName: status.deviceName || 'not set',
      apiEndpoint: status.apiEndpoint || 'not set',
      mqttConfigured: status.mqttConfigured,
    });

    if (!status.provisioned) {
      logger.info('Device not provisioned', {
        hint: 'Use "iotctl provision <key> --api <endpoint>" to provision this device',
      });
    }
  } catch {
    throw new CLIError('Failed to get provisioning status', 1);
  }
}

/**
 * iotctl deprovision
 */
export async function deprovision(): Promise<void> {
  try {
    logger.warn('Deprovisioning device - this will remove cloud registration');
    requireConfirmation('Deprovision will remove cloud registration. Continue?');

    const result = await apiRequest(`${DEVICE_API_V1}/deprovision`, {
      method: 'POST',
    });

    logger.info('Device deprovisioned', {
      message: result.message,
      status: result.status,
    });
  } catch (error) {
    throw new CLIError('Deprovision failed', 1, {
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl mqtt users
 */
export async function mqttListUsers(): Promise<void> {
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
      throw new CLIError('Cannot connect to agent API', 1, {
        endpoint: DEVICE_API_BASE,
        hint: 'Make sure the agent is running',
      });
    }
    throw new CLIError('Failed to retrieve MQTT users', 1, {
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl factory-reset
 */
export async function factoryReset(): Promise<void> {
  try {
    logger.warn('WARNING: Factory reset will DELETE ALL DATA');
    logger.warn('This includes all apps, services, state snapshots, and sensor data');
    logger.warn('Only the device UUID will be preserved');
    logger.warn('This action cannot be undone');

    requireConfirmation('Factory reset will DELETE ALL DATA. This cannot be undone.');

    const result = await apiRequest(`${DEVICE_API_V1}/factory-reset`, {
      method: 'POST',
    });

    logger.info('Factory reset complete', {
      message: result.message,
      status: result.status,
    });
  } catch {
    throw new CLIError('Factory reset failed', 1);
  }
}
