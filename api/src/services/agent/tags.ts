import { query, transaction } from '../../db/connection';
import { logger } from '../../utils/logger';
import type {
  DeviceTagsResponse,
  DeviceQueryResponse,
} from '../../types/device-tags';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface AgentIdentityRow {
  uuid: string;
  name?: string;
}

interface AgentTagRow {
  key: string;
  value: string;
  created_at: Date;
  created_by: number | null;
  updated_at: Date;
}

interface AgentQueryMatchRow {
  agent_uuid: string;
}

interface AgentQueryRow {
  uuid: string;
  name: string;
  type: string;
  is_online: boolean;
  tags: Record<string, string> | null;
}

interface TagDefinitionRow {
  id: number;
  key: string;
  description: string | null;
  allowed_values: string[] | null;
  is_required: boolean;
  created_at: Date;
  created_by: number | null;
  updated_at: Date;
}

interface KeyCountRow {
  key: string;
  device_count: string;
}

interface ValueCountRow {
  value: string;
  device_count: string;
}

const log = logger.child({ module: 'device-tags' });

// ---------------------------------------------------------------------------
// Agent tag operations
// ---------------------------------------------------------------------------

export async function getAgentTags(uuid: string): Promise<DeviceTagsResponse | null> {
  const deviceResult = await query<AgentIdentityRow>(
    'SELECT uuid, name FROM agents WHERE uuid = $1',
    [uuid]
  );
  if (deviceResult.rows.length === 0) return null;

  const tagsResult = await query<AgentTagRow>(
    'SELECT key, value, created_at, created_by, updated_at FROM agent_tags WHERE agent_uuid = $1 ORDER BY key',
    [uuid]
  );

  const tags: Record<string, string> = {};
  for (const row of tagsResult.rows) {
    tags[row.key] = row.value;
  }

  return { deviceUuid: uuid, tags };
}

export async function upsertAgentTag(
  uuid: string,
  key: string,
  value: string
): Promise<{ found: boolean }> {
  const deviceResult = await query<{ uuid: string }>(
    'SELECT uuid FROM agents WHERE uuid = $1',
    [uuid]
  );
  if (deviceResult.rows.length === 0) return { found: false };

  await query(
    `INSERT INTO agent_tags (agent_uuid, key, value, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (agent_uuid, key)
     DO UPDATE SET value = $3, updated_at = NOW()`,
    [uuid, key, value]
  );

  log.info('Device tag added/updated', { deviceUuid: uuid, key, value });
  return { found: true };
}

