/**
 * Initial migration for container-manager database
 * Creates tables for apps, services, images, and state tracking
 */

export async function up(knex) {

	// Create state snapshot table
	await knex.schema.createTable('stateSnapshot', (table) => {
		table.increments('id').primary();
		table.string('type').notNullable(); // 'current' or 'target'
		table.json('state'); // Full state snapshot
		table.timestamp('createdAt').defaultTo(knex.fn.now());
	});

	console.log('Created stateSnapshot table');
}

export async function down(knex) {
	await knex.schema.dropTableIfExists('stateSnapshot');
}
