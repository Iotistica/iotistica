/**
 * 1Password Vault Migration Utility
 *
 * Copies all secrets from one vault to another vault
 * preserving names, fields, tags, categories.
 *
 * Requires TWO service accounts:
 *  - OLD account token
 *  - NEW account token
 */

import {
  createClient,
  Client,
  Item,
  ItemField,
} from '@1password/sdk';

interface MigrationConfig {
  sourceToken: string;
  targetToken: string;

  sourceVaultId: string;
  targetVaultId: string;

  simulate?: boolean;
}

class VaultMigrator {

  private sourceClientPromise: Promise<Client>;
  private targetClientPromise: Promise<Client>;

  private sourceVaultId: string;
  private targetVaultId: string;

  private simulate: boolean;

  constructor(cfg: MigrationConfig) {

    this.simulate = cfg.simulate ?? false;

    this.sourceVaultId = cfg.sourceVaultId;
    this.targetVaultId = cfg.targetVaultId;

    this.sourceClientPromise = createClient({
      auth: cfg.sourceToken,
      integrationName: 'Iotistica Migration',
      integrationVersion: '1.0.0',
    });

    this.targetClientPromise = createClient({
      auth: cfg.targetToken,
      integrationName: 'Iotistica Migration',
      integrationVersion: '1.0.0',
    });

  }

  private async source(): Promise<Client> {
    return this.sourceClientPromise;
  }

  private async target(): Promise<Client> {
    return this.targetClientPromise;
  }

  async migrateAll() {

    console.log('Listing source items...');

    const source = await this.source();

    const items = await source.items.list(this.sourceVaultId);

    console.log(`Found ${items.length} items`);

    for (const overview of items) {

      await this.migrateItem(overview.id);

    }

    console.log('DONE');
  }

  private async migrateItem(itemId: string) {

    const source = await this.source();
    const target = await this.target();

    const item = await source.items.get(
      this.sourceVaultId,
      itemId
    );

    console.log(`Migrating: ${item.title}`);

    if (this.simulate) {

      console.log('SIMULATE → skipping create');

      return;
    }

    const existing = await this.findByTitle(
      target,
      this.targetVaultId,
      item.title
    );

    if (existing) {

      console.log(`Already exists: ${item.title}`);

      return;
    }

    const fields: ItemField[] =
      item.fields.map(f => ({
        id: f.id,
        title: f.title,
        fieldType: f.fieldType,
        value: f.value,
      }));

    await target.items.create({

      vaultId: this.targetVaultId,

      title: item.title,

      category: item.category,

      tags: item.tags,

      fields,

    });

    console.log(`Created: ${item.title}`);
  }

  private async findByTitle(
    client: Client,
    vaultId: string,
    title: string
  ) {

    const items = await client.items.list(vaultId);

    return items.find(i => i.title === title);
  }
}


/**
 * RUN
 */

async function main() {

  const migrator = new VaultMigrator({

    sourceToken:
      process.env.OP_SOURCE_TOKEN!,

    targetToken:
      process.env.OP_TARGET_TOKEN!,

    sourceVaultId:
      process.env.OP_SOURCE_VAULT!,

    targetVaultId:
      process.env.OP_TARGET_VAULT || 'iotistica',

    simulate:
      process.env.SIMULATE_ONEPASSWORD === 'true',

  });

  await migrator.migrateAll();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});