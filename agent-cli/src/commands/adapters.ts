import { DEVICE_API_V1, CLIError, logger, apiRequest, clearApiCache } from '../core';

function getFlag(name: string): string | undefined {
  const args = process.argv;
  const idx = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (idx === -1) return undefined;
  if (args[idx].includes('=')) return args[idx].split('=').slice(1).join('=');
  return args[idx + 1];
}

function formatConnection(protocol: string, connection: Record<string, any>): string {
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

function deriveState(adapter: any): string {
  const health = adapter.health || {};
  if (health.status) return health.status;

  if (!adapter.enabled) return 'disabled';

  const lastSeenRaw = health.lastSeen || adapter.lastSeenAt;
  if (!lastSeenRaw) return 'offline';

  const lastSeenMs = new Date(lastSeenRaw).getTime();
  if (Number.isNaN(lastSeenMs)) return 'offline';

  const stalenessThresholdMs = 24 * 60 * 60 * 1000;
  return (Date.now() - lastSeenMs) < stalenessThresholdMs ? 'online' : 'offline';
}

function isAllSelector(value?: string): boolean {
  return typeof value === 'string' && ['all', '*', 'every'].includes(value.trim().toLowerCase());
}

async function getAllEndpointUuids(): Promise<string[]> {
  const result = await apiRequest(`${DEVICE_API_V1}/endpoints`);
  const adapters: Array<{ uuid?: string }> = result.endpoints || [];
  return adapters.map((adapter) => adapter.uuid).filter((uuid): uuid is string => typeof uuid === 'string' && uuid.trim().length > 0);
}

async function postAdapter(body: object): Promise<void> {
  const result = await apiRequest(`${DEVICE_API_V1}/endpoints`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const ep = result.endpoint;
  logger.info(`Device added: ${ep.name}`, {
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
export async function adaptersList(): Promise<void> {
  clearApiCache();
  try {
    const protocolFilter = getFlag('protocol');
    const query = protocolFilter ? `?protocol=${protocolFilter}` : '';
    const result = await apiRequest(`${DEVICE_API_V1}/endpoints${query}`);
    const adapters = result.endpoints || [];

    if (adapters.length === 0) {
      logger.info('No devices configured');
      return;
    }

    logger.info(`Found ${adapters.length} device${adapters.length === 1 ? '' : 's'}${protocolFilter ? ` (${protocolFilter})` : ''}`);
    console.log('');

    const byProtocol = adapters.reduce((acc: Record<string, any[]>, a: any) => {
      const proto = a.protocol || 'unknown';
      if (!acc[proto]) acc[proto] = [];
      acc[proto].push(a);
      return acc;
    }, {} as Record<string, any[]>);

    for (const [protocol, items] of Object.entries(byProtocol)) {
      console.log(`\n${protocol.toUpperCase()} Devices:`);
      console.log('━'.repeat(60));

      for (const adapter of items as any[]) {
        const icon = adapter.enabled ? '✓' : '✗';
        const connectionStr = formatConnection(adapter.protocol, adapter.connection);
        const dataPoints: any[] = adapter.data_points || [];
        const health = adapter.health || {};
        const state = deriveState(adapter);

        const extra: Record<string, any> = {
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
          const topics = dataPoints.map((dp: any) => dp.topic || dp.name).filter(Boolean);
          extra.topics = topics.length > 0 ? topics.join(', ') : '(none)';
          if (adapter.connection?.username) extra.auth = adapter.connection.username;
        } else {
          extra.dataPoints = dataPoints.length;
        }

        logger.info(`${icon} ${adapter.name}`, extra);
      }
    }

    console.log('');
  } catch (error) {
    throw new CLIError('Failed to list devices', 1, { error: (error as Error).message });
  }
}

/**
 * iotctl devices show <name>
 */
export async function adaptersShow(name?: string): Promise<void> {
  clearApiCache();
  try {
    const result = await apiRequest(`${DEVICE_API_V1}/endpoints`);
    const adapters: any[] = result.endpoints || [];

    if (!name) {
      logger.info('Usage: iotctl devices show <name>', {
        hint: 'Run "iotctl devices list" to see all device names',
      });
      return;
    }

    const adapter = adapters.find((a) => a.name === name);
    if (!adapter) {
      throw new CLIError(`Device not found: ${name}`, 1, {
        hint: 'Run "iotctl devices list" to see all device names',
      });
    }

    console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
    console.log('║                    DEVICE DETAILS                                 ║');
    console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

    const health = adapter.health || {};

    logger.info('Name', { value: adapter.name });
    logger.info('Protocol', { value: adapter.protocol });
    logger.info('UUID', { value: adapter.uuid });
    logger.info('Enabled', { value: adapter.enabled ? 'Yes' : 'No' });
    logger.info('State', { value: deriveState(adapter) });
    logger.info('Poll Interval', { value: `${adapter.poll_interval}ms` });
    logger.info('Connection', { value: formatConnection(adapter.protocol, adapter.connection) });
    const lastSeen = health.lastSeen || adapter.lastSeenAt;
    if (lastSeen) {
      logger.info('Last Seen', { value: new Date(lastSeen).toLocaleString() });
    }
    if (health.lastError) {
      logger.info('Last Error', { value: health.lastError });
    }

    const dataPoints: any[] = adapter.data_points || [];
    if (dataPoints.length > 0) {
      console.log('\nData Points:');
      console.log('━'.repeat(60));
      for (const dp of dataPoints) {
        const dpInfo: any = {};
        if (adapter.protocol === 'modbus') {
          dpInfo.address = dp.address;
          dpInfo.type = dp.type;
          dpInfo.dataType = dp.dataType;
        } else if (adapter.protocol === 'opcua') {
          dpInfo.nodeId = dp.nodeId;
          dpInfo.dataType = dp.dataType;
        } else if (adapter.protocol === 'mqtt') {
          dpInfo.topic = dp.topic;
        }
        logger.info(`  • ${dp.name || dp.label || 'unnamed'}`, dpInfo);
      }
    }

    console.log('');
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to show device details', 1, { error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Remove / enable / disable
// ---------------------------------------------------------------------------

/**
 * iotctl devices remove <uuid>
 */
export async function adaptersRemove(uuid?: string): Promise<void> {
  if (!uuid) {
    throw new CLIError('UUID is required', 1, { usage: 'iotctl devices remove <uuid>' });
  }

  try {
    await apiRequest(`${DEVICE_API_V1}/endpoints/${encodeURIComponent(uuid)}`, { method: 'DELETE' });
    logger.info(`Device removed: ${uuid}`);
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to remove device', 1, { error: (error as Error).message });
  }
}

/**
 * iotctl devices enable <uuid>
 */
export async function adaptersEnable(uuid?: string): Promise<void> {
  if (!uuid) {
    throw new CLIError('UUID is required', 1, { usage: 'iotctl devices enable <uuid>' });
  }

  if (isAllSelector(uuid)) {
    const endpointUuids = await getAllEndpointUuids();
    if (endpointUuids.length === 0) {
      logger.info('No devices configured');
      return;
    }

    let updatedCount = 0;
    for (const endpointUuid of endpointUuids) {
      await apiRequest(`${DEVICE_API_V1}/endpoints/${encodeURIComponent(endpointUuid)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true }),
      });
      updatedCount++;
    }

    logger.info(`Enabled ${updatedCount} device${updatedCount === 1 ? '' : 's'}`);
    return;
  }

  try {
    await apiRequest(`${DEVICE_API_V1}/endpoints/${encodeURIComponent(uuid)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true }),
    });
    logger.info(`Device enabled: ${uuid}`);
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to enable device', 1, { error: (error as Error).message });
  }
}

/**
 * iotctl devices disable <uuid>
 */
export async function adaptersDisable(uuid?: string): Promise<void> {
  if (!uuid) {
    throw new CLIError('UUID is required', 1, { usage: 'iotctl devices disable <uuid>' });
  }

  try {
    await apiRequest(`${DEVICE_API_V1}/endpoints/${encodeURIComponent(uuid)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });
    logger.info(`Device disabled: ${uuid}`);
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to disable device', 1, { error: (error as Error).message });
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
export async function mqttAdd(): Promise<void> {
  const name = getFlag('name');
  const broker = getFlag('broker');
  const username = getFlag('username');
  const password = getFlag('password');
  const topicsRaw = getFlag('topics');
  const pollInterval = parseInt(getFlag('interval') ?? '5000', 10);
  const enabled = !process.argv.includes('--disabled');

  if (!name) {
    throw new CLIError('--name is required', 1, {
      usage: 'iotctl devices add-mqtt --name <name> --broker mqtt://host:1883 [--topics t1,t2] [--username u] [--password p] [--interval ms] [--disabled]',
    });
  }
  if (!broker) {
    throw new CLIError('--broker is required', 1, {
      usage: 'iotctl devices add-mqtt --name <name> --broker mqtt://host:1883',
    });
  }

  const topics = topicsRaw ? topicsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];
  const connection: Record<string, any> = {
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
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to add MQTT device', 1, { error: (error as Error).message });
  }
}

/**
 * iotctl devices add-modbus --name <name> --host <ip>
 *   [--port <port>] [--slave <id>] [--interval <ms>] [--disabled]
 */
export async function modbusAdd(): Promise<void> {
  const name = getFlag('name');
  const host = getFlag('host');
  const port = parseInt(getFlag('port') ?? '502', 10);
  const slaveId = parseInt(getFlag('slave') ?? '1', 10);
  const pollInterval = parseInt(getFlag('interval') ?? '5000', 10);
  const enabled = !process.argv.includes('--disabled');

  if (!name) {
    throw new CLIError('--name is required', 1, {
      usage: 'iotctl devices add-modbus --name <name> --host <ip> [--port 502] [--slave 1] [--interval ms] [--disabled]',
    });
  }
  if (!host) {
    throw new CLIError('--host is required', 1, {
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
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to add Modbus device', 1, { error: (error as Error).message });
  }
}

/**
 * iotctl devices add-opcua --name <name> --endpoint opc.tcp://host:4840
 *   [--interval <ms>] [--disabled]
 */
export async function opcuaAdd(): Promise<void> {
  const name = getFlag('name');
  const endpointUrl = getFlag('endpoint');
  const pollInterval = parseInt(getFlag('interval') ?? '5000', 10);
  const enabled = !process.argv.includes('--disabled');

  if (!name) {
    throw new CLIError('--name is required', 1, {
      usage: 'iotctl devices add-opcua --name <name> --endpoint opc.tcp://host:4840 [--interval ms] [--disabled]',
    });
  }
  if (!endpointUrl) {
    throw new CLIError('--endpoint is required', 1, {
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
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to add OPC-UA device', 1, { error: (error as Error).message });
  }
}

/**
 * iotctl devices add-snmp --name <name> --host <ip>
 *   [--port <port>] [--community <community>] [--interval <ms>] [--disabled]
 */
export async function snmpAdd(): Promise<void> {
  const name = getFlag('name');
  const host = getFlag('host');
  const port = parseInt(getFlag('port') ?? '161', 10);
  const community = getFlag('community') ?? 'public';
  const pollInterval = parseInt(getFlag('interval') ?? '30000', 10);
  const enabled = !process.argv.includes('--disabled');

  if (!name) {
    throw new CLIError('--name is required', 1, {
      usage: 'iotctl devices add-snmp --name <name> --host <ip> [--port 161] [--community public] [--interval ms] [--disabled]',
    });
  }
  if (!host) {
    throw new CLIError('--host is required', 1, {
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
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to add SNMP device', 1, { error: (error as Error).message });
  }
}

/**
 * iotctl devices add --protocol <protocol> ...
 * Generic dispatcher: routes to the protocol-specific add command.
 */
export async function adaptersAdd(): Promise<void> {
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
      throw new CLIError('--protocol is required', 1, {
        usage: 'iotctl devices add --protocol <mqtt|modbus|opcua|snmp> [options]',
        protocols: 'mqtt, modbus, opcua, snmp',
      });
    default:
      throw new CLIError(`Unsupported protocol: ${protocol}`, 1, {
        supported: 'mqtt, modbus, opcua, snmp',
      });
  }
}
