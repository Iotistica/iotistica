/**
 * Initial database schema for Iotistic Agent
 * Consolidated migration for development - combines all previous migrations
 * 
 * Tables:
 * - device: Device identity and provisioning state
 * - stateSnapshot: Container state tracking (current/target)
 * - endpoints: Protocol endpoint configurations (Modbus, SNMP, CAN, OPC-UA)
 * - endpoint_outputs: Output configuration per protocol
 * - agent_metadata: Discovery and operational metadata
 */

export async function up(knex) {
  const isWindows = process.platform === 'win32';

  // ===== Device Table =====
  // Stores device identity, provisioning state, and cloud credentials
  await knex.schema.createTable('device', (table) => {
    table.increments('id').primary();
    table.string('uuid', 255).notNullable().unique();
    table.string('deviceId', 255);
    table.string('deviceName', 255);
    table.string('deviceType', 255);
    table.string('apiKey', 255);
    table.string('apiEndpoint', 255);
    table.bigInteger('registeredAt');
    table.boolean('provisioned').defaultTo(false);
    
    // Device-specific API keys
    table.string('deviceApiKey', 255).nullable(); // Permanent device-specific key
    table.string('provisioningApiKey', 255).nullable(); // Temporary provisioning key
    
    // MQTT credentials (provided by cloud during provisioning)
    table.string('mqttUsername', 255).nullable();
    table.string('mqttPassword', 255).nullable();
    table.string('mqttBrokerUrl', 255).nullable();
    table.text('mqttBrokerConfig').nullable(); // JSON: MQTT TLS configuration
    
    // API TLS configuration
    table.text('apiTlsConfig').nullable(); // JSON: API HTTPS TLS config
    
    // Application/tenant ID
    table.integer('applicationId').nullable();
    
    // Agent version tracking
    table.string('agentVersion', 50).nullable();
    
    // System info
    table.string('macAddress', 255).nullable();
    table.string('osVersion', 255).nullable();
    
    table.timestamp('createdAt').defaultTo(knex.fn.now());
    table.timestamp('updatedAt').defaultTo(knex.fn.now());
    table.timestamp('lastSeenAt').nullable();
  });

  console.log('✓ Created device table');

  // ===== State Snapshot Table =====
  // Tracks current and target container state
  await knex.schema.createTable('stateSnapshot', (table) => {
    table.increments('id').primary();
    table.string('type', 50).notNullable(); // 'current' or 'target'
    table.text('state'); // JSON state snapshot
    table.string('stateHash', 64).nullable(); // SHA-256 hash for change detection
    table.timestamp('createdAt').defaultTo(knex.fn.now());
    
    table.index('type');
    table.index('stateHash');
  });

  console.log('✓ Created stateSnapshot table');

  // ===== Endpoints Table =====
  // Protocol endpoint configurations (formerly sensors/protocol_adapter_devices)
  await knex.schema.createTable('endpoints', (table) => {
    table.increments('id').primary();
    table.string('uuid', 255).nullable().unique(); // Device UUID
    table.string('name', 255).notNullable().unique(); // e.g., "temperature-sensor"
    table.string('protocol', 50).notNullable(); // "modbus", "can", "opcua", "snmp"
    table.boolean('enabled').notNullable().defaultTo(true);
    table.integer('poll_interval').notNullable().defaultTo(5000); // ms
    table.text('connection').notNullable(); // JSON: Connection details
    table.text('data_points').nullable(); // JSON: Register/data point mappings
    table.text('metadata').nullable(); // JSON: Protocol-specific config
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('protocol');
    table.index('enabled');
    table.index('uuid');
  });

  console.log('✓ Created endpoints table');

  // ===== Endpoint Outputs Table =====
  // Output configuration per protocol (where data goes after collection)
  await knex.schema.createTable('endpoint_outputs', (table) => {
    table.increments('id').primary();
    table.string('protocol', 50).notNullable().unique(); // One output per protocol
    table.string('socket_path', 500).notNullable(); // Named pipe or Unix socket
    table.string('data_format', 50).notNullable().defaultTo('json');
    table.string('delimiter', 10).notNullable().defaultTo('\n');
    table.boolean('include_timestamp').notNullable().defaultTo(true);
    table.boolean('include_device_name').notNullable().defaultTo(true);
    table.text('logging').nullable(); // JSON: Logging configuration
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });

  console.log('✓ Created endpoint_outputs table');

  // Insert default output configurations
  await knex('endpoint_outputs').insert([
    {
      protocol: 'modbus',
      socket_path: isWindows ? '\\\\.\\pipe\\modbus' : '/tmp/modbus.sock',
      data_format: 'json',
      delimiter: '\n',
      include_timestamp: true,
      include_device_name: true,
      logging: JSON.stringify({ level: 'info' })
    },
    {
      protocol: 'snmp',
      socket_path: isWindows ? '\\\\.\\pipe\\snmp' : '/tmp/snmp.sock',
      data_format: 'json',
      delimiter: '\n',
      include_timestamp: true,
      include_device_name: true,
      logging: JSON.stringify({ level: 'info' })
    }
  ]);

  console.log('✓ Inserted default endpoint outputs');

  // ===== Agent Metadata Table =====
  // Discovery metadata and operational state
  await knex.schema.createTable('agent_metadata', (table) => {
    table.string('key', 255).primary();
    table.text('value').notNullable();
    table.timestamp('createdAt').defaultTo(knex.fn.now());
    table.timestamp('updatedAt').defaultTo(knex.fn.now());
  });

  console.log('✓ Created agent_metadata table');
  console.log('✓ Database schema initialized');
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('agent_metadata');
  await knex.schema.dropTableIfExists('endpoint_outputs');
  await knex.schema.dropTableIfExists('endpoints');
  await knex.schema.dropTableIfExists('stateSnapshot');
  await knex.schema.dropTableIfExists('device');
  
  console.log('✓ Dropped all tables');
}
