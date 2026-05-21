"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.servicesList = servicesList;
exports.servicesStart = servicesStart;
exports.servicesStop = servicesStop;
exports.servicesRestart = servicesRestart;
exports.servicesLogs = servicesLogs;
exports.servicesInfo = servicesInfo;
const child_process_1 = require("child_process");
const core_1 = require("../core");
/**
 * iotctl services list [<appId>]
 */
async function servicesList(appId) {
    (0, core_1.clearApiCache)();
    try {
        const deviceState = await (0, core_1.apiCached)(`${core_1.DEVICE_API_V1}/device`);
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
            core_1.logger.info(`App ${currentAppId} (${app.appName || 'Unknown'})`, {
                serviceCount: services.length,
            });
            for (const service of services) {
                core_1.logger.info(`  Service: ${service.serviceName}`, {
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
                core_1.logger.info('No services found for application', { appId });
            }
            else {
                core_1.logger.info('No services configured');
            }
        }
        else {
            core_1.logger.info(`Total services: ${totalServices}`);
        }
    }
    catch (error) {
        throw new core_1.CLIError('Failed to list services', 1, {
            error: error.message,
        });
    }
}
/**
 * iotctl services start <serviceId>
 */
async function servicesStart(serviceId) {
    if (!serviceId) {
        throw new core_1.CLIError('Service ID is required', 1, {
            usage: 'iotctl services start <serviceId>',
        });
    }
    try {
        core_1.logger.info('Starting service', { serviceId });
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/services/${serviceId}/start`, {
            method: 'POST',
        });
        core_1.logger.info('Service started', {
            serviceId,
            containerId: result.containerId,
            status: result.status,
        });
    }
    catch (error) {
        throw new core_1.CLIError('Failed to start service', 1, {
            serviceId,
            error: error.message,
        });
    }
}
/**
 * iotctl services stop <serviceId>
 */
async function servicesStop(serviceId) {
    if (!serviceId) {
        throw new core_1.CLIError('Service ID is required', 1, {
            usage: 'iotctl services stop <serviceId>',
        });
    }
    try {
        core_1.logger.info('Stopping service', { serviceId });
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/services/${serviceId}/stop`, {
            method: 'POST',
        });
        core_1.logger.info('Service stopped', {
            serviceId,
            containerId: result.containerId,
            status: result.status,
        });
    }
    catch (error) {
        throw new core_1.CLIError('Failed to stop service', 1, {
            serviceId,
            error: error.message,
        });
    }
}
/**
 * iotctl services restart <serviceId>
 */
async function servicesRestart(serviceId) {
    if (!serviceId) {
        throw new core_1.CLIError('Service ID is required', 1, {
            usage: 'iotctl services restart <serviceId>',
        });
    }
    try {
        core_1.logger.info('Restarting service', { serviceId });
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/services/${serviceId}/restart`, {
            method: 'POST',
        });
        core_1.logger.info('Service restarted', {
            serviceId,
            containerId: result.containerId,
            status: result.status,
        });
    }
    catch (error) {
        throw new core_1.CLIError('Failed to restart service', 1, {
            serviceId,
            error: error.message,
        });
    }
}
/**
 * iotctl services logs <serviceId> [-f]
 */
async function servicesLogs(serviceId, follow = false) {
    (0, core_1.clearApiCache)();
    if (!serviceId) {
        throw new core_1.CLIError('Service ID is required', 1, {
            usage: 'iotctl services logs <serviceId> [-f]',
        });
    }
    try {
        const deviceState = await (0, core_1.apiCached)(`${core_1.DEVICE_API_V1}/device`);
        const apps = deviceState.apps || {};
        let containerId;
        for (const appId in apps) {
            const services = apps[appId].services || [];
            const service = services.find((s) => s.serviceId === serviceId);
            if (service) {
                containerId = service.containerId;
                break;
            }
        }
        if (!containerId) {
            throw new core_1.CLIError('Service not found', 1, { serviceId });
        }
        if (!core_1.ENV.hasDocker) {
            throw new core_1.CLIError('Docker is not available', 1, {
                hint: 'Install Docker or ensure it is in your PATH',
            });
        }
        core_1.logger.info('Service logs', { serviceId, containerId: containerId.substring(0, 12) });
        const args = ['logs'];
        if (follow) {
            args.push('-f');
        }
        else {
            args.push('--tail', '100');
        }
        args.push(containerId);
        const docker = (0, child_process_1.spawn)('docker', args, {
            stdio: 'inherit',
        });
        await new Promise((resolve, reject) => {
            docker.on('error', reject);
            docker.on('exit', (code) => {
                if (code && code !== 0) {
                    reject(new core_1.CLIError('docker logs failed', code, { serviceId, containerId }));
                    return;
                }
                resolve();
            });
        });
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to retrieve service logs', 1, {
            serviceId,
            error: error.message,
        });
    }
}
/**
 * iotctl services info <serviceId>
 */
async function servicesInfo(serviceId) {
    (0, core_1.clearApiCache)();
    if (!serviceId) {
        throw new core_1.CLIError('Service ID is required', 1, {
            usage: 'iotctl services info <serviceId>',
        });
    }
    try {
        const deviceState = await (0, core_1.apiCached)(`${core_1.DEVICE_API_V1}/device`);
        const apps = deviceState.apps || {};
        for (const appId in apps) {
            const app = apps[appId];
            const services = app.services || [];
            const service = services.find((s) => s.serviceId === serviceId);
            if (service) {
                core_1.logger.info('Service details', {
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
        throw new core_1.CLIError('Service not found', 1, { serviceId });
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to get service info', 1, {
            serviceId,
            error: error.message,
        });
    }
}
//# sourceMappingURL=services.js.map