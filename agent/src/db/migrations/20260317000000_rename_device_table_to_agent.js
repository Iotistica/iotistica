/**
 * Migration: Rename 'device' table to 'agent'
 *
 * The table was previously named 'device' to match the domain entity.
 * Renaming to 'agent' better reflects that this is the agent's own
 * identity and provisioning record (not a generic device registry).
 *
 * SQLite supports ALTER TABLE ... RENAME TO natively.
 * The unique index 'device_uuid_unique' is automatically carried over
 * but keeps its original name; a new index is created with the
 * canonical name and the old one dropped.
 */

export async function up(knex) {
	// Only rename if the old table still exists (idempotent for fresh installs
	// that were created after the squashed schema already uses 'agent')
	const hasDeviceTable = await knex.schema.hasTable('device');
	if (hasDeviceTable) {
		await knex.schema.renameTable('device', 'agent');

		// Recreate the unique index under the canonical name.
		// SQLite does not support ALTER INDEX, so we drop and recreate.
		await knex.schema.table('agent', (table) => {
			table.dropUnique(['uuid'], 'device_uuid_unique');
		});
		await knex.schema.table('agent', (table) => {
			table.unique(['uuid'], { indexName: 'agent_uuid_unique' });
		});
	}
}

export async function down(knex) {
	const hasAgentTable = await knex.schema.hasTable('agent');
	if (hasAgentTable) {
		await knex.schema.table('agent', (table) => {
			table.dropUnique(['uuid'], 'agent_uuid_unique');
		});
		await knex.schema.table('agent', (table) => {
			table.unique(['uuid'], { indexName: 'device_uuid_unique' });
		});
		await knex.schema.renameTable('agent', 'device');
	}
}
