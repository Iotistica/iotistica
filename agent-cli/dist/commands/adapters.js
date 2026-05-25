"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adaptersList = adaptersList;
exports.adaptersShow = adaptersShow;
exports.adaptersRemove = adaptersRemove;
exports.adaptersEnable = adaptersEnable;
exports.adaptersDisable = adaptersDisable;
exports.mqttAdd = mqttAdd;
exports.modbusAdd = modbusAdd;
exports.opcuaAdd = opcuaAdd;
exports.snmpAdd = snmpAdd;
exports.adaptersAdd = adaptersAdd;
const core_1 = require("../core");
function getFlag(name) {
    const args = process.argv;
    const idx = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (idx === -1)
        return undefined;
    if (args[idx].includes('='))
        return args[idx].split('=').slice(1).join('=');
    return args[idx + 1];
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
function deriveState(adapter) {
    const health = adapter.health || {};
    if (health.status)
        return health.status;
    if (!adapter.enabled)
        return 'disabled';
    const lastSeenRaw = health.lastSeen || adapter.lastSeenAt;
    if (!lastSeenRaw)
        return 'offline';
    const lastSeenMs = new Date(lastSeenRaw).getTime();
    if (Number.isNaN(lastSeenMs))
        return 'offline';
    const stalenessThresholdMs = 24 * 60 * 60 * 1000;
    return (Date.now() - lastSeenMs) < stalenessThresholdMs ? 'online' : 'offline';
}
function isAllSelector(value) {
    return typeof value === 'string' && ['all', '*', 'every'].includes(value.trim().toLowerCase());
}
async function getAllEndpointUuids() {
    const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/endpoints`);
    const adapters = result.endpoints || [];
    return adapters.map((adapter) => adapter.uuid).filter((uuid) => typeof uuid === 'string' && uuid.trim().length > 0);
}
async function postAdapter(body) {
    const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/endpoints`, {
        method: 'POST',
        body: JSON.stringify(body),
    });
    const ep = result.endpoint;
    core_1.logger.info(`Device added: ${ep.name}`, {
        uuid: ep.uuid,
        protocol: ep.protocol,
        enabled: ep.enabled,
    });
}
// ---------------------------------------------------------------------------
// List / show
// ---------------------------------------------------------------------------
/**
 * iotctl devices list [--protocol <protocol>]
 */
async function adaptersList() {
    (0, core_1.clearApiCache)();
    try {
        const protocolFilter = getFlag('protocol');
        const query = protocolFilter ? `?protocol=${protocolFilter}` : '';
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/endpoints${query}`);
        const adapters = result.endpoints || [];
        if (adapters.length === 0) {
            core_1.logger.info('No devices configured');
            return;
        }
        core_1.logger.info(`Found ${adapters.length} device${adapters.length === 1 ? '' : 's'}${protocolFilter ? ` (${protocolFilter})` : ''}`);
        console.log('');
        const byProtocol = adapters.reduce((acc, a) => {
            const proto = a.protocol || 'unknown';
            if (!acc[proto])
                acc[proto] = [];
            acc[proto].push(a);
            return acc;
        }, {});
        for (const [protocol, items] of Object.entries(byProtocol)) {
            console.log(`\n${protocol.toUpperCase()} Devices:`);
            console.log('━'.repeat(60));
            for (const adapter of items) {
                const icon = adapter.enabled ? '✓' : '✗';
                const connectionStr = formatConnection(adapter.protocol, adapter.connection);
                const dataPoints = adapter.data_points || [];
                const health = adapter.health || {};
                const state = deriveState(adapter);
                const extra = {
                    uuid: adapter.uuid || '(none)',
                    connection: connectionStr,
                    state,
                    interval: `${adapter.poll_interval}ms`,
                };
                const lastSeen = health.lastSeen || adapter.lastSeenAt;
                if (lastSeen) {
                    extra.lastSeen = new Date(lastSeen).toLocaleString();
                }
                if (protocol === 'mqtt') {
                    const topics = dataPoints.map((dp) => dp.topic || dp.name).filter(Boolean);
                    extra.topics = topics.length > 0 ? topics.join(', ') : '(none)';
                    if (adapter.connection?.username)
                        extra.auth = adapter.connection.username;
                }
                else {
                    extra.dataPoints = dataPoints.length;
                }
                core_1.logger.info(`${icon} ${adapter.name}`, extra);
            }
        }
        console.log('');
    }
    catch (error) {
        throw new core_1.CLIError('Failed to list devices', 1, { error: error.message });
    }
}
/**
 * iotctl devices show <name>
 */
async function adaptersShow(name) {
    (0, core_1.clearApiCache)();
    try {
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/endpoints`);
        const adapters = result.endpoints || [];
        if (!name) {
            core_1.logger.info('Usage: iotctl devices show <name>', {
                hint: 'Run "iotctl devices list" to see all device names',
            });
            return;
        }
        const adapter = adapters.find((a) => a.name === name);
        if (!adapter) {
            throw new core_1.CLIError(`Device not found: ${name}`, 1, {
                hint: 'Run "iotctl devices list" to see all device names',
            });
        }
        console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
        console.log('║                    DEVICE DETAILS                                 ║');
        console.log('╚═══════════════════════════════════════════════════════════════════╝\n');
        const health = adapter.health || {};
        core_1.logger.info('Name', { value: adapter.name });
        core_1.logger.info('Protocol', { value: adapter.protocol });
        core_1.logger.info('UUID', { value: adapter.uuid });
        core_1.logger.info('Enabled', { value: adapter.enabled ? 'Yes' : 'No' });
        core_1.logger.info('State', { value: deriveState(adapter) });
        core_1.logger.info('Poll Interval', { value: `${adapter.poll_interval}ms` });
        core_1.logger.info('Connection', { value: formatConnection(adapter.protocol, adapter.connection) });
        const lastSeen = health.lastSeen || adapter.lastSeenAt;
        if (lastSeen) {
            core_1.logger.info('Last Seen', { value: new Date(lastSeen).toLocaleString() });
        }
        if (health.lastError) {
            core_1.logger.info('Last Error', { value: health.lastError });
        }
        const dataPoints = adapter.data_points || [];
        if (dataPoints.length > 0) {
            console.log('\nData Points:');
            console.log('━'.repeat(60));
            for (const dp of dataPoints) {
                const dpInfo = {};
                if (adapter.protocol === 'modbus') {
                    dpInfo.address = dp.address;
                    dpInfo.type = dp.type;
                    dpInfo.dataType = dp.dataType;
                }
                else if (adapter.protocol === 'opcua') {
                    dpInfo.nodeId = dp.nodeId;
                    dpInfo.dataType = dp.dataType;
                }
                else if (adapter.protocol === 'mqtt') {
                    dpInfo.topic = dp.topic;
                }
                core_1.logger.info(`  • ${dp.name || dp.label || 'unnamed'}`, dpInfo);
            }
        }
        console.log('');
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to show device details', 1, { error: error.message });
    }
}
// ---------------------------------------------------------------------------
// Remove / enable / disable
// ---------------------------------------------------------------------------
/**
 * iotctl devices remove <uuid>
 */
