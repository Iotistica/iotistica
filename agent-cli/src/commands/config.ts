import {
  DEVICE_API_V1,
  CLIError,
  logger,
  validateUrl,
  clearApiCache,
  apiCached,
  apiRequest,
  redact,
} from '../core';

/**
 * iotctl config set-api <url>
 */
export async function configSetApi(url: string): Promise<void> {
  if (!url) {
    throw new CLIError('API URL is required', 1, {
      usage: 'iotctl config set-api <url>',
    });
  }

  if (!validateUrl(url)) {
    throw new CLIError('Invalid URL format', 1, {
      hint: 'URL must start with http:// or https://',
    });
  }

  url = url.replace(/\/$/, '');

  try {
    await apiRequest(`${DEVICE_API_V1}/config`, {
      method: 'POST',
      body: JSON.stringify({ cloudApiEndpoint: url }),
    });

    logger.info('Cloud API endpoint updated', { endpoint: url });
    logger.warn('Restart required', {
      hint: 'Run: iotctl restart',
    });
  } catch {
    throw new CLIError('Failed to update API endpoint', 1);
  }
}

/**
 * iotctl config get-api
 */
export async function configGetApi(): Promise<void> {
  clearApiCache();
  try {
    const provisionStatus = await apiCached(`${DEVICE_API_V1}/provision/status`);

    if (provisionStatus.apiEndpoint) {
      logger.info('Cloud API Endpoint', { endpoint: provisionStatus.apiEndpoint });
    } else {
      logger.warn('Cloud API endpoint not configured');
    }
  } catch {
    throw new CLIError('Failed to retrieve API endpoint', 1);
  }
}

/**
 * iotctl config set <key> <value>
 */
export async function configSet(key: string, value: string): Promise<void> {
  if (!key || !value) {
    throw new CLIError('Both key and value are required', 1, {
      usage: 'iotctl config set <key> <value>',
    });
  }

  let parsedValue: any = value;
  try {
    parsedValue = JSON.parse(value);
  } catch {
    // Keep as string if not valid JSON
  }

  try {
    await apiRequest(`${DEVICE_API_V1}/config`, {
      method: 'POST',
      body: JSON.stringify({ [key]: parsedValue }),
    });

    logger.info('Configuration updated', { key, value: parsedValue });
  } catch (error) {
    throw new CLIError('Failed to update configuration', 1, {
      key,
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl config get <key>
 */
export async function configGet(key: string): Promise<void> {
  if (!key) {
    throw new CLIError('Key is required', 1, {
      usage: 'iotctl config get <key>',
    });
  }

  clearApiCache();
  try {
    const deviceState = await apiCached(`${DEVICE_API_V1}/device`);
    const config = deviceState.config || {};

    if (key in config) {
      logger.info('Configuration value', { key, value: config[key] });
    } else {
      logger.warn('Configuration key not found', { key });
    }
  } catch (error) {
    throw new CLIError('Failed to retrieve configuration', 1, {
      key,
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl config show
 */
export async function configShow(): Promise<void> {
  clearApiCache();
  try {
    const deviceState = await apiCached(`${DEVICE_API_V1}/device`);
    const provisionStatus = await apiCached(`${DEVICE_API_V1}/provision/status`);

    const config = {
      uuid: redact(deviceState.uuid),
      deviceId: redact(provisionStatus.deviceId),
      deviceName: provisionStatus.deviceName || 'not set',
      cloudApiEndpoint: provisionStatus.apiEndpoint || 'not configured',
      mqttConfigured: provisionStatus.mqttConfigured || false,
      provisioned: provisionStatus.provisioned || false,
      online: deviceState.is_online || false,
      version: deviceState.version || 0,
    };

    logger.info('Device Configuration', config);
  } catch (error) {
    logger.error('Failed to retrieve configuration', error as Error, {
      hint: 'Ensure the agent is running',
    });
  }
}

/**
 * iotctl config reset
 */
export async function configReset(): Promise<void> {
  try {
    await apiRequest(`${DEVICE_API_V1}/factory-reset`, {
      method: 'POST',
    });
    logger.info('Configuration reset to factory defaults');
    logger.warn('Device needs to be re-provisioned');
  } catch (error) {
    throw new CLIError('Failed to reset configuration', 1, {
      error: (error as Error).message,
    });
  }
}
