import { spawn } from 'child_process';
import { DEVICE_API_V1, CLIError, ENV, logger, apiCached, apiRequest, clearApiCache } from '../core';

/**
 * iotctl services list [<appId>]
 */
export async function servicesList(appId?: string): Promise<void> {
  clearApiCache();
  try {
    const deviceState = await apiCached(`${DEVICE_API_V1}/device`);
    const apps = deviceState.apps || {};

    let totalServices = 0;

    for (const currentAppId in apps) {
      if (appId && currentAppId !== appId) {
        continue;
      }

      const app = apps[currentAppId];
      const services = app.services || [];

      if (services.length === 0) {
        continue;
      }

      logger.info(`App ${currentAppId} (${app.appName || 'Unknown'})`, {
        serviceCount: services.length,
      });

      for (const service of services) {
        logger.info(`  Service: ${service.serviceName}`, {
          serviceId: service.serviceId,
          status: service.status,
          containerId: service.containerId?.substring(0, 12),
          image: service.imageName,
          state: service.state || 'running',
        });
        totalServices++;
      }
    }

    if (totalServices === 0) {
      if (appId) {
        logger.info('No services found for application', { appId });
      } else {
        logger.info('No services configured');
      }
    } else {
      logger.info(`Total services: ${totalServices}`);
    }
  } catch (error) {
    throw new CLIError('Failed to list services', 1, {
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl services start <serviceId>
 */
export async function servicesStart(serviceId: string): Promise<void> {
  if (!serviceId) {
    throw new CLIError('Service ID is required', 1, {
      usage: 'iotctl services start <serviceId>',
    });
  }

  try {
    logger.info('Starting service', { serviceId });
    const result = await apiRequest(`${DEVICE_API_V1}/services/${serviceId}/start`, {
      method: 'POST',
    });

    logger.info('Service started', {
      serviceId,
      containerId: result.containerId,
      status: result.status,
    });
  } catch (error) {
    throw new CLIError('Failed to start service', 1, {
      serviceId,
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl services stop <serviceId>
 */
export async function servicesStop(serviceId: string): Promise<void> {
  if (!serviceId) {
    throw new CLIError('Service ID is required', 1, {
      usage: 'iotctl services stop <serviceId>',
    });
  }

  try {
    logger.info('Stopping service', { serviceId });
    const result = await apiRequest(`${DEVICE_API_V1}/services/${serviceId}/stop`, {
      method: 'POST',
    });

    logger.info('Service stopped', {
      serviceId,
      containerId: result.containerId,
      status: result.status,
    });
  } catch (error) {
    throw new CLIError('Failed to stop service', 1, {
      serviceId,
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl services restart <serviceId>
 */
export async function servicesRestart(serviceId: string): Promise<void> {
  if (!serviceId) {
    throw new CLIError('Service ID is required', 1, {
      usage: 'iotctl services restart <serviceId>',
    });
  }

  try {
    logger.info('Restarting service', { serviceId });
    const result = await apiRequest(`${DEVICE_API_V1}/services/${serviceId}/restart`, {
      method: 'POST',
    });

    logger.info('Service restarted', {
      serviceId,
      containerId: result.containerId,
      status: result.status,
    });
  } catch (error) {
    throw new CLIError('Failed to restart service', 1, {
      serviceId,
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl services logs <serviceId> [-f]
 */
export async function servicesLogs(serviceId: string, follow: boolean = false): Promise<void> {
  clearApiCache();
  if (!serviceId) {
    throw new CLIError('Service ID is required', 1, {
      usage: 'iotctl services logs <serviceId> [-f]',
    });
  }

  try {
    const deviceState = await apiCached(`${DEVICE_API_V1}/device`);
    const apps = deviceState.apps || {};

    let containerId: string | undefined;
    for (const appId in apps) {
      const services = apps[appId].services || [];
      const service = services.find((s: any) => s.serviceId === serviceId);
      if (service) {
        containerId = service.containerId;
        break;
      }
    }

    if (!containerId) {
      throw new CLIError('Service not found', 1, { serviceId });
    }

    if (!ENV.hasDocker) {
      throw new CLIError('Docker is not available', 1, {
        hint: 'Install Docker or ensure it is in your PATH',
      });
    }

    logger.info('Service logs', { serviceId, containerId: containerId.substring(0, 12) });

    const args = ['logs'];
    if (follow) {
      args.push('-f');
    } else {
      args.push('--tail', '100');
    }
    args.push(containerId);

    const docker = spawn('docker', args, {
      stdio: 'inherit',
    });

    await new Promise<void>((resolve, reject) => {
      docker.on('error', reject);
      docker.on('exit', (code) => {
        if (code && code !== 0) {
          reject(new CLIError('docker logs failed', code, { serviceId, containerId }));
          return;
        }
        resolve();
      });
    });
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to retrieve service logs', 1, {
      serviceId,
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl services info <serviceId>
 */
export async function servicesInfo(serviceId: string): Promise<void> {
  clearApiCache();
  if (!serviceId) {
    throw new CLIError('Service ID is required', 1, {
      usage: 'iotctl services info <serviceId>',
    });
  }

  try {
    const deviceState = await apiCached(`${DEVICE_API_V1}/device`);
    const apps = deviceState.apps || {};

    for (const appId in apps) {
      const app = apps[appId];
      const services = app.services || [];
      const service = services.find((s: any) => s.serviceId === serviceId);

      if (service) {
        logger.info('Service details', {
          serviceId: service.serviceId,
          serviceName: service.serviceName,
          appId,
          appName: app.appName,
          status: service.status,
          state: service.state || 'running',
          containerId: service.containerId,
          imageName: service.imageName,
          ports: service.ports || [],
          volumes: service.volumes || [],
          environment: service.environment || {},
        });
        return;
      }
    }

    throw new CLIError('Service not found', 1, { serviceId });
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to get service info', 1, {
      serviceId,
      error: (error as Error).message,
    });
  }
}
