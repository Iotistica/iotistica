/**
 * Migration: Add additional indexes for large message buffer workloads
 *
 * Adds targeted indexes for:
 * - claim/dequeue scans by status+lock+created_at
 * - retry-ready scans by status+next_retry_at
 * - endpoint-level inspections
 */

export async function up(knex) {
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_message_buffer_status_lock_created ON message_buffer(status, lock_id, created_at)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_message_buffer_status_retry ON message_buffer(status, next_retry_at)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_message_buffer_endpoint_name ON message_buffer(endpoint_name)');

  console.log('✓ Added additional message_buffer indexes');
}

export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_message_buffer_status_lock_created');
  await knex.raw('DROP INDEX IF EXISTS idx_message_buffer_status_retry');
  await knex.raw('DROP INDEX IF EXISTS idx_message_buffer_endpoint_name');

  console.log('✓ Removed additional message_buffer indexes');
}
