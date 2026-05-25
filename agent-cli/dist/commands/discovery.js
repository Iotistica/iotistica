"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.discover = discover;
exports.devicesList = devicesList;
exports.endpointsClean = endpointsClean;
const core_1 = require("../core");
function parseConnectionValue(source) {
    const rawConnection = source.connection;
    if (rawConnection && typeof rawConnection === 'object') {
        return rawConnection;
    }
    if (typeof source.connectionString === 'string') {
        try {
            const parsed = JSON.parse(source.connectionString);
            if (parsed && typeof parsed === 'object') {
                return parsed;
            }
        }
        catch {
            return {};
        }
    }
    return {};
}
function isModbusDiscoveryTarget(endpoint) {
    if (endpoint.protocol !== 'modbus') {
        return false;
    }
    const connection = parseConnectionValue(endpoint);
    return connection.slaveRange !== undefined || connection.slaveId !== undefined;
}
function formatConnection(protocol, connection) {
    switch (protocol) {
        case 'modbus': {
            const slaveInfo = connection.slaveId || connection.slaveRange;
            if (connection.type === 'tcp') {
                return `${connection.host}:${connection.port} (TCP, Slave: ${slaveInfo})`;
            }
            return `${connection.path} (Serial, Slave: ${slaveInfo})`;
        }
        case 'opcua':
            return connection.endpointUrl || 'opc.tcp://...';
        case 'mqtt':
            return connection.brokerUrl || connection.url || 'mqtt://localhost:1883';
        case 'snmp':
            return `${connection.host}:${connection.port || 161}`;
        case 'bacnet':
            return `Device ID: ${connection.deviceInstance}`;
        case 'can':
            return `${connection.interface} (${connection.protocol || 'CAN'})`;
        default:
            return JSON.stringify(connection);
    }
}
/**
 * iotctl discover [<protocol>] [--validate]
 */
