/**
 * Migration: Add retry backoff and message ID persistence columns to message_buffer
 *
 * Purpose:
 * - Persist msg_id for store-and-forward deduplication
 * - Persist next_retry_at for scheduled retry backoff
 */

export async function up(knex) {
  const hasMsgId = await knex.schema.hasColumn('message_buffer', 'msg_id');
  if (!hasMsgId) {
    await knex.schema.alterTable('message_buffer', (table) => {
      table.string('msg_id', 255).nullable();
      table.index('msg_id');
    });
  }

  const hasNextRetryAt = await knex.schema.hasColumn('message_buffer', 'next_retry_at');
  if (!hasNextRetryAt) {
    await knex.schema.alterTable('message_buffer', (table) => {
      table.timestamp('next_retry_at').nullable();
      table.index('next_retry_at');
    });
  }

  const hasIsCritical = await knex.schema.hasColumn('message_buffer', 'is_critical');
  if (!hasIsCritical) {
    await knex.schema.alterTable('message_buffer', (table) => {
      table.integer('is_critical').notNullable().defaultTo(0);
      table.index('is_critical');
    });
  }

  const hasStatus = await knex.schema.hasColumn('message_buffer', 'status');
  if (!hasStatus) {
    await knex.schema.alterTable('message_buffer', (table) => {
      table.string('status', 20).notNullable().defaultTo('queued');
      table.index('status');
    });
  }

  const hasLockId = await knex.schema.hasColumn('message_buffer', 'lock_id');
  if (!hasLockId) {
    await knex.schema.alterTable('message_buffer', (table) => {
      table.string('lock_id', 64).nullable();
      table.index('lock_id');
    });
  }

  const hasLockedAt = await knex.schema.hasColumn('message_buffer', 'locked_at');
  if (!hasLockedAt) {
    await knex.schema.alterTable('message_buffer', (table) => {
      table.timestamp('locked_at').nullable();
      table.index('locked_at');
    });
  }

  console.log('✓ Added retry/msg_id/status/critical columns to message_buffer');
}

export async function down(knex) {
  const hasMsgId = await knex.schema.hasColumn('message_buffer', 'msg_id');
  if (hasMsgId) {
    await knex.schema.alterTable('message_buffer', (table) => {
      table.dropIndex('msg_id');
      table.dropColumn('msg_id');
    });
  }

  const hasNextRetryAt = await knex.schema.hasColumn('message_buffer', 'next_retry_at');
  if (hasNextRetryAt) {
    await knex.schema.alterTable('message_buffer', (table) => {
      table.dropIndex('next_retry_at');
      table.dropColumn('next_retry_at');
    });
  }

  const hasLockedAt = await knex.schema.hasColumn('message_buffer', 'locked_at');
  if (hasLockedAt) {
    await knex.schema.alterTable('message_buffer', (table) => {
      table.dropIndex('locked_at');
      table.dropColumn('locked_at');
    });
  }

  const hasLockId = await knex.schema.hasColumn('message_buffer', 'lock_id');
  if (hasLockId) {
    await knex.schema.alterTable('message_buffer', (table) => {
      table.dropIndex('lock_id');
      table.dropColumn('lock_id');
    });
  }

  const hasStatus = await knex.schema.hasColumn('message_buffer', 'status');
  if (hasStatus) {
    await knex.schema.alterTable('message_buffer', (table) => {
      table.dropIndex('status');
      table.dropColumn('status');
    });
  }

  const hasIsCritical = await knex.schema.hasColumn('message_buffer', 'is_critical');
  if (hasIsCritical) {
    await knex.schema.alterTable('message_buffer', (table) => {
      table.dropIndex('is_critical');
      table.dropColumn('is_critical');
    });
  }

  console.log('✓ Removed retry/msg_id/status/critical columns from message_buffer');
}