async function adaptersRemove(uuid) {
    if (!uuid) {
        throw new core_1.CLIError('UUID is required', 1, { usage: 'iotctl devices remove <uuid>' });
    }
    try {
        await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/endpoints/${encodeURIComponent(uuid)}`, { method: 'DELETE' });
        core_1.logger.info(`Device removed: ${uuid}`);
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to remove device', 1, { error: error.message });
    }
}
/**
 * iotctl devices enable <uuid>
 */
async function adaptersEnable(uuid) {
    if (!uuid) {
        throw new core_1.CLIError('UUID is required', 1, { usage: 'iotctl devices enable <uuid>' });
    }
    if (isAllSelector(uuid)) {
        const endpointUuids = await getAllEndpointUuids();
        if (endpointUuids.length === 0) {
            core_1.logger.info('No devices configured');
            return;
        }
        let updatedCount = 0;
        for (const endpointUuid of endpointUuids) {
            await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/endpoints/${encodeURIComponent(endpointUuid)}`, {
                method: 'PATCH',
                body: JSON.stringify({ enabled: true }),
            });
            updatedCount++;
        }
        core_1.logger.info(`Enabled ${updatedCount} device${updatedCount === 1 ? '' : 's'}`);
        return;
    }
    try {
        await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/endpoints/${encodeURIComponent(uuid)}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: true }),
        });
        core_1.logger.info(`Device enabled: ${uuid}`);
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to enable device', 1, { error: error.message });
    }
}
/**
 * iotctl devices disable <uuid>
 */
async function adaptersDisable(uuid) {
    if (!uuid) {
        throw new core_1.CLIError('UUID is required', 1, { usage: 'iotctl devices disable <uuid>' });
    }
    try {
        await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/endpoints/${encodeURIComponent(uuid)}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: false }),
        });
        core_1.logger.info(`Device disabled: ${uuid}`);
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to disable device', 1, { error: error.message });
    }
}
// ---------------------------------------------------------------------------
// Protocol-specific add commands
// ---------------------------------------------------------------------------
/**
 * iotctl devices add-mqtt --name <name> --broker <url>
 *   [--username <user>] [--password <pass>] [--topics <t1,t2>]
 *   [--interval <ms>] [--disabled]
 */
async function mqttAdd() {
    const name = getFlag('name');
    const broker = getFlag('broker');
    const username = getFlag('username');
    const password = getFlag('password');
    const topicsRaw = getFlag('topics');
    const pollInterval = parseInt(getFlag('interval') ?? '5000', 10);
    const enabled = !process.argv.includes('--disabled');
    if (!name) {
        throw new core_1.CLIError('--name is required', 1, {
            usage: 'iotctl devices add-mqtt --name <name> --broker mqtt://host:1883 [--topics t1,t2] [--username u] [--password p] [--interval ms] [--disabled]',
        });
    }
    if (!broker) {
        throw new core_1.CLIError('--broker is required', 1, {
            usage: 'iotctl devices add-mqtt --name <name> --broker mqtt://host:1883',
        });
    }
    const topics = topicsRaw ? topicsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];
    const connection = {
        brokerUrl: broker,
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
    };
    try {
        await postAdapter({
            name,
            protocol: 'mqtt',
            connection,
            poll_interval: isNaN(pollInterval) ? 5000 : pollInterval,
            enabled,
            data_points: topics.map((topic) => ({ name: topic, topic })),
        });
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to add MQTT device', 1, { error: error.message });
    }
}
/**
 * iotctl devices add-modbus --name <name> --host <ip>
 *   [--port <port>] [--slave <id>] [--interval <ms>] [--disabled]
 */
