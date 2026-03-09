/**
 * 1Password Vault Migration Utility
 *
 * Copies all items from one vault to another, preserving core metadata
 * (title, category, tags, and fields).
 *
 * Environment variables (preferred):
 * - ONEPASSWORD_CONNECT_TOKEN
 * - ONEPASSWORD_VAULT_ID
 * - ONEPASSWORD_CONNECT_TOKEN_TARGET
 * - ONEPASSWORD_VAULT_ID_TARGET
 *
 * Backward-compatible aliases (legacy):
 * - OP_SOURCE_TOKEN / OP_SOURCE_VAULT
 * - OP_TARGET_TOKEN / OP_TARGET_VAULT
 */

import path from 'path';
import dotenv from 'dotenv';
import { createClient, Client, ItemFieldType } from '@1password/sdk';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface MigrationConfig {
  sourceToken: string;
  targetToken: string;
  sourceVaultId: string;
  targetVaultId: string;
  simulate: boolean;
  overwriteExisting: boolean;
}

interface MigrationStats {
  total: number;
  created: number;
  skippedExisting: number;
  failed: number;
}

interface MigratedField {
  id: string;
  title: string;
  fieldType: ItemFieldType;
  value: string;
}

class VaultMigrator {
  private readonly sourceClientPromise: Promise<Client>;
  private readonly targetClientPromise: Promise<Client>;
  private readonly sourceVaultId: string;
  private readonly targetVaultId: string;
  private readonly simulate: boolean;
  private readonly overwriteExisting: boolean;

  constructor(cfg: MigrationConfig) {
    this.simulate = cfg.simulate;
    this.overwriteExisting = cfg.overwriteExisting;
    this.sourceVaultId = cfg.sourceVaultId;
    this.targetVaultId = cfg.targetVaultId;

    this.sourceClientPromise = createClient({
      auth: cfg.sourceToken,
      integrationName: 'Iotistica Vault Migration',
      integrationVersion: '1.1.0',
    });

    this.targetClientPromise = createClient({
      auth: cfg.targetToken,
      integrationName: 'Iotistica Vault Migration',
      integrationVersion: '1.1.0',
    });
  }

  private async source(): Promise<Client> {
    return this.sourceClientPromise;
  }

  private async target(): Promise<Client> {
    return this.targetClientPromise;
  }

