/**
 * Device Tags Routes
 * API endpoints for managing device tags and querying agents by tags
 */


import { query } from '../db/connection';
import logger from '../utils/logger';
import {
  TagOperationRequest,
  BulkTagOperationRequest,
  DeviceQueryRequest,
  DeviceQueryResponse,
  DeviceTagsResponse,
  TagDefinitionRequest,
  TagDefinitionUpdateRequest,
} from '../types/device-tags';
import type { FastifyPluginAsync } from 'fastify'

type AgentUuidParams = {
  uuid: string;
};

type AgentTagParams = {
  uuid: string;
  key: string;
};

type KeyParams = {
  key: string;
};

type ReplaceTagsBody = {
  tags: Record<string, string>;
};

type AgentIdentityRow = {
  uuid: string;
  name?: string;
};

type AgentTagRow = {
  key: string;
  value: string;
};

type AgentQueryMatchRow = {
  agent_uuid: string;
};

type AgentQueryRow = {
  uuid: string;
  name: string;
  type: string;
  is_online: boolean;
  tags: Record<string, string> | null;
};

type TagDefinitionRow = {
  id: number;
  key: string;
  description: string | null;
  allowed_values: string[] | null;
  is_required: boolean;
  created_at: Date;
  created_by: number | null;
  updated_at: Date;
};

type CountRow = {
  count: string;
};

type KeyCountRow = {
  key: string;
  device_count: string;
};

type ValueCountRow = {
  value: string;
  device_count: string;
};

