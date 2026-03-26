/**
 * Migration: Rename agent table columns
 *
 * deviceId   -> cloudId
 * deviceName -> name
 * deviceType -> type
 *
 * Guards: each rename is skipped if the old column no longer exists.
 * Fresh installs use template.sqlite.sql which already has the new names,
 * so the old columns will never be present and this migration is a no-op.
 */

export async function up(knex) {
	if (await knex.schema.hasColumn('agent', 'deviceId')) {
		await knex.schema.table('agent', (table) => {
			table.renameColumn('deviceId', 'cloudId');
		});
	}
	if (await knex.schema.hasColumn('agent', 'deviceName')) {
		await knex.schema.table('agent', (table) => {
			table.renameColumn('deviceName', 'name');
		});
	}
	if (await knex.schema.hasColumn('agent', 'deviceType')) {
		await knex.schema.table('agent', (table) => {
			table.renameColumn('deviceType', 'type');
		});
	}
}

export async function down(knex) {
	if (await knex.schema.hasColumn('agent', 'cloudId')) {
		await knex.schema.table('agent', (table) => {
			table.renameColumn('cloudId', 'deviceId');
		});
	}
	if (await knex.schema.hasColumn('agent', 'name')) {
		await knex.schema.table('agent', (table) => {
			table.renameColumn('name', 'deviceName');
		});
	}
	if (await knex.schema.hasColumn('agent', 'type')) {
		await knex.schema.table('agent', (table) => {
			table.renameColumn('type', 'deviceType');
		});
	}
}
