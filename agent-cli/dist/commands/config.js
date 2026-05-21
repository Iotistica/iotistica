"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configSetApi = configSetApi;
exports.configGetApi = configGetApi;
exports.configSet = configSet;
exports.configGet = configGet;
exports.configShow = configShow;
exports.configReset = configReset;
const core_1 = require("../core");
/**
 * iotctl config set-api <url>
 */
async function configSetApi(url) {
    if (!url) {
        throw new core_1.CLIError('API URL is required', 1, {
            usage: 'iotctl config set-api <url>',
        });
    }
    if (!(0, core_1.validateUrl)(url)) {
        throw new core_1.CLIError('Invalid URL format', 1, {
            hint: 'URL must start with http:// or https://',
        });
    }
    url = url.replace(/\/$/, '');
    try {
        await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/config`, {
            method: 'POST',
            body: JSON.stringify({ cloudApiEndpoint: url }),
        });
        core_1.logger.info('Cloud API endpoint updated', { endpoint: url });
        core_1.logger.warn('Restart required', {
            hint: 'Run: iotctl restart',
        });
    }
    catch {
        throw new core_1.CLIError('Failed to update API endpoint', 1);
    }
}
/**
 * iotctl config get-api
 */
async function configGetApi() {
    (0, core_1.clearApiCache)();
    try {
        const provisionStatus = await (0, core_1.apiCached)(`${core_1.DEVICE_API_V1}/provision/status`);
        if (provisionStatus.apiEndpoint) {
            core_1.logger.info('Cloud API Endpoint', { endpoint: provisionStatus.apiEndpoint });
        }
        else {
            core_1.logger.warn('Cloud API endpoint not configured');
        }
    }
    catch {
        throw new core_1.CLIError('Failed to retrieve API endpoint', 1);
    }
}
/**
 * iotctl config set <key> <value>
 */
async function configSet(key, value) {
    if (!key || !value) {
        throw new core_1.CLIError('Both key and value are required', 1, {
            usage: 'iotctl config set <key> <value>',
        });
    }
    let parsedValue = value;
    try {
        parsedValue = JSON.parse(value);
    }
    catch {
        // Keep as string if not valid JSON
    }
    try {
        await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/config`, {
            method: 'POST',
            body: JSON.stringify({ [key]: parsedValue }),
        });
        core_1.logger.info('Configuration updated', { key, value: parsedValue });
    }
    catch (error) {
        throw new core_1.CLIError('Failed to update configuration', 1, {
            key,
            error: error.message,
        });
    }
}
/**
 * iotctl config get <key>
 */
async function configGet(key) {
    if (!key) {
        throw new core_1.CLIError('Key is required', 1, {
            usage: 'iotctl config get <key>',
        });
    }
    (0, core_1.clearApiCache)();
    try {
        const deviceState = await (0, core_1.apiCached)(`${core_1.DEVICE_API_V1}/device`);
        const config = deviceState.config || {};
        if (key in config) {
            core_1.logger.info('Configuration value', { key, value: config[key] });
        }
        else {
            core_1.logger.warn('Configuration key not found', { key });
        }
    }
    catch (error) {
        throw new core_1.CLIError('Failed to retrieve configuration', 1, {
            key,
            error: error.message,
        });
    }
}
/**
 * iotctl config show
 */
async function configShow() {
    (0, core_1.clearApiCache)();
    try {
        const deviceState = await (0, core_1.apiCached)(`${core_1.DEVICE_API_V1}/device`);
        const provisionStatus = await (0, core_1.apiCached)(`${core_1.DEVICE_API_V1}/provision/status`);
        const config = {
            uuid: (0, core_1.redact)(deviceState.uuid),
            deviceId: (0, core_1.redact)(provisionStatus.deviceId),
            deviceName: provisionStatus.deviceName || 'not set',
            cloudApiEndpoint: provisionStatus.apiEndpoint || 'not configured',
            mqttConfigured: provisionStatus.mqttConfigured || false,
            provisioned: provisionStatus.provisioned || false,
            online: deviceState.is_online || false,
            version: deviceState.version || 0,
        };
        core_1.logger.info('Device Configuration', config);
    }
    catch (error) {
        core_1.logger.error('Failed to retrieve configuration', error, {
            hint: 'Ensure the agent is running',
        });
    }
}
/**
 * iotctl config reset
 */
async function configReset() {
    try {
        await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/factory-reset`, {
            method: 'POST',
        });
        core_1.logger.info('Configuration reset to factory defaults');
        core_1.logger.warn('Device needs to be re-provisioned');
    }
    catch (error) {
        throw new core_1.CLIError('Failed to reset configuration', 1, {
            error: error.message,
        });
    }
}
//# sourceMappingURL=config.js.map