const plugin: FastifyPluginAsync = async (fastify) => {

const moduleLogger = logger.child({ module: 'device-tags' });

/**
 * GET /api/v1/agents/:uuid/tags
 * Get all tags for a device
 */
fastify.get<{ Params: AgentUuidParams }>('/agents/:uuid/tags', async (req, reply) => {
  try {
    const { uuid } = req.params;

    // Verify device exists
    const deviceResult = await query<AgentIdentityRow>(
      'SELECT uuid, name FROM agents WHERE uuid = $1',
      [uuid]
    );

    if (deviceResult.rows.length === 0) {
      return reply.status(404).send({
        error: 'Device not found',
        message: `Device ${uuid} not found`
      });
    }

    // Get all tags for the device
    const tagsResult = await query<AgentTagRow>(
      'SELECT key, value, created_at, created_by, updated_at FROM agent_tags WHERE agent_uuid = $1 ORDER BY key',
      [uuid]
    );

    // Convert to key-value object
    const tags: Record<string, string> = {};
    tagsResult.rows.forEach((row) => {
      tags[row.key] = row.value;
    });

    const response: DeviceTagsResponse = {
      deviceUuid: uuid,
      tags
    };

    return reply.send(response);
  } catch (error: any) {
    moduleLogger.error('Error fetching device tags', {
      error: error.message,
      stack: error.stack,
      deviceUuid: req.params.uuid
    });
    return reply.status(500).send({
      error: 'Failed to fetch device tags',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/agents/:uuid/tags
 * Add or update a single tag on a device
 */
fastify.post<{ Params: AgentUuidParams; Body: TagOperationRequest }>('/agents/:uuid/tags', async (req, reply) => {
  try {
    const { uuid } = req.params;
    const { key, value } = req.body;

    if (!key || !value) {
      return reply.status(400).send({
        error: 'Invalid request',
        message: 'Both key and value are required'
      });
    }

    // Verify device exists
    const deviceResult = await query<AgentIdentityRow>(
      'SELECT uuid FROM agents WHERE uuid = $1',
      [uuid]
    );

    if (deviceResult.rows.length === 0) {
      return reply.status(404).send({
        error: 'Device not found',
        message: `Device ${uuid} not found`
      });
    }

    // Insert or update tag (upsert)
    await query(
      `INSERT INTO agent_tags (agent_uuid, key, value, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (agent_uuid, key)
       DO UPDATE SET value = $3, updated_at = NOW()`,
      [uuid, key, value]
    );

    moduleLogger.info('Device tag added/updated', {
      deviceUuid: uuid,
      key,
      value
    });

    return reply.send({
      success: true,
      message: 'Tag added/updated successfully',
      tag: { key, value }
    });
  } catch (error: any) {
    moduleLogger.error('Error adding/updating device tag', {
      error: error.message,
      stack: error.stack,
      deviceUuid: req.params.uuid,
      key: req.body.key
    });
    return reply.status(500).send({
      error: 'Failed to add/update tag',
      message: error.message
    });
  }
});

/**
 * PUT /api/v1/agents/:uuid/tags
 * Replace all tags on a device (bulk update)
 */
fastify.put<{ Params: AgentUuidParams; Body: ReplaceTagsBody }>('/agents/:uuid/tags', async (req, reply) => {
  try {
    const { uuid } = req.params;
    const { tags } = req.body;

    if (!tags || typeof tags !== 'object') {
      return reply.status(400).send({
        error: 'Invalid request',
        message: 'Tags object is required'
      });
    }

    // Verify device exists
    const deviceResult = await query<AgentIdentityRow>(
      'SELECT uuid FROM agents WHERE uuid = $1',
      [uuid]
    );

    if (deviceResult.rows.length === 0) {
      return reply.status(404).send({
        error: 'Device not found',
        message: `Device ${uuid} not found`
      });
    }

    // Start transaction
    await query('BEGIN');

    try {
      // Delete all existing tags for the device
      await query('DELETE FROM agent_tags WHERE agent_uuid = $1', [uuid]);

      // Insert new tags
      const tagEntries = Object.entries(tags);
      for (const [key, value] of tagEntries) {
        await query(
          `INSERT INTO agent_tags (agent_uuid, key, value, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())`,
          [uuid, key, value]
        );
      }

      await query('COMMIT');

      moduleLogger.info('Device tags replaced', {
        deviceUuid: uuid,
        tagCount: tagEntries.length
      });

      return reply.send({
        success: true,
        message: 'Tags replaced successfully',
        tags
      });
    } catch (error) {
      await query('ROLLBACK');
      throw error;
    }
  } catch (error: any) {
    moduleLogger.error('Error replacing device tags', {
      error: error.message,
      stack: error.stack,
      deviceUuid: req.params.uuid
    });
    return reply.status(500).send({
      error: 'Failed to replace tags',
      message: error.message
    });
  }
});

/**
 * DELETE /api/v1/agents/:uuid/tags/:key
 * Delete a specific tag from a device
 */
fastify.delete<{ Params: AgentTagParams }>('/agents/:uuid/tags/:key', async (req, reply) => {
  try {
    const { uuid, key } = req.params;

    const result = await query<{ key: string }>(
      'DELETE FROM agent_tags WHERE agent_uuid = $1 AND key = $2 RETURNING key',
      [uuid, key]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Tag not found',
        message: `Tag '${key}' not found on device ${uuid}`
      });
    }

    moduleLogger.info('Device tag deleted', {
      deviceUuid: uuid,
      key
    });

    return reply.send({
      success: true,
      message: 'Tag deleted successfully',
      key
    });
  } catch (error: any) {
    moduleLogger.error('Error deleting device tag', {
      error: error.message,
      stack: error.stack,
      deviceUuid: req.params.uuid,
      key: req.params.key
    });
    return reply.status(500).send({
      error: 'Failed to delete tag',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/agents/query
 * Query agents by tag selectors
 */
fastify.post<{ Body: DeviceQueryRequest }>('/agents/query', async (req, reply) => {
  try {
    const { tagSelectors } = req.body;

    if (!tagSelectors || typeof tagSelectors !== 'object') {
      return reply.status(400).send({
        error: 'Invalid request',
        message: 'tagSelectors object is required'
      });
    }

    // Use the database function to find agents
    const result = await query<AgentQueryMatchRow>(
      'SELECT * FROM find_agents_by_tags($1::jsonb)',
      [JSON.stringify(tagSelectors)]
    );

    const deviceUuids = result.rows.map((row) => row.agent_uuid);

    // If no agents found, return empty result
    if (deviceUuids.length === 0) {
      const response: DeviceQueryResponse = {
        count: 0,
        agents: []
      };
      return reply.send(response);
    }

    // Fetch device details and their tags
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
      tags: row.tags || {}
    }));

    const response: DeviceQueryResponse = {
      count: agents.length,
      agents
    };

    moduleLogger.info('Device query executed', {
      tagSelectors,
      matchCount: agents.length
    });

    return reply.send(response);
  } catch (error: any) {
    moduleLogger.error('Error querying agents by tags', {
      error: error.message,
      stack: error.stack,
      tagSelectors: req.body.tagSelectors
    });
    return reply.status(500).send({
      error: 'Failed to query agents',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/agents/tags/bulk
 * Apply tags to multiple agents at once
 */
fastify.post<{ Body: BulkTagOperationRequest }>('/agents/tags/bulk', async (req, reply) => {
  try {
    const { deviceUuids, tags } = req.body;

    if (!deviceUuids || !Array.isArray(deviceUuids) || deviceUuids.length === 0) {
      return reply.status(400).send({
        error: 'Invalid request',
        message: 'deviceUuids array is required and must not be empty'
      });
    }

    if (!tags || typeof tags !== 'object' || Object.keys(tags).length === 0) {
      return reply.status(400).send({
        error: 'Invalid request',
        message: 'tags object is required and must not be empty'
      });
    }

    // Verify all agents exist
    const agentsResult = await query<{ uuid: string }>(
      'SELECT uuid FROM agents WHERE uuid = ANY($1::uuid[])',
      [deviceUuids]
    );

    const existingUuids = agentsResult.rows.map((row) => row.uuid);
    const missingUuids = deviceUuids.filter((uuid) => !existingUuids.includes(uuid));

    if (missingUuids.length > 0) {
      return reply.status(404).send({
        error: 'Devices not found',
        message: `The following device UUIDs were not found: ${missingUuids.join(', ')}`
      });
    }

    // Start transaction
    await query('BEGIN');

    try {
      const tagEntries = Object.entries(tags);
      let totalTagsApplied = 0;

      for (const deviceUuid of existingUuids) {
        for (const [key, value] of tagEntries) {
          await query(
            `INSERT INTO agent_tags (agent_uuid, key, value, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())
             ON CONFLICT (agent_uuid, key)
             DO UPDATE SET value = $3, updated_at = NOW()`,
            [deviceUuid, key, value]
          );
          totalTagsApplied++;
        }
      }

      await query('COMMIT');

      moduleLogger.info('Bulk tags applied', {
        deviceCount: existingUuids.length,
        tagCount: tagEntries.length,
        totalTagsApplied
      });

      return reply.send({
        success: true,
        message: 'Tags applied to all agents successfully',
        agentsUpdated: existingUuids.length,
        tagsApplied: tagEntries.length,
        totalOperations: totalTagsApplied
      });
    } catch (error) {
      await query('ROLLBACK');
      throw error;
    }
  } catch (error: any) {
    moduleLogger.error('Error applying bulk tags', {
      error: error.message,
      stack: error.stack
    });
    return reply.status(500).send({
      error: 'Failed to apply bulk tags',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/tags/definitions
 * Get all tag definitions
 */
fastify.get('/tags/definitions', async (_req, reply) => {
  try {
    const result = await query<TagDefinitionRow>(
      `SELECT id, key, description, allowed_values, is_required, created_at, created_by, updated_at
       FROM tag_definitions
       ORDER BY key`
    );

    const definitions = result.rows.map((row) => ({
      id: row.id,
      key: row.key,
      description: row.description,
      allowedValues: row.allowed_values,
      isRequired: row.is_required,
      createdAt: row.created_at,
      createdBy: row.created_by,
      updatedAt: row.updated_at
    }));

    return reply.send({
      count: definitions.length,
      definitions
    });
  } catch (error: any) {
    moduleLogger.error('Error fetching tag definitions', {
      error: error.message,
      stack: error.stack
    });
    return reply.status(500).send({
      error: 'Failed to fetch tag definitions',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/tags/definitions
 * Create a new tag definition
 */
fastify.post<{ Body: TagDefinitionRequest }>('/tags/definitions', async (req, reply) => {
  try {
    const { key, description, allowedValues, isRequired } = req.body;

    // Validate required fields
    if (!key) {
      return reply.status(400).send({
        error: 'Missing required field: key'
      });
    }

    // Validate key format
    const keyRegex = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/;
    if (!keyRegex.test(key)) {
      return reply.status(400).send({
        error: 'Invalid tag key format',
        message: 'Key must be lowercase alphanumeric with dashes/underscores'
      });
    }

    const result = await query<TagDefinitionRow>(
      `INSERT INTO tag_definitions (key, description, allowed_values, is_required)
       VALUES ($1, $2, $3, $4)
       RETURNING id, key, description, allowed_values, is_required, created_at, updated_at`,
      [key, description || null, allowedValues || null, isRequired || false]
    );

    const definition = result.rows[0];

    moduleLogger.info('Tag definition created', {
      key,
      description,
      allowedValues
    });

    return reply.status(201).send({
      success: true,
      definition: {
        id: definition.id,
        key: definition.key,
        description: definition.description,
        allowedValues: definition.allowed_values,
        isRequired: definition.is_required,
        createdAt: definition.created_at,
        updatedAt: definition.updated_at
      }
    });
  } catch (error: any) {
    if (error.code === '23505') { // Unique violation
      return reply.status(409).send({
        error: 'Tag definition already exists',
        message: `A tag definition with key '${req.body.key}' already exists`
      });
    }

    moduleLogger.error('Error creating tag definition', {
      error: error.message,
      stack: error.stack
    });
    return reply.status(500).send({
      error: 'Failed to create tag definition',
      message: error.message
    });
  }
});

/**
 * PUT /api/v1/tags/definitions/:key
 * Update an existing tag definition
 */
fastify.put<{ Params: KeyParams; Body: TagDefinitionUpdateRequest }>('/tags/definitions/:key', async (req, reply) => {
  try {
    const { key } = req.params;
    const { description, allowedValues, isRequired } = req.body;

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

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Tag definition not found',
        message: `Tag definition with key '${key}' not found`
      });
    }

    const definition = result.rows[0];

    moduleLogger.info('Tag definition updated', {
      key,
      changes: { description, allowedValues, isRequired }
    });

    return reply.send({
      success: true,
      definition: {
        id: definition.id,
        key: definition.key,
        description: definition.description,
        allowedValues: definition.allowed_values,
        isRequired: definition.is_required,
        createdAt: definition.created_at,
        updatedAt: definition.updated_at
      }
    });
  } catch (error: any) {
    moduleLogger.error('Error updating tag definition', {
      error: error.message,
      stack: error.stack,
      key: req.params.key
    });
    return reply.status(500).send({
      error: 'Failed to update tag definition',
      message: error.message
    });
  }
});

/**
 * DELETE /api/v1/tags/definitions/:key
 * Delete a tag definition
 */
fastify.delete<{ Params: KeyParams }>('/tags/definitions/:key', async (req, reply) => {
  try {
    const { key } = req.params;

    // Check if tag is in use
    const usageCheck = await query<CountRow>(
      'SELECT COUNT(*) as count FROM agent_tags WHERE key = $1',
      [key]
    );

    const inUseCount = Number.parseInt(usageCheck.rows[0].count, 10);
    if (inUseCount > 0) {
      return reply.status(409).send({
        error: 'Tag definition in use',
        message: `Cannot delete tag definition '${key}' as it is used by ${inUseCount} device(s)`,
        agentsAffected: inUseCount
      });
    }

    const result = await query<{ key: string }>(
      'DELETE FROM tag_definitions WHERE key = $1 RETURNING key',
      [key]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Tag definition not found',
        message: `Tag definition with key '${key}' not found`
      });
    }

    moduleLogger.info('Tag definition deleted', {
      key
    });

    return reply.send({
      success: true,
      message: 'Tag definition deleted successfully',
      key
    });
  } catch (error: any) {
    moduleLogger.error('Error deleting tag definition', {
      error: error.message,
      stack: error.stack,
      key: req.params.key
    });
    return reply.status(500).send({
      error: 'Failed to delete tag definition',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/tags/keys
 * Get all unique tag keys in use
 */
fastify.get('/tags/keys', async (_req, reply) => {
  try {
    const result = await query<KeyCountRow>(
      `SELECT DISTINCT key, COUNT(*) as device_count
       FROM agent_tags
       GROUP BY key
       ORDER BY key`
    );

    const keys = result.rows.map((row) => ({
      key: row.key,
      deviceCount: Number.parseInt(row.device_count, 10)
    }));

    return reply.send({
      count: keys.length,
      keys
    });
  } catch (error: any) {
    moduleLogger.error('Error fetching tag keys', {
      error: error.message,
      stack: error.stack
    });
    return reply.status(500).send({
      error: 'Failed to fetch tag keys',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/tags/values/:key
 * Get all unique values for a specific tag key
 */
fastify.get<{ Params: KeyParams }>('/tags/values/:key', async (req, reply) => {
  try {
    const { key } = req.params;

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
      deviceCount: Number.parseInt(row.device_count, 10)
    }));

    return reply.send({
      key,
      count: values.length,
      values
    });
  } catch (error: any) {
    moduleLogger.error('Error fetching tag values', {
      error: error.message,
      stack: error.stack,
      key: req.params.key
    });
    return reply.status(500).send({
      error: 'Failed to fetch tag values',
      message: error.message
    });
  }
});
};

export default plugin;
