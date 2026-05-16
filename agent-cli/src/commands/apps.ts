import { DEVICE_API_V1, CLIError, logger, apiCached, apiRequest, clearApiCache, requireConfirmation } from '../core';

/**
 * iotctl apps list
 */
export async function appsList(): Promise<void> {
  clearApiCache();
  try {
    const deviceState = await apiCached(`${DEVICE_API_V1}/device`);
    const apps = deviceState.apps || {};

    if (Object.keys(apps).length === 0) {
      logger.info('No applications configured');
      return;
    }

    logger.info('Applications');

    for (const appId in apps) {
      const app = apps[appId];
      const appInfo: any = {
        appId,
        appName: app.appName || 'Unknown',
      };

      if (app.services && app.services.length > 0) {
        appInfo.services = app.services.map((service: any) => ({
          name: service.serviceName,
          status: service.status,
          containerId: service.containerId?.substring(0, 12),
        }));
      }

      logger.info(`App ${appId}`, appInfo);
    }
  } catch (error) {
    throw new CLIError('Failed to list applications', 1, {
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl apps start <appId>
 */
export async function appsStart(appId: string): Promise<void> {
  if (!appId) {
    throw new CLIError('Application ID is required', 1, {
      usage: 'iotctl apps start <appId>',
    });
  }

  try {
    logger.info('Starting application', { appId });
    const result = await apiRequest(`${DEVICE_API_V1}/apps/${appId}/start`, {
      method: 'POST',
      body: JSON.stringify({ force: false }),
    });

    logger.info('Application started', {
      appId,
      containerId: result.containerId,
    });
  } catch (error) {
    throw new CLIError('Failed to start application', 1, {
      appId,
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl apps stop <appId>
 */
export async function appsStop(appId: string): Promise<void> {
  if (!appId) {
    throw new CLIError('Application ID is required', 1, {
      usage: 'iotctl apps stop <appId>',
    });
  }

  try {
    logger.info('Stopping application', { appId });
    const result = await apiRequest(`${DEVICE_API_V1}/apps/${appId}/stop`, {
      method: 'POST',
      body: JSON.stringify({ force: false }),
    });

    logger.info('Application stopped', {
      appId,
      containerId: result.containerId,
    });
  } catch (error) {
    throw new CLIError('Failed to stop application', 1, {
      appId,
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl apps restart <appId>
 */
export async function appsRestart(appId: string): Promise<void> {
  if (!appId) {
    throw new CLIError('Application ID is required', 1, {
      usage: 'iotctl apps restart <appId>',
    });
  }

  try {
    logger.info('Restarting application', { appId });
    await apiRequest(`${DEVICE_API_V1}/restart`, {
      method: 'POST',
      body: JSON.stringify({ appId, force: false }),
    });

    logger.info('Application restarted', { appId });
  } catch (error) {
    throw new CLIError('Failed to restart application', 1, {
      appId,
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl apps info <appId>
 */
export async function appsInfo(appId: string): Promise<void> {
  if (!appId) {
    throw new CLIError('Application ID is required', 1, {
      usage: 'iotctl apps info <appId>',
    });
  }

  try {
    const app = await apiRequest(`${DEVICE_API_V1}/apps/${appId}`);
    logger.info('Application details', { appId, details: app });
  } catch (error) {
    throw new CLIError('Failed to get application info', 1, {
      appId,
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl apps purge <appId>
 */
export async function appsPurge(appId: string): Promise<void> {
  if (!appId) {
    throw new CLIError('Application ID is required', 1, {
      usage: 'iotctl apps purge <appId>',
    });
  }

  try {
    logger.warn('Purging application data', {
      appId,
      warning: 'This removes all volumes and data',
    });

    requireConfirmation(`Purge will remove ALL data for app ${appId}. This cannot be undone.`);

    await apiRequest(`${DEVICE_API_V1}/purge`, {
      method: 'POST',
      body: JSON.stringify({ appId, force: true }),
    });

    logger.info('Application data purged', { appId });
  } catch (error) {
    throw new CLIError('Failed to purge application', 1, {
      appId,
      error: (error as Error).message,
    });
  }
}
