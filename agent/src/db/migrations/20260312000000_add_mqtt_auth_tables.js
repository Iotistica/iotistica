/**
 * Migration: Add MQTT auth tables for agent-local broker auth reconciliation
 *
 * Creates mqtt_users and mqtt_acls tables in agent SQLite so target-state auth
 * manifests can be reconciled locally and used by broker auth backends.
 */

exports.up = async function(knex) {
  const hasUsers = await knex.schema.hasTable('mqtt_users');
  if (!hasUsers) {
    await knex.schema.createTable('mqtt_users', function(table) {
      table.increments('id').primary();
      table.string('username', 255).notNullable().unique();
      table.string('password_hash', 255).notNullable();
      table.boolean('is_superuser').notNullable().defaultTo(false);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
    });
  }

  const hasAcls = await knex.schema.hasTable('mqtt_acls');
  if (!hasAcls) {
    await knex.schema.createTable('mqtt_acls', function(table) {
      table.increments('id').primary();
      table.string('username', 255);
      table.string('clientid', 255);
      table.string('topic', 255).notNullable();
      table.integer('access').notNullable();
      table.integer('priority').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
    });

    await knex.schema.raw('CREATE INDEX IF NOT EXISTS idx_mqtt_acls_username ON mqtt_acls(username)');
    await knex.schema.raw('CREATE INDEX IF NOT EXISTS idx_mqtt_acls_topic ON mqtt_acls(topic)');
  }
};

exports.down = async function(knex) {
  const hasAcls = await knex.schema.hasTable('mqtt_acls');
  if (hasAcls) {
    await knex.schema.dropTable('mqtt_acls');
  }

  const hasUsers = await knex.schema.hasTable('mqtt_users');
  if (hasUsers) {
    await knex.schema.dropTable('mqtt_users');
  }
};
