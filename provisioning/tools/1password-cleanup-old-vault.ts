/**
 * 1Password Old Vault Cleanup Utility
 *
 * Deletes legacy secrets from the old/source vault after migration.
 *
 * Default secret item titles to delete:
 * - ONEPASSWORD_CONNECT_TOKEN
 * - ONEPASSWORD_VAULT_ID
 *
 * Environment variables:
 * - ONEPASSWORD_CONNECT_TOKEN (or OP_SOURCE_TOKEN)
 * - ONEPASSWORD_VAULT_ID (or OP_SOURCE_VAULT)
 *
 * Optional:
 * - ONEPASSWORD_CLEANUP_TITLES (comma-separated item titles)
 * - SIMULATE_ONEPASSWORD=true (dry run)
 */

import path from 'path';
import dotenv from 'dotenv';
import { createClient, Client } from '@1password/sdk';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface CleanupConfig {
  sourceToken: string;
  sourceVaultId: string;
  titlesToDelete: string[];
  simulate: boolean;
  sourceTokenName: string;
  sourceVaultName: string;
}

interface CleanupStats {
  requested: number;
  found: number;
  deleted: number;
  notFound: number;
  failed: number;
}

const DEFAULT_TITLES = ['ONEPASSWORD_CONNECT_TOKEN', 'ONEPASSWORD_VAULT_ID'];

function requiredEnv(name: string, value: string | undefined): string {
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true';
}

function parseTitles(value: string | undefined): string[] {
  if (!value) {
    return [...DEFAULT_TITLES];
  }

  const titles = value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  return titles.length > 0 ? titles : [...DEFAULT_TITLES];
}

function readConfigFromEnv(): CleanupConfig {
  const sourceTokenPairs: Array<[string, string | undefined]> = [
    ['ONEPASSWORD_CLEANUP_SOURCE_TOKEN', process.env.ONEPASSWORD_CLEANUP_SOURCE_TOKEN],
    ['ONEPASSWORD_CONNECT_TOKEN', process.env.ONEPASSWORD_CONNECT_TOKEN],
    ['OP_SOURCE_TOKEN', process.env.OP_SOURCE_TOKEN],
  ];
  const sourceVaultPairs: Array<[string, string | undefined]> = [
    ['ONEPASSWORD_CLEANUP_SOURCE_VAULT_ID', process.env.ONEPASSWORD_CLEANUP_SOURCE_VAULT_ID],
    ['ONEPASSWORD_VAULT_ID', process.env.ONEPASSWORD_VAULT_ID],
    ['OP_SOURCE_VAULT', process.env.OP_SOURCE_VAULT],
  ];

  const selectedTokenPair = sourceTokenPairs.find(([, value]) => !!value && !!value.trim());
  const selectedVaultPair = sourceVaultPairs.find(([, value]) => !!value && !!value.trim());

  const sourceToken = selectedTokenPair?.[1];
  const sourceVaultId = selectedVaultPair?.[1];

  return {
    sourceToken: requiredEnv('ONEPASSWORD_CONNECT_TOKEN (or OP_SOURCE_TOKEN)', sourceToken),
    sourceVaultId: requiredEnv('ONEPASSWORD_VAULT_ID (or OP_SOURCE_VAULT)', sourceVaultId),
    titlesToDelete: parseTitles(process.env.ONEPASSWORD_CLEANUP_TITLES),
    simulate: parseBool(process.env.SIMULATE_ONEPASSWORD, false),
    sourceTokenName: selectedTokenPair?.[0] || 'unknown',
    sourceVaultName: selectedVaultPair?.[0] || 'unknown',
  };
}

async function createSourceClient(sourceToken: string): Promise<Client> {
  return createClient({
    auth: sourceToken,
    integrationName: 'Iotistica Vault Cleanup',
    integrationVersion: '1.0.0',
  });
}

async function cleanupOldVault(config: CleanupConfig): Promise<CleanupStats> {
  let client: Client;
  try {
    client = await createSourceClient(config.sourceToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `Unable to authenticate with source token from ${config.sourceTokenName}.`,
        `sourceVaultId=${config.sourceVaultId} (${config.sourceVaultName}).`,
        `Underlying error: ${message}`,
        'Action: set ONEPASSWORD_CLEANUP_SOURCE_TOKEN to a valid old-vault token',
        'and ONEPASSWORD_CLEANUP_SOURCE_VAULT_ID to the old vault id, then rerun.',
      ].join(' ')
    );
  }

  console.log('[1Password Cleanup] Preflight: verifying source vault access...');
  let items;
  try {
    items = await client.items.list(config.sourceVaultId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `Unable to access source vault '${config.sourceVaultId}' with token from ${config.sourceTokenName}.`,
        `sourceVaultEnv=${config.sourceVaultName}.`,
        `Underlying error: ${message}`,
        'Action: use a service account token that has read/delete permission on the old vault,',
        'or set ONEPASSWORD_CLEANUP_SOURCE_TOKEN and ONEPASSWORD_CLEANUP_SOURCE_VAULT_ID explicitly.',
      ].join(' ')
    );
  }

  console.log('[1Password Cleanup] Reading old vault items...');
  console.log(`[1Password Cleanup] Items in old vault: ${items.length}`);

  const itemsByTitle = new Map<string, { id: string; title: string }>();
  for (const item of items) {
    const title = item.title?.trim();
    if (!title) {
      continue;
    }
    itemsByTitle.set(title, { id: item.id, title });
  }

  const stats: CleanupStats = {
    requested: config.titlesToDelete.length,
    found: 0,
    deleted: 0,
    notFound: 0,
    failed: 0,
  };

  for (const title of config.titlesToDelete) {
    const target = itemsByTitle.get(title);

    if (!target) {
      stats.notFound += 1;
      console.log(`[1Password Cleanup] Not found: ${title}`);
      continue;
    }

    stats.found += 1;

    if (config.simulate) {
      console.log(`[1Password Cleanup] SIMULATE delete: ${title} (id=${target.id})`);
      continue;
    }

    try {
      await client.items.delete(config.sourceVaultId, target.id);
      stats.deleted += 1;
      console.log(`[1Password Cleanup] Deleted: ${title} (id=${target.id})`);
    } catch (error) {
      stats.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[1Password Cleanup] FAILED delete ${title} (id=${target.id}): ${message}`);

      if (message.toLowerCase().includes('not sufficient permissions')) {
        throw new Error(
          [
            'Source 1Password token does not have delete permission on source vault.',
            `sourceVaultId=${config.sourceVaultId}`,
            'Grant delete permission to the service account, then rerun cleanup.',
          ].join(' ')
        );
      }
    }
  }

  return stats;
}

async function main(): Promise<void> {
  const config = readConfigFromEnv();

  console.log('[1Password Cleanup] Starting cleanup');
  console.log(`[1Password Cleanup] sourceVaultId=${config.sourceVaultId}`);
  console.log(`[1Password Cleanup] sourceTokenEnv=${config.sourceTokenName}`);
  console.log(`[1Password Cleanup] sourceVaultEnv=${config.sourceVaultName}`);
  console.log(`[1Password Cleanup] simulate=${config.simulate}`);
  console.log(`[1Password Cleanup] titles=${config.titlesToDelete.join(', ')}`);

  const stats = await cleanupOldVault(config);

  console.log('[1Password Cleanup] DONE');
  console.log(
    `[1Password Cleanup] requested=${stats.requested} found=${stats.found} deleted=${stats.deleted} notFound=${stats.notFound} failed=${stats.failed}`
  );

  if (stats.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[1Password Cleanup] Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
