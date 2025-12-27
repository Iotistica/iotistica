/**
 * Migration: Add MQTT output configuration
 * 
 * Adds MQTT entry to endpoint_outputs table for MQTT adapter support.
 * MQTT adapter subscribes to topics from Mosquitto broker and forwards
 * data to Sensor Publish via Unix socket.
 * 
 * Architecture:
 * - External MQTT publishers (ESP32, PLCs, IoT devices) → Mosquitto broker
 * - Agent MQTT adapter subscribes to topics → /tmp/mqtt.sock
 * - Sensor Publish reads from socket → Cloud MQTT
 */

export async function up(knex) {
  const isWindows = process.platform === 'win32';
  
  // Check if mqtt output already exists
  const existing = await knex('endpoint_outputs')
    .where('protocol', 'mqtt')
    .first();
  
  if (!existing) {
    await knex('endpoint_outputs').insert({
      protocol: 'mqtt',
      socket_path: isWindows ? '\\\\.\\pipe\\mqtt' : '/tmp/mqtt.sock',
      data_format: 'json',
      delimiter: '\n',
      include_timestamp: true,
      include_device_name: true,
      logging: JSON.stringify({ level: 'info' })
    });
    
    console.log('✓ Added MQTT output configuration');
  } else {
    console.log('ℹ MQTT output configuration already exists, skipping');
  }
}

export async function down(knex) {
  await knex('endpoint_outputs')
    .where('protocol', 'mqtt')
    .delete();
  
  console.log('✓ Removed MQTT output configuration');
}
