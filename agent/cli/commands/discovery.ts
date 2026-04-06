import { DEVICE_API_V1, CLIError, logger, apiRequest, clearApiCache } from '../core';

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
      return process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
    case 'snmp':
      return `${connection.host}:${connection.port || 161}`;
    case 'bacnet':
      return `Device ID: ${connection.deviceId}`;
    case 'can':
      return `${connection.interface} (${connection.protocol || 'CAN'})`;
    default:
      return JSON.stringify(connection);
  }
}

export async function discover(protocolArg?: string): Promise<void> {
  clearApiCache();
  try {
    let validate = false;
    let protocol: string | undefined = protocolArg;

    if (process.argv.includes('--validate')) {
      validate = true;
    }

    const protocolFlagIndex = process.argv.findIndex((arg: string) => arg.startsWith('--protocol='));
    if (protocolFlagIndex !== -1) {
      const flagValue = process.argv[protocolFlagIndex].split('=')[1];
      if (flagValue) {
        protocol = flagValue;
      }
    }

    const body: any = {
      trigger: 'manual',
      validate,
    };

    if (protocol) {
      body.protocols = [protocol];
      logger.info(`Running discovery for ${protocol}${validate ? ' with validation' : ''}...`);
    } else {
      logger.info(`Running discovery for all protocols${validate ? ' with validation' : ''}...`);
    }

    if (protocol === 'modbus' || !protocol) {
      logger.info('(Modbus scanning slave IDs - this may take 30-60 seconds...)');
    }

    const result = await apiRequest(`${DEVICE_API_V1}/discover`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    const devices = result.devices || [];

    if (devices.length === 0) {
      logger.info('No devices discovered');
      return;
    }

    logger.info(`Discovered ${devices.length} device${devices.length === 1 ? '' : 's'}`);
    console.log('');

    for (const device of devices) {
      const connectionStr = formatConnection(device.protocol, device.connection);
      const confidenceIcon = device.confidence === 'high' ? '●' : device.confidence === 'medium' ? '◐' : '○';
      const validatedIcon = device.validated ? ' [V]' : '';
      const statusEnabled = device.enabled === true ? 'enabled' : 'disabled';

      logger.info(device.name, {
        protocol: device.protocol,
        connection: connectionStr,
        confidence: `${confidenceIcon} ${device.confidence}${validatedIcon}`,
        status: statusEnabled,
        discoveredAt: new Date(device.discoveredAt).toLocaleString(),
      });
    }

    console.log('');
    logger.info('Legend: ● = high confidence, ◐ = medium, ○ = low, [V] = validated');
  } catch (error) {
    throw new CLIError('Failed to run discovery', 1, {
      error: (error as Error).message,
    });
  }
}

export async function devicesList(protocolFilter?: string): Promise<void> {
  clearApiCache();
  try {
    const query = protocolFilter ? `?protocol=${protocolFilter}` : '';
    const result = await apiRequest(`${DEVICE_API_V1}/devices${query}`);
    const devices = result.devices || [];

    if (devices.length === 0) {
      logger.info('No devices found');
      return;
    }

    logger.info(`Found ${devices.length} device${devices.length === 1 ? '' : 's'}${protocolFilter ? ` (${protocolFilter})` : ''}`);
    console.log('');

    const byProtocol = devices.reduce((acc: Record<string, any[]>, d: any) => {
      const proto = d.protocol || 'unknown';
      if (!acc[proto]) acc[proto] = [];
      acc[proto].push(d);
      return acc;
    }, {});

    for (const [protocol, protoDevices] of Object.entries(byProtocol)) {
      console.log(`\n${protocol.toUpperCase()} Devices:`);
      console.log('━'.repeat(60));

      for (const device of protoDevices as any[]) {
        const enabledIcon = device.enabled ? '✓' : '✗';
        const identifierStr = device.identifier ? ` [${device.identifier}]` : '';
        const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : 'never';

        logger.info(`${enabledIcon} ${device.name}${identifierStr}`, {
          uuid: device.uuid.slice(0, 8) + '...',
          lastSeen,
        });
      }
    }

    console.log('');
  } catch (error) {
    throw new CLIError('Failed to list devices', 1, {
      error: (error as Error).message,
    });
  }
}

export async function endpointsList(protocolFilter?: string): Promise<void> {
  clearApiCache();
  try {
    const query = protocolFilter ? `?protocol=${protocolFilter}` : '';
    const result = await apiRequest(`${DEVICE_API_V1}/endpoints${query}`);
    const endpoints = result.endpoints || [];

    if (endpoints.length === 0) {
      logger.info('No endpoints configured');
      return;
    }

    logger.info(`Found ${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}${protocolFilter ? ` (${protocolFilter})` : ''}`);
    console.log('');

    const byProtocol = endpoints.reduce((acc: Record<string, any[]>, endpoint: any) => {
      const proto = endpoint.protocol || 'unknown';
      if (!acc[proto]) acc[proto] = [];
      acc[proto].push(endpoint);
      return acc;
    }, {} as Record<string, any[]>);

    for (const [protocol, protoEndpoints] of Object.entries(byProtocol)) {
      console.log(`\n${protocol.toUpperCase()} Endpoints:`);
      console.log('━'.repeat(60));

      for (const endpoint of protoEndpoints as any[]) {
        const enabledIcon = endpoint.enabled ? '✓' : '✗';
        const connectionStr = formatConnection(endpoint.protocol, endpoint.connection);

        logger.info(`${enabledIcon} ${endpoint.name}`, {
          connection: connectionStr,
          pollInterval: `${endpoint.poll_interval}ms`,
          dataPoints: endpoint.data_points?.length || 0,
        });
      }
    }

    console.log('');
  } catch (error) {
    throw new CLIError('Failed to list endpoints', 1, {
      error: (error as Error).message,
    });
  }
}

export async function endpointsShow(endpointName?: string): Promise<void> {
  clearApiCache();
  try {
    const result = await apiRequest(`${DEVICE_API_V1}/endpoints`);
    const endpoints = result.endpoints || [];

    if (!endpointName) {
      if (endpoints.length === 0) {
        logger.info('No devices configured');
        return;
      }

      logger.info(`Found ${endpoints.length} device${endpoints.length === 1 ? '' : 's'}`);
      console.log('');

      const byProtocol = endpoints.reduce((acc: Record<string, any[]>, endpoint: any) => {
        const proto = endpoint.protocol || 'unknown';
        if (!acc[proto]) acc[proto] = [];
        acc[proto].push(endpoint);
        return acc;
      }, {} as Record<string, any[]>);

      for (const [protocol, protoEndpoints] of Object.entries(byProtocol)) {
        console.log(`\n${protocol.toUpperCase()} Devices:`);
        console.log('━'.repeat(80));

        for (const endpoint of protoEndpoints as any[]) {
          const enabledIcon = endpoint.enabled ? '✓' : '✗';
          const connectionStr = formatConnection(endpoint.protocol, endpoint.connection);

          logger.info(`${enabledIcon} ${endpoint.name}`, {
            enabled: !!endpoint.enabled,
            connection: connectionStr,
            pollInterval: `${endpoint.poll_interval}ms`,
            dataPoints: endpoint.data_points?.length || 0,
          });
        }
      }

      console.log('');
      return;
    }

    const endpoint = endpoints.find((e: any) => e.name === endpointName);

    if (!endpoint) {
      throw new CLIError(`Device not found: ${endpointName}`, 1);
    }

    console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
    console.log('║                    DEVICE DETAILS                                 ║');
    console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

    logger.info('Name', { value: endpoint.name });
    logger.info('Protocol', { value: endpoint.protocol });
    logger.info('Enabled', { value: endpoint.enabled ? 'Yes' : 'No' });
    logger.info('Poll Interval', { value: `${endpoint.poll_interval}ms` });
    logger.info('Connection', { value: formatConnection(endpoint.protocol, endpoint.connection) });

    if (endpoint.data_points && endpoint.data_points.length > 0) {
      console.log('\nData Points:');
      console.log('━'.repeat(60));
      for (const dp of endpoint.data_points) {
        const dpInfo: any = {};
        if (endpoint.protocol === 'modbus') {
          dpInfo.address = dp.address;
          dpInfo.type = dp.type;
          dpInfo.dataType = dp.dataType;
        } else if (endpoint.protocol === 'opcua') {
          dpInfo.nodeId = dp.nodeId;
          dpInfo.dataType = dp.dataType;
        } else if (endpoint.protocol === 'mqtt') {
          dpInfo.topic = dp.topic;
        }
        logger.info(`  • ${dp.name || dp.label || 'unnamed'}`, dpInfo);
      }
    }

    if (endpoint.metadata && Object.keys(endpoint.metadata).length > 0) {
      console.log('\nMetadata:');
      console.log('━'.repeat(60));
      for (const [key, value] of Object.entries(endpoint.metadata)) {
        logger.info(`  ${key}`, { value });
      }
    }

    console.log('');
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to show device details', 1, {
      error: (error as Error).message,
    });
  }
}
