/**
 * Migration: Add operational indexes for message buffer dequeue/cleanup paths
 *
 * Improves performance for:
 * - dequeueReady (status + next_retry_at + created_at)
 * - lock lookups and recovery (lock_id, status + locked_at)
 * - expiration cleanup (expires_at)
 */

export async function up(knex) {
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_message_buffer_ready ON message_buffer(status, next_retry_at, created_at)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_message_buffer_lock_id ON message_buffer(lock_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_message_buffer_lock_recovery ON message_buffer(status, locked_at)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_message_buffer_expires_at ON message_buffer(expires_at)');

  console.log('✓ Added message_buffer operational indexes');
}

export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_message_buffer_ready');
  await knex.raw('DROP INDEX IF EXISTS idx_message_buffer_lock_id');
  await knex.raw('DROP INDEX IF EXISTS idx_message_buffer_lock_recovery');
  await knex.raw('DROP INDEX IF EXISTS idx_message_buffer_expires_at');

  console.log('✓ Removed message_buffer operational indexes');
}
