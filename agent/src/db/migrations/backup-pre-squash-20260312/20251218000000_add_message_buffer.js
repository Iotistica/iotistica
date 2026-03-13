/**
 * Migration: Add message buffer table
 * 
 * Purpose: Store sensor/endpoint data locally when MQTT is unavailable
 * Implements offline queue pattern from AWS IoT Greengrass and Azure IoT Edge
 * 
 * Key features:
 * - FIFO queue with automatic pruning
 * - Configurable max size (default 10,000 records)
 * - Automatic flush on MQTT reconnect
 * - TTL-based cleanup for old data
 */

export async function up(knex) {
  // ===== Message Buffer Table =====
  // Queues sensor/endpoint data when MQTT is unavailable
  await knex.schema.createTable('message_buffer', (table) => {
    table.increments('id').primary();
    
    // Message metadata
    table.string('endpoint_name', 255).notNullable(); // Name of endpoint/sensor
    table.string('topic', 500).notNullable(); // MQTT topic to publish to
    table.integer('qos').notNullable().defaultTo(1); // MQTT QoS level
    
    // Message payload
    table.text('payload').notNullable(); // JSON payload
    table.integer('payload_bytes').notNullable(); // Size in bytes for quota tracking
    
    // Retry tracking
    table.integer('retry_count').notNullable().defaultTo(0);
    table.timestamp('last_retry_at').nullable();
    table.text('last_error').nullable(); // Last publish error
    
    // Timestamps
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('expires_at').notNullable(); // TTL for data expiration
    
    // Indexes for efficient queries
    table.index('created_at'); // FIFO ordering
    table.index('expires_at'); // Cleanup queries
    table.index(['endpoint_name', 'created_at']); // Per-endpoint stats
  });

  // ===== Buffer Metadata Table =====
  // Track buffer statistics and quotas
  await knex.schema.createTable('message_buffer_metadata', (table) => {
    table.string('key', 100).primary();
    table.text('value').notNullable();
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });

  // Initialize default metadata
  await knex('message_buffer_metadata').insert([
    {
      key: 'max_records',
      value: '10000', // Max records before dropping oldest
      updated_at: knex.fn.now()
    },
    {
      key: 'max_bytes',
      value: '52428800', // 50 MB max buffer size
      updated_at: knex.fn.now()
    },
    {
      key: 'ttl_hours',
      value: '72', // Data expires after 3 days
      updated_at: knex.fn.now()
    },
    {
      key: 'last_cleanup_at',
      value: new Date().toISOString(),
      updated_at: knex.fn.now()
    },
    {
      key: 'total_buffered',
      value: '0', // Total messages buffered (lifetime)
      updated_at: knex.fn.now()
    },
    {
      key: 'total_flushed',
      value: '0', // Total messages flushed successfully
      updated_at: knex.fn.now()
    },
    {
      key: 'total_dropped',
      value: '0', // Total messages dropped (quota exceeded)
      updated_at: knex.fn.now()
    }
  ]);

  console.log('✓ Created message_buffer and message_buffer_metadata tables');
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('message_buffer_metadata');
  await knex.schema.dropTableIfExists('message_buffer');
  
  console.log('✓ Dropped message buffer tables');
}
