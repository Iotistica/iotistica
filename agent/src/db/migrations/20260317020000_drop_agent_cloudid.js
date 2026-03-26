/**
 * Migration: Drop cloudId column from agent table
 *
 * cloudId was the cloud-assigned numeric PK for the device row on the server.
 * It was only used for logging and was never sent in any API calls, making it
 * redundant. The agent always identifies itself by UUID.
 *
 * Guard: skipped if the column no longer exists (fresh installs using the
 * updated template.sqlite.sql will never have this column).
 */

export async function up(knex) {
	if (await knex.schema.hasColumn('agent', 'cloudId')) {
		await knex.schema.table('agent', (table) => {
			table.dropColumn('cloudId');
		});
	}
}

export async function down(knex) {
	if (!(await knex.schema.hasColumn('agent', 'cloudId'))) {
		await knex.schema.table('agent', (table) => {
			table.integer('cloudId').nullable();
		});
	}
}