  async migrateAll(): Promise<MigrationStats> {
    const source = await this.source();
    const target = await this.target();

    console.log('[1Password Migration] Reading source vault items...');
    const sourceItems = await source.items.list(this.sourceVaultId);
    console.log(`[1Password Migration] Source items: ${sourceItems.length}`);

    console.log('[1Password Migration] Reading target vault items...');
    const targetItems = await target.items.list(this.targetVaultId);
    const targetByTitle = new Map<string, string>();
    for (const item of targetItems) {
      targetByTitle.set(item.title, item.id);
    }
    console.log(`[1Password Migration] Target items: ${targetItems.length}`);

    const stats: MigrationStats = {
      total: sourceItems.length,
      created: 0,
      skippedExisting: 0,
      failed: 0,
    };

    for (const sourceOverview of sourceItems) {
      try {
        const migrated = await this.migrateOne(sourceOverview.id, targetByTitle);
        if (migrated === 'created') {
          stats.created += 1;
        } else if (migrated === 'skipped-existing') {
          stats.skippedExisting += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stats.failed += 1;
        console.error(
          `[1Password Migration] FAILED itemId=${sourceOverview.id}:`,
          message
        );

        // Fail fast on vault permission/scope problems to avoid noisy 300+ failures.
        if (message.toLowerCase().includes('not sufficient permissions')) {
          throw new Error(
            [
              'Target 1Password token does not have write permission to target vault.',
              `targetVaultId=${this.targetVaultId}`,
              'Grant the service account create/edit item permission on this vault, then rerun.',
              'Tip: verify token belongs to the same 1Password account as the target vault.'
            ].join(' ')
          );
        }
      }
    }

    return stats;
  }

  private async migrateOne(
    itemId: string,
    targetByTitle: Map<string, string>
  ): Promise<'created' | 'skipped-existing'> {
    const source = await this.source();
    const target = await this.target();

    const item = await source.items.get(this.sourceVaultId, itemId);
    const title = item.title?.trim();

    if (!title) {
      throw new Error(`Item ${itemId} has no title; cannot migrate safely`);
    }

    console.log(`[1Password Migration] Processing: ${title}`);

    const existingId = targetByTitle.get(title);
    if (existingId && !this.overwriteExisting) {
      console.log(`[1Password Migration] Skipped existing: ${title}`);
      return 'skipped-existing';
    }

    if (this.simulate) {
      console.log(`[1Password Migration] SIMULATE create/update: ${title}`);
      return existingId ? 'skipped-existing' : 'created';
    }

    const fields = this.normalizeFields(item.fields);

    if (existingId && this.overwriteExisting) {
      const current = await target.items.get(this.targetVaultId, existingId);
      await target.items.put({
        ...current,
        title,
        category: item.category,
        tags: item.tags,
        fields,
      });
      console.log(`[1Password Migration] Updated existing: ${title}`);
      return 'created';
    }

    const created = await target.items.create({
      vaultId: this.targetVaultId,
      title,
      category: item.category,
      tags: item.tags,
      fields,
    });

    targetByTitle.set(title, created.id);
    console.log(`[1Password Migration] Created: ${title}`);
    return 'created';
  }

  private normalizeFields(fields: Array<{ id: string; title: string; fieldType: ItemFieldType; value: string }>): MigratedField[] {
    const normalized: MigratedField[] = [];
    const usedIds = new Set<string>();

    for (const field of fields) {
      const rawValue = field.value;
      if (rawValue == null) {
        continue;
      }

      const trimmedTitle = (field.title || field.id || 'field').trim();
      let candidateId = (field.id || '').trim();
      if (!candidateId) {
        candidateId = trimmedTitle.toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'field';
      }

      // Ensure unique ids in payload.
      let uniqueId = candidateId;
      let suffix = 1;
      while (usedIds.has(uniqueId)) {
        uniqueId = `${candidateId}_${suffix}`;
        suffix += 1;
      }
      usedIds.add(uniqueId);

      normalized.push({
        id: uniqueId,
        title: trimmedTitle,
        fieldType: field.fieldType,
        value: String(rawValue),
      });
    }

    return normalized;
  }
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true';
}

function requiredEnv(name: string, value: string | undefined): string {
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function readConfigFromEnv(): MigrationConfig {
  const sourceToken = process.env.ONEPASSWORD_CONNECT_TOKEN ?? process.env.OP_SOURCE_TOKEN;
  const targetToken = process.env.ONEPASSWORD_CONNECT_TOKEN_TARGET ?? process.env.OP_TARGET_TOKEN;
  const sourceVaultId = process.env.ONEPASSWORD_VAULT_ID ?? process.env.OP_SOURCE_VAULT;
  const targetVaultId = process.env.ONEPASSWORD_VAULT_ID_TARGET ?? process.env.OP_TARGET_VAULT;

  return {
    sourceToken: requiredEnv('ONEPASSWORD_CONNECT_TOKEN (or OP_SOURCE_TOKEN)', sourceToken),
    targetToken: requiredEnv('ONEPASSWORD_CONNECT_TOKEN_TARGET (or OP_TARGET_TOKEN)', targetToken),
    sourceVaultId: requiredEnv('ONEPASSWORD_VAULT_ID (or OP_SOURCE_VAULT)', sourceVaultId),
    targetVaultId: requiredEnv('ONEPASSWORD_VAULT_ID_TARGET (or OP_TARGET_VAULT)', targetVaultId),
    simulate: parseBool(process.env.SIMULATE_ONEPASSWORD, false),
    overwriteExisting: parseBool(process.env.ONEPASSWORD_MIGRATION_OVERWRITE, false),
  };
}

async function main(): Promise<void> {
  const config = readConfigFromEnv();

  console.log('[1Password Migration] Starting migration');
  console.log(`[1Password Migration] sourceVaultId=${config.sourceVaultId}`);
  console.log(`[1Password Migration] targetVaultId=${config.targetVaultId}`);
  console.log(`[1Password Migration] simulate=${config.simulate}`);
  console.log(`[1Password Migration] overwriteExisting=${config.overwriteExisting}`);

  const migrator = new VaultMigrator(config);
  const stats = await migrator.migrateAll();

  console.log('[1Password Migration] DONE');
  console.log(
    `[1Password Migration] total=${stats.total} created=${stats.created} skippedExisting=${stats.skippedExisting} failed=${stats.failed}`
  );

  if (stats.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[1Password Migration] Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});