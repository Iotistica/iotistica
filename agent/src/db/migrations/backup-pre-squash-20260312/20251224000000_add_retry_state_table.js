/**
 * Add Retry State Table
 * 
 * Persists retry backoff state to survive agent restarts.
 * Critical for edge devices:
 * - Power flickers don't reset backoff → prevents retry storms
 * - Reboot loops maintain exponential backoff → protects APIs
 * - Fleet-wide failures preserved → prevents thundering herd on recovery
 */

export async function up(knex) {
  const hasTable = await knex.schema.hasTable('retry_state');
  
  if (!hasTable) {
    await knex.schema.createTable('retry_state', (table) => {
      table.string('key').primary().notNullable();
      table.integer('count').notNullable().defaultTo(0);
      table.string('next_retry').notNullable(); // ISO8601 timestamp
      table.text('last_error').notNullable();
      table.integer('terminal').notNullable().defaultTo(0); // 0=retry, 1=permanently failed
      table.integer('retryable').notNullable().defaultTo(1); // 0=non-retryable (auth/config), 1=retryable
      table.string('updated_at').notNullable(); // ISO8601 timestamp
      
      // Index for cleanup queries (find old retry states)
      table.index(['updated_at'], 'idx_retry_state_updated_at');
      
      // Index for terminal state queries (monitoring/observability)
      table.index(['terminal', 'updated_at'], 'idx_retry_state_terminal');
      
      // Index for non-retryable errors (config/auth issues needing manual fix)
      table.index(['retryable', 'terminal'], 'idx_retry_state_retryable');
    });
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('retry_state');
}
