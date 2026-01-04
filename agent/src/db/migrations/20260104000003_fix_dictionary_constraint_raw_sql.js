/**
 * Migration: Fix dictionary unique constraint for domain-partitioned dictionaries
 * 
 * Problem: SQLite tables created with Knex have UNIQUE(field_index) globally
 * Solution: Use raw SQL to drop and recreate constraints with UNIQUE(domain, field_index)
 */

export async function up(knex) {
  // SQLite approach: We'll use PRAGMA foreign_keys to handle the rebuild
  
  // 1. Disable foreign key constraints temporarily
  await knex.raw('PRAGMA foreign_keys = OFF');

  try {
    // 2. Create new dictionary_entries table with correct constraints
    await knex.raw(`
      CREATE TABLE dictionary_entries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        field_name TEXT NOT NULL UNIQUE,
        field_index INTEGER NOT NULL,
        domain TEXT NOT NULL DEFAULT 'key' CHECK (domain IN ('key', 'metric', 'unit', 'quality', 'device')),
        version_added INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(domain, field_index)
      )
    `);

    // 3. Copy data
    await knex.raw(`
      INSERT INTO dictionary_entries_new 
      SELECT id, field_name, field_index, COALESCE(domain, 'key'), version_added, created_at 
      FROM dictionary_entries
    `);

    // 4. Drop old table and rename
    await knex.raw('DROP TABLE dictionary_entries');
    await knex.raw('ALTER TABLE dictionary_entries_new RENAME TO dictionary_entries');

    // 5. Recreate indexes
    await knex.raw('CREATE INDEX dictionary_entries_field_name ON dictionary_entries(field_name)');
    await knex.raw('CREATE INDEX dictionary_entries_domain_field_index ON dictionary_entries(domain, field_index)');
    await knex.raw('CREATE INDEX dictionary_entries_domain ON dictionary_entries(domain)');
    await knex.raw('CREATE INDEX dictionary_entries_version_added ON dictionary_entries(version_added)');

    // 6. Now rebuild dictionary_deltas
    await knex.raw(`
      CREATE TABLE dictionary_deltas_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL,
        field_name TEXT NOT NULL,
        field_index INTEGER NOT NULL,
        domain TEXT NOT NULL DEFAULT 'metric' CHECK (domain IN ('key', 'metric', 'unit', 'quality', 'device')),
        synced_to_cloud BOOLEAN NOT NULL DEFAULT 0,
        synced_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(domain, field_index)
      )
    `);

    // 7. Copy data
    await knex.raw(`
      INSERT INTO dictionary_deltas_new 
      SELECT id, version, field_name, field_index, COALESCE(domain, 'metric'), synced_to_cloud, synced_at, created_at 
      FROM dictionary_deltas
    `);

    // 8. Drop old table and rename
    await knex.raw('DROP TABLE dictionary_deltas');
    await knex.raw('ALTER TABLE dictionary_deltas_new RENAME TO dictionary_deltas');

    // 9. Recreate indexes
    await knex.raw('CREATE INDEX dictionary_deltas_version ON dictionary_deltas(version)');
    await knex.raw('CREATE INDEX dictionary_deltas_domain ON dictionary_deltas(domain)');
    await knex.raw('CREATE INDEX dictionary_deltas_domain_synced_to_cloud ON dictionary_deltas(domain, synced_to_cloud)');
    await knex.raw('CREATE INDEX dictionary_deltas_synced_to_cloud ON dictionary_deltas(synced_to_cloud)');
    await knex.raw('CREATE INDEX dictionary_deltas_version_synced ON dictionary_deltas(version, synced_to_cloud)');

  } finally {
    // Re-enable foreign keys
    await knex.raw('PRAGMA foreign_keys = ON');
  }
}

export async function down(knex) {
  // Rollback - recreate with original constraints (global unique on field_index)
  
  await knex.raw('PRAGMA foreign_keys = OFF');

  try {
    // Rebuild dictionary_entries with original schema
    await knex.raw(`
      CREATE TABLE dictionary_entries_old (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        field_name TEXT NOT NULL UNIQUE,
        field_index INTEGER NOT NULL UNIQUE,
        domain TEXT DEFAULT 'key',
        version_added INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Copy only entries from key domain to preserve global unique constraint
    await knex.raw(`
      INSERT INTO dictionary_entries_old 
      SELECT id, field_name, field_index, domain, version_added, created_at 
      FROM dictionary_entries
      WHERE domain = 'key' OR domain IS NULL
    `);

    await knex.raw('DROP TABLE dictionary_entries');
    await knex.raw('ALTER TABLE dictionary_entries_old RENAME TO dictionary_entries');

    await knex.raw('CREATE INDEX dictionary_entries_field_name ON dictionary_entries(field_name)');
    await knex.raw('CREATE INDEX dictionary_entries_field_index ON dictionary_entries(field_index)');
    await knex.raw('CREATE INDEX dictionary_entries_version_added ON dictionary_entries(version_added)');
    await knex.raw('CREATE INDEX dictionary_entries_domain ON dictionary_entries(domain)');

    // Rebuild dictionary_deltas with original schema
    await knex.raw(`
      CREATE TABLE dictionary_deltas_old (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL,
        field_name TEXT NOT NULL,
        field_index INTEGER NOT NULL UNIQUE,
        domain TEXT DEFAULT 'metric',
        synced_to_cloud BOOLEAN NOT NULL DEFAULT 0,
        synced_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Copy only metric domain entries
    await knex.raw(`
      INSERT INTO dictionary_deltas_old 
      SELECT id, version, field_name, field_index, domain, synced_to_cloud, synced_at, created_at 
      FROM dictionary_deltas
      WHERE domain = 'metric' OR domain IS NULL
    `);

    await knex.raw('DROP TABLE dictionary_deltas');
    await knex.raw('ALTER TABLE dictionary_deltas_old RENAME TO dictionary_deltas');

    await knex.raw('CREATE INDEX dictionary_deltas_version ON dictionary_deltas(version)');
    await knex.raw('CREATE INDEX dictionary_deltas_synced_to_cloud ON dictionary_deltas(synced_to_cloud)');
    await knex.raw('CREATE INDEX dictionary_deltas_version_synced ON dictionary_deltas(version, synced_to_cloud)');

  } finally {
    await knex.raw('PRAGMA foreign_keys = ON');
  }
}