export async function replaceAgentTags(
  uuid: string,
  tags: Record<string, string>
): Promise<{ found: boolean }> {
  const deviceResult = await query<{ uuid: string }>(
    'SELECT uuid FROM agents WHERE uuid = $1',
    [uuid]
  );
  if (deviceResult.rows.length === 0) return { found: false };

  const tagEntries = Object.entries(tags);

  await transaction(async (client) => {
    await client.query('DELETE FROM agent_tags WHERE agent_uuid = $1', [uuid]);
    for (const [k, v] of tagEntries) {
      await client.query(
        `INSERT INTO agent_tags (agent_uuid, key, value, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [uuid, k, v]
      );
    }
  });

  log.info('Device tags replaced', { deviceUuid: uuid, tagCount: tagEntries.length });
  return { found: true };
}

export async function deleteAgentTag(
  uuid: string,
  key: string
): Promise<{ found: boolean }> {
  const result = await query<{ key: string }>(
    'DELETE FROM agent_tags WHERE agent_uuid = $1 AND key = $2 RETURNING key',
    [uuid, key]
  );

  if (result.rows.length === 0) return { found: false };

  log.info('Device tag deleted', { deviceUuid: uuid, key });
  return { found: true };
}

// ---------------------------------------------------------------------------
// Query agents by tag selectors
// ---------------------------------------------------------------------------

export async function queryAgentsByTags(
  tagSelectors: Record<string, string>
): Promise<DeviceQueryResponse> {
  const result = await query<AgentQueryMatchRow>(
    'SELECT * FROM find_agents_by_tags($1::jsonb)',
    [JSON.stringify(tagSelectors)]
  );

  const deviceUuids = result.rows.map((row) => row.agent_uuid);

  if (deviceUuids.length === 0) {
    return { count: 0, agents: [] };
  }

  const agentsResult = await query<AgentQueryRow>(
    `SELECT d.uuid, d.name, d.type, d.is_online,
            jsonb_object_agg(dt.key, dt.value) FILTER (WHERE dt.key IS NOT NULL) as tags
     FROM agents d
     LEFT JOIN agent_tags dt ON d.uuid = dt.agent_uuid
     WHERE d.uuid = ANY($1::uuid[])
     GROUP BY d.uuid, d.name, d.type, d.is_online`,
    [deviceUuids]
  );

  const agents = agentsResult.rows.map((row) => ({
    uuid: row.uuid,
    deviceName: row.name,
    deviceType: row.type,
    isOnline: row.is_online,
    tags: row.tags || {},
  }));

  log.info('Device query executed', { tagSelectors, matchCount: agents.length });
  return { count: agents.length, agents };
}

// ---------------------------------------------------------------------------
// Bulk tag operations
// ---------------------------------------------------------------------------

export async function bulkApplyTags(
  deviceUuids: string[],
  tags: Record<string, string>
): Promise<{ missingUuids: string[]; agentsUpdated: number; tagsApplied: number; totalOperations: number }> {
  const agentsResult = await query<{ uuid: string }>(
    'SELECT uuid FROM agents WHERE uuid = ANY($1::uuid[])',
    [deviceUuids]
  );

  const existingUuids = agentsResult.rows.map((row) => row.uuid);
  const missingUuids = deviceUuids.filter((uuid) => !existingUuids.includes(uuid));

  if (missingUuids.length > 0) {
    return { missingUuids, agentsUpdated: 0, tagsApplied: 0, totalOperations: 0 };
  }

  const tagEntries = Object.entries(tags);
  let totalOperations = 0;

  await transaction(async (client) => {
    for (const deviceUuid of existingUuids) {
      for (const [k, v] of tagEntries) {
        await client.query(
          `INSERT INTO agent_tags (agent_uuid, key, value, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (agent_uuid, key)
           DO UPDATE SET value = $3, updated_at = NOW()`,
          [deviceUuid, k, v]
        );
        totalOperations++;
      }
    }
  });

  log.info('Bulk tags applied', {
    deviceCount: existingUuids.length,
    tagCount: tagEntries.length,
    totalOperations,
  });

  return {
    missingUuids: [],
    agentsUpdated: existingUuids.length,
    tagsApplied: tagEntries.length,
    totalOperations,
  };
}

// ---------------------------------------------------------------------------
// Tag definitions
// ---------------------------------------------------------------------------

function mapDefinitionRow(row: TagDefinitionRow) {
  return {
    id: row.id,
    key: row.key,
    description: row.description,
    allowedValues: row.allowed_values,
    isRequired: row.is_required,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
  };
}

export async function getDefinitions() {
  const result = await query<TagDefinitionRow>(
    `SELECT id, key, description, allowed_values, is_required, created_at, created_by, updated_at
     FROM tag_definitions
     ORDER BY key`
  );
  return { count: result.rows.length, definitions: result.rows.map(mapDefinitionRow) };
}

export async function createDefinition(params: {
  key: string;
  description?: string;
  allowedValues?: string[];
  isRequired?: boolean;
}) {
  const { key, description, allowedValues, isRequired } = params;

  const result = await query<TagDefinitionRow>(
    `INSERT INTO tag_definitions (key, description, allowed_values, is_required)
     VALUES ($1, $2, $3, $4)
     RETURNING id, key, description, allowed_values, is_required, created_at, updated_at`,
    [key, description ?? null, allowedValues ?? null, isRequired ?? false]
  );

  log.info('Tag definition created', { key, description, allowedValues });
  return mapDefinitionRow(result.rows[0]);
}

export async function updateDefinition(
  key: string,
  params: { description?: string; allowedValues?: string[]; isRequired?: boolean }
): Promise<ReturnType<typeof mapDefinitionRow> | null> {
  const { description, allowedValues, isRequired } = params;

  const result = await query<TagDefinitionRow>(
    `UPDATE tag_definitions
     SET description = COALESCE($2, description),
         allowed_values = COALESCE($3, allowed_values),
         is_required = COALESCE($4, is_required),
         updated_at = CURRENT_TIMESTAMP
     WHERE key = $1
     RETURNING id, key, description, allowed_values, is_required, created_at, updated_at`,
    [key, description, allowedValues, isRequired]
  );

  if (result.rows.length === 0) return null;

  log.info('Tag definition updated', { key, changes: params });
  return mapDefinitionRow(result.rows[0]);
}

export async function deleteDefinition(
  key: string
): Promise<{ inUseCount: number; deleted: boolean }> {
  const usageCheck = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM agent_tags WHERE key = $1',
    [key]
  );

  const inUseCount = Number.parseInt(usageCheck.rows[0].count, 10);
  if (inUseCount > 0) return { inUseCount, deleted: false };

  const result = await query<{ key: string }>(
    'DELETE FROM tag_definitions WHERE key = $1 RETURNING key',
    [key]
  );

  if (result.rows.length === 0) return { inUseCount: 0, deleted: false };

  log.info('Tag definition deleted', { key });
  return { inUseCount: 0, deleted: true };
}

// ---------------------------------------------------------------------------
// Tag key / value discovery
// ---------------------------------------------------------------------------

export async function getTagKeys() {
  const result = await query<KeyCountRow>(
    `SELECT DISTINCT key, COUNT(*) as device_count
     FROM agent_tags
     GROUP BY key
     ORDER BY key`
  );

  const keys = result.rows.map((row) => ({
    key: row.key,
    deviceCount: Number.parseInt(row.device_count, 10),
  }));

  return { count: keys.length, keys };
}

export async function getTagValues(key: string) {
  const result = await query<ValueCountRow>(
    `SELECT DISTINCT value, COUNT(*) as device_count
     FROM agent_tags
     WHERE key = $1
     GROUP BY value
     ORDER BY value`,
    [key]
  );

  const values = result.rows.map((row) => ({
    value: row.value,
    deviceCount: Number.parseInt(row.device_count, 10),
  }));

  return { key, count: values.length, values };
}
