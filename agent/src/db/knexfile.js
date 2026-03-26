// Knex configuration for development
// Used when running "npx knex migrate:make <migration_name>"

module.exports = {
	client: 'sqlite3',
	connection: {
		filename: '../../data/agent.sqlite'
	},
	useNullAsDefault: true,
	migrations: {
		directory: './migrations'
	}
};