async function discover(protocolArg) {
    (0, core_1.clearApiCache)();
    try {
        let validate = false;
        let protocol = protocolArg;
        if (process.argv.includes('--validate')) {
            validate = true;
        }
        const protocolFlagIndex = process.argv.findIndex((arg) => arg.startsWith('--protocol='));
        if (protocolFlagIndex !== -1) {
            const flagValue = process.argv[protocolFlagIndex].split('=')[1];
            if (flagValue) {
                protocol = flagValue;
            }
        }
        const body = {
            trigger: 'manual',
            validate,
        };
        if (protocol) {
            body.protocols = [protocol];
            core_1.logger.info(`Running discovery for ${protocol}${validate ? ' with validation' : ''}...`);
        }
        else {
            core_1.logger.info(`Running discovery for all protocols${validate ? ' with validation' : ''}...`);
        }
        if (protocol === 'modbus' || !protocol) {
            let modbusTargetConfigured = false;
            try {
                const modbusEndpointsResult = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/endpoints?protocol=modbus`);
                const modbusEndpoints = Array.isArray(modbusEndpointsResult.endpoints)
                    ? modbusEndpointsResult.endpoints
                    : [];
                modbusTargetConfigured = modbusEndpoints.some((endpoint) => isModbusDiscoveryTarget(endpoint));
            }
            catch {
                // Keep discovery running even if pre-check cannot be completed.
            }
            if (modbusTargetConfigured) {
                core_1.logger.info('(Modbus scanning slave IDs - this may take 30-60 seconds...)');
            }
            else if (protocol === 'modbus') {
                core_1.logger.info('(No Modbus discovery targets configured. Add slaveId or slaveRange to a Modbus endpoint connection.)');
            }
        }
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/discover`, {
            method: 'POST',
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120000),
        });
        const devices = result.devices || [];
        const endpointsResult = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/endpoints${protocol ? `?protocol=${protocol}` : ''}`);
        const endpoints = endpointsResult.endpoints || [];
        if (devices.length === 0) {
            core_1.logger.info('No devices discovered');
            return;
        }
        core_1.logger.info(`Discovered ${devices.length} device${devices.length === 1 ? '' : 's'}`);
        console.log('');
        for (const device of devices) {
            const connectionStr = formatConnection(device.protocol, device.connection);
            const confidenceIcon = device.confidence === 'high' ? '●' : device.confidence === 'medium' ? '◐' : '○';
            const validatedIcon = device.validated ? ' [V]' : '';
            const matchedEndpoint = endpoints.find((ep) => {
                if (ep.protocol !== device.protocol)
                    return false;
                if (device.protocol === 'bacnet') {
                    return ep.connection?.deviceInstance === device.connection?.deviceInstance;
                }
                if (device.protocol === 'modbus') {
                    return ep.connection?.host === device.connection?.host
                        && ep.connection?.port === device.connection?.port
                        && ep.connection?.slaveId === device.connection?.slaveId;
                }
                if (device.protocol === 'opcua') {
                    return ep.connection?.endpointUrl === device.connection?.endpointUrl;
                }
                if (device.protocol === 'mqtt') {
                    return ep.connection?.brokerUrl === device.connection?.brokerUrl
                        || ep.connection?.url === device.connection?.url;
                }
                if (device.protocol === 'snmp') {
                    return ep.connection?.host === device.connection?.host
                        && (ep.connection?.port || 161) === (device.connection?.port || 161);
                }
                return ep.name === device.name;
            });
            const statusEnabled = matchedEndpoint?.enabled === true ? 'enabled' : 'disabled';
            core_1.logger.info(device.name, {
                protocol: device.protocol,
                connection: connectionStr,
                confidence: `${confidenceIcon} ${device.confidence}${validatedIcon}`,
                status: statusEnabled,
                discoveredAt: new Date(device.discoveredAt).toLocaleString(),
            });
        }
        console.log('');
        core_1.logger.info('Legend: ● = high confidence, ◐ = medium, ○ = low, [V] = validated');
    }
    catch (error) {
        throw new core_1.CLIError('Failed to run discovery', 1, {
            error: error.message,
        });
    }
}
/**
 * iotctl devices list [--protocol <protocol>]
 */
async function devicesList(protocolFilter) {
    (0, core_1.clearApiCache)();
    try {
        const query = protocolFilter ? `?protocol=${protocolFilter}` : '';
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/devices${query}`);
        const devices = result.devices || [];
        if (devices.length === 0) {
            core_1.logger.info('No devices found');
            return;
        }
        core_1.logger.info(`Found ${devices.length} device${devices.length === 1 ? '' : 's'}${protocolFilter ? ` (${protocolFilter})` : ''}`);
        console.log('');
        const byProtocol = devices.reduce((acc, d) => {
            const proto = d.protocol || 'unknown';
            if (!acc[proto])
                acc[proto] = [];
            acc[proto].push(d);
            return acc;
        }, {});
        for (const [protocol, protoDevices] of Object.entries(byProtocol)) {
            console.log(`\n${protocol.toUpperCase()} Devices:`);
            console.log('━'.repeat(60));
            for (const device of protoDevices) {
                const enabledIcon = device.enabled ? '✓' : '✗';
                const identifierStr = device.identifier ? ` [${device.identifier}]` : '';
                const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : 'never';
                core_1.logger.info(`${enabledIcon} ${device.name}${identifierStr}`, {
                    uuid: device.uuid.slice(0, 8) + '...',
                    enabled: device.enabled,
                    lastSeen,
                });
            }
        }
        console.log('');
    }
    catch (error) {
        throw new core_1.CLIError('Failed to list devices', 1, {
            error: error.message,
        });
    }
}
/**
 * iotctl devices clean [--force]
 * Remove ALL devices from the agent configuration
 */
async function endpointsClean() {
    const force = process.argv.includes('--force') || process.argv.includes('-f');
    if (!force) {
        // First list what will be removed
        try {
            const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/endpoints`);
            const endpoints = result.endpoints || [];
            if (endpoints.length === 0) {
                core_1.logger.info('No devices to remove');
                return;
            }
            core_1.logger.info(`This will remove ${endpoints.length} device(s):`);
            console.log('');
            for (const ep of endpoints) {
                console.log(`  - ${ep.name} (${ep.protocol}) [${ep.uuid}]`);
            }
            console.log('');
            core_1.logger.info('Re-run with --force to confirm removal');
        }
        catch (error) {
            if (error instanceof core_1.CLIError)
                throw error;
            throw new core_1.CLIError('Failed to list devices', 1, { error: error.message });
        }
        return;
    }
    try {
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/endpoints`, { method: 'DELETE' });
        core_1.logger.info(result.message || 'All devices removed');
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to clean devices', 1, {
            error: error.message,
        });
    }
}
//# sourceMappingURL=discovery.js.map