"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.provisionWithKey = provisionWithKey;
exports.provisionStatus = provisionStatus;
exports.deprovision = deprovision;
exports.mqttListUsers = mqttListUsers;
exports.factoryReset = factoryReset;
const core_1 = require("../core");
/**
 * iotctl provision <key> --api <endpoint> [--name <device-name>] [--type <device-type>]
 */
async function provisionWithKey(key) {
    if (!key) {
        throw new core_1.CLIError('Provisioning key is required', 1, {
            usage: 'iotctl provision <key> --api <endpoint> [--name <device-name>] [--type <device-type>]',
        });
    }
    try {
        const args = process.argv.slice(2);
        const apiIndex = args.indexOf('--api');
        const nameIndex = args.indexOf('--name');
        const typeIndex = args.indexOf('--type');
        const config = {
            provisioningApiKey: key,
        };
        if (apiIndex === -1 || !args[apiIndex + 1]) {
            throw new core_1.CLIError('The --api argument is required for provisioning', 1, {
                usage: 'iotctl provision <key> --api <endpoint> [--name <device-name>] [--type <device-type>]',
                hint: 'Example: iotctl provision <key> --api https://localhost:3443',
            });
        }
        config.apiEndpoint = args[apiIndex + 1];
        if (!(0, core_1.validateUrl)(config.apiEndpoint)) {
            throw new core_1.CLIError('Invalid --api endpoint', 1, {
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
        core_1.logger.info('Provisioning device', {
            apiEndpoint: config.apiEndpoint,
            deviceName: config.deviceName || 'auto-generated',
        });
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/provision`, {
            method: 'POST',
            body: JSON.stringify(config),
        });
        core_1.logger.info('Agent provisioned successfully', {
            uuid: (0, core_1.redact)(result.device.uuid),
            deviceId: (0, core_1.redact)(result.device.deviceId),
            deviceName: result.device.deviceName,
            mqttBrokerUrl: (0, core_1.redact)(result.device.mqttBrokerUrl),
        });
        core_1.logger.warn('Restart the agent to apply provisioned cloud configuration', {
            hint: 'Provisioning state is saved immediately, but MQTT/cloud-dependent features initialize on startup',
        });
    }
    catch {
        throw new core_1.CLIError('Provisioning failed', 1);
    }
}
/**
 * iotctl provision status
 */
async function provisionStatus() {
    (0, core_1.clearApiCache)();
    try {
        const status = await (0, core_1.apiCached)(`${core_1.DEVICE_API_V1}/provision/status`);
        core_1.logger.info('Provisioning status', {
            provisioned: status.provisioned,
            uuid: (0, core_1.redact)(status.uuid),
            deviceId: (0, core_1.redact)(status.deviceId),
            deviceName: status.deviceName || 'not set',
            apiEndpoint: status.apiEndpoint || 'not set',
            mqttConfigured: status.mqttConfigured,
        });
        if (!status.provisioned) {
            core_1.logger.info('Device not provisioned', {
                hint: 'Use "iotctl provision <key> --api <endpoint>" to provision this device',
            });
        }
    }
    catch {
        throw new core_1.CLIError('Failed to get provisioning status', 1);
    }
}
/**
 * iotctl deprovision
 */
async function deprovision() {
    try {
        core_1.logger.warn('Deprovisioning device - this will remove cloud registration');
        (0, core_1.requireConfirmation)('Deprovision will remove cloud registration. Continue?');
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/deprovision`, {
            method: 'POST',
        });
        core_1.logger.info('Device deprovisioned', {
            message: result.message,
            status: result.status,
        });
    }
    catch (error) {
        throw new core_1.CLIError('Deprovision failed', 1, {
            error: error.message,
        });
    }
}
/**
 * iotctl mqtt users
 */
async function mqttListUsers() {
    (0, core_1.clearApiCache)();
    try {
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/mqtt/users`);
        const users = result.users || [];
        const count = result.count || 0;
        if (count === 0) {
            core_1.logger.info('No MQTT users configured');
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
    }
    catch (error) {
        if (error.code === 'ECONNREFUSED') {
            throw new core_1.CLIError('Cannot connect to agent API', 1, {
                endpoint: core_1.DEVICE_API_BASE,
                hint: 'Make sure the agent is running',
            });
        }
        throw new core_1.CLIError('Failed to retrieve MQTT users', 1, {
            error: error.message,
        });
    }
}
/**
 * iotctl factory-reset
 */
async function factoryReset() {
    try {
        core_1.logger.warn('WARNING: Factory reset will DELETE ALL DATA');
        core_1.logger.warn('This includes all apps, services, state snapshots, and sensor data');
        core_1.logger.warn('Only the device UUID will be preserved');
        core_1.logger.warn('This action cannot be undone');
        (0, core_1.requireConfirmation)('Factory reset will DELETE ALL DATA. This cannot be undone.');
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/factory-reset`, {
            method: 'POST',
        });
        core_1.logger.info('Factory reset complete', {
            message: result.message,
            status: result.status,
        });
    }
    catch {
        throw new core_1.CLIError('Factory reset failed', 1);
    }
}
//# sourceMappingURL=provision.js.map