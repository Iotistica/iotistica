"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appsList = appsList;
exports.appsStart = appsStart;
exports.appsStop = appsStop;
exports.appsRestart = appsRestart;
exports.appsInfo = appsInfo;
exports.appsPurge = appsPurge;
const core_1 = require("../core");
/**
 * iotctl apps list
 */
async function appsList() {
    (0, core_1.clearApiCache)();
    try {
        const deviceState = await (0, core_1.apiCached)(`${core_1.DEVICE_API_V1}/device`);
        const apps = deviceState.apps || {};
        if (Object.keys(apps).length === 0) {
            core_1.logger.info('No applications configured');
            return;
        }
        core_1.logger.info('Applications');
        for (const appId in apps) {
            const app = apps[appId];
            const appInfo = {
                appId,
                appName: app.appName || 'Unknown',
            };
            if (app.services && app.services.length > 0) {
                appInfo.services = app.services.map((service) => ({
                    name: service.serviceName,
                    status: service.status,
                    containerId: service.containerId?.substring(0, 12),
                }));
            }
            core_1.logger.info(`App ${appId}`, appInfo);
        }
    }
    catch (error) {
        throw new core_1.CLIError('Failed to list applications', 1, {
            error: error.message,
        });
    }
}
/**
 * iotctl apps start <appId>
 */
async function appsStart(appId) {
    if (!appId) {
        throw new core_1.CLIError('Application ID is required', 1, {
            usage: 'iotctl apps start <appId>',
        });
    }
    try {
        core_1.logger.info('Starting application', { appId });
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/apps/${appId}/start`, {
            method: 'POST',
            body: JSON.stringify({ force: false }),
        });
        core_1.logger.info('Application started', {
            appId,
            containerId: result.containerId,
        });
    }
    catch (error) {
        throw new core_1.CLIError('Failed to start application', 1, {
            appId,
            error: error.message,
        });
    }
}
/**
 * iotctl apps stop <appId>
 */
async function appsStop(appId) {
    if (!appId) {
        throw new core_1.CLIError('Application ID is required', 1, {
            usage: 'iotctl apps stop <appId>',
        });
    }
    try {
        core_1.logger.info('Stopping application', { appId });
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/apps/${appId}/stop`, {
            method: 'POST',
            body: JSON.stringify({ force: false }),
        });
        core_1.logger.info('Application stopped', {
            appId,
            containerId: result.containerId,
        });
    }
    catch (error) {
        throw new core_1.CLIError('Failed to stop application', 1, {
            appId,
            error: error.message,
        });
    }
}
/**
 * iotctl apps restart <appId>
 */
async function appsRestart(appId) {
    if (!appId) {
        throw new core_1.CLIError('Application ID is required', 1, {
            usage: 'iotctl apps restart <appId>',
        });
    }
    try {
        core_1.logger.info('Restarting application', { appId });
        await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/restart`, {
            method: 'POST',
            body: JSON.stringify({ appId, force: false }),
        });
        core_1.logger.info('Application restarted', { appId });
    }
    catch (error) {
        throw new core_1.CLIError('Failed to restart application', 1, {
            appId,
            error: error.message,
        });
    }
}
/**
 * iotctl apps info <appId>
 */
async function appsInfo(appId) {
    if (!appId) {
        throw new core_1.CLIError('Application ID is required', 1, {
            usage: 'iotctl apps info <appId>',
        });
    }
    try {
        const app = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/apps/${appId}`);
        core_1.logger.info('Application details', { appId, details: app });
    }
    catch (error) {
        throw new core_1.CLIError('Failed to get application info', 1, {
            appId,
            error: error.message,
        });
    }
}
/**
 * iotctl apps purge <appId>
 */
async function appsPurge(appId) {
    if (!appId) {
        throw new core_1.CLIError('Application ID is required', 1, {
            usage: 'iotctl apps purge <appId>',
        });
    }
    try {
        core_1.logger.warn('Purging application data', {
            appId,
            warning: 'This removes all volumes and data',
        });
        (0, core_1.requireConfirmation)(`Purge will remove ALL data for app ${appId}. This cannot be undone.`);
        await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/purge`, {
            method: 'POST',
            body: JSON.stringify({ appId, force: true }),
        });
        core_1.logger.info('Application data purged', { appId });
    }
    catch (error) {
        throw new core_1.CLIError('Failed to purge application', 1, {
            appId,
            error: error.message,
        });
    }
}
//# sourceMappingURL=apps.js.map