async function modbusAdd() {
    const name = getFlag('name');
    const host = getFlag('host');
    const port = parseInt(getFlag('port') ?? '502', 10);
    const slaveId = parseInt(getFlag('slave') ?? '1', 10);
    const pollInterval = parseInt(getFlag('interval') ?? '5000', 10);
    const enabled = !process.argv.includes('--disabled');
    if (!name) {
        throw new core_1.CLIError('--name is required', 1, {
            usage: 'iotctl devices add-modbus --name <name> --host <ip> [--port 502] [--slave 1] [--interval ms] [--disabled]',
        });
    }
    if (!host) {
        throw new core_1.CLIError('--host is required', 1, {
            usage: 'iotctl devices add-modbus --name <name> --host 192.168.1.10 --port 502 --slave 1',
        });
    }
    try {
        await postAdapter({
            name,
            protocol: 'modbus',
            connection: { type: 'tcp', host, port: isNaN(port) ? 502 : port, slaveId: isNaN(slaveId) ? 1 : slaveId },
            poll_interval: isNaN(pollInterval) ? 5000 : pollInterval,
            enabled,
            data_points: [],
        });
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to add Modbus device', 1, { error: error.message });
    }
}
/**
 * iotctl devices add-opcua --name <name> --endpoint opc.tcp://host:4840
 *   [--interval <ms>] [--disabled]
 */
async function opcuaAdd() {
    const name = getFlag('name');
    const endpointUrl = getFlag('endpoint');
    const pollInterval = parseInt(getFlag('interval') ?? '5000', 10);
    const enabled = !process.argv.includes('--disabled');
    if (!name) {
        throw new core_1.CLIError('--name is required', 1, {
            usage: 'iotctl devices add-opcua --name <name> --endpoint opc.tcp://host:4840 [--interval ms] [--disabled]',
        });
    }
    if (!endpointUrl) {
        throw new core_1.CLIError('--endpoint is required', 1, {
            usage: 'iotctl devices add-opcua --name <name> --endpoint opc.tcp://host:4840',
        });
    }
    try {
        await postAdapter({
            name,
            protocol: 'opcua',
            connection: { endpointUrl },
            poll_interval: isNaN(pollInterval) ? 5000 : pollInterval,
            enabled,
            data_points: [],
        });
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to add OPC-UA device', 1, { error: error.message });
    }
}
/**
 * iotctl devices add-snmp --name <name> --host <ip>
 *   [--port <port>] [--community <community>] [--interval <ms>] [--disabled]
 */
async function snmpAdd() {
    const name = getFlag('name');
    const host = getFlag('host');
    const port = parseInt(getFlag('port') ?? '161', 10);
    const community = getFlag('community') ?? 'public';
    const pollInterval = parseInt(getFlag('interval') ?? '30000', 10);
    const enabled = !process.argv.includes('--disabled');
    if (!name) {
        throw new core_1.CLIError('--name is required', 1, {
            usage: 'iotctl devices add-snmp --name <name> --host <ip> [--port 161] [--community public] [--interval ms] [--disabled]',
        });
    }
    if (!host) {
        throw new core_1.CLIError('--host is required', 1, {
            usage: 'iotctl devices add-snmp --name <name> --host 192.168.1.1 --community public',
        });
    }
    try {
        await postAdapter({
            name,
            protocol: 'snmp',
            connection: { host, port: isNaN(port) ? 161 : port, community },
            poll_interval: isNaN(pollInterval) ? 30000 : pollInterval,
            enabled,
            data_points: [],
        });
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to add SNMP device', 1, { error: error.message });
    }
}
/**
 * iotctl devices add --protocol <protocol> ...
 * Generic dispatcher: routes to the protocol-specific add command.
 */
async function adaptersAdd() {
    const protocol = (getFlag('protocol') ?? '').toLowerCase();
    switch (protocol) {
        case 'mqtt':
            return mqttAdd();
        case 'modbus':
            return modbusAdd();
        case 'opcua':
        case 'opc-ua':
            return opcuaAdd();
        case 'snmp':
            return snmpAdd();
        case '':
            throw new core_1.CLIError('--protocol is required', 1, {
                usage: 'iotctl devices add --protocol <mqtt|modbus|opcua|snmp> [options]',
                protocols: 'mqtt, modbus, opcua, snmp',
            });
        default:
            throw new core_1.CLIError(`Unsupported protocol: ${protocol}`, 1, {
                supported: 'mqtt, modbus, opcua, snmp',
            });
    }
}
//# sourceMappingURL=adapters.js.map