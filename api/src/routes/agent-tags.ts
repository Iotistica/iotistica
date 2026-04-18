/**
 * Device Tags Routes
 * API endpoints for managing device tags and querying agents by tags
 */

import type { FastifyPluginAsync } from 'fastify';
import logger from '../utils/logger';
import type {
  TagOperationRequest,
  BulkTagOperationRequest,
  DeviceQueryRequest,
  TagDefinitionRequest,
  TagDefinitionUpdateRequest,
} from '../types/device-tags';
import * as TagsService from '../services/agent/tags';

type AgentUuidParams = { uuid: string };
type AgentTagParams = { uuid: string; key: string };
type KeyParams = { key: string };
type ReplaceTagsBody = { tags: Record<string, string> };

const moduleLogger = logger.child({ module: 'device-tags' });

const plugin: FastifyPluginAsync = async (fastify) => {

  fastify.get<{ Params: AgentUuidParams }>('/agents/:uuid/tags', async (req, reply) => {
    try {
      const result = await TagsService.getAgentTags(req.params.uuid);
      if (!result) return reply.status(404).send({ error: 'Device not found', message: `Device ${req.params.uuid} not found` });
      return reply.send(result);
    } catch (error: unknown) {
      moduleLogger.error('Error fetching device tags', { error: (error as Error).message, deviceUuid: req.params.uuid });
      return reply.status(500).send({ error: 'Failed to fetch device tags', message: (error as Error).message });
    }
  });

  fastify.post<{ Params: AgentUuidParams; Body: TagOperationRequest }>('/agents/:uuid/tags', async (req, reply) => {
    try {
      const { key, value } = req.body;
      if (!key || !value) return reply.status(400).send({ error: 'Invalid request', message: 'Both key and value are required' });

      const { found } = await TagsService.upsertAgentTag(req.params.uuid, key, value);
      if (!found) return reply.status(404).send({ error: 'Device not found', message: `Device ${req.params.uuid} not found` });

      return reply.send({ success: true, message: 'Tag added/updated successfully', tag: { key, value } });
    } catch (error: unknown) {
      moduleLogger.error('Error adding/updating device tag', { error: (error as Error).message, deviceUuid: req.params.uuid, key: req.body.key });
      return reply.status(500).send({ error: 'Failed to add/update tag', message: (error as Error).message });
    }
  });

  fastify.put<{ Params: AgentUuidParams; Body: ReplaceTagsBody }>('/agents/:uuid/tags', async (req, reply) => {
    try {
      const { tags } = req.body;
      if (!tags || typeof tags !== 'object') return reply.status(400).send({ error: 'Invalid request', message: 'Tags object is required' });

      const { found } = await TagsService.replaceAgentTags(req.params.uuid, tags);
      if (!found) return reply.status(404).send({ error: 'Device not found', message: `Device ${req.params.uuid} not found` });

      return reply.send({ success: true, message: 'Tags replaced successfully', tags });
    } catch (error: unknown) {
      moduleLogger.error('Error replacing device tags', { error: (error as Error).message, deviceUuid: req.params.uuid });
      return reply.status(500).send({ error: 'Failed to replace tags', message: (error as Error).message });
    }
  });

  fastify.delete<{ Params: AgentTagParams }>('/agents/:uuid/tags/:key', async (req, reply) => {
    try {
      const { uuid, key } = req.params;
      const { found } = await TagsService.deleteAgentTag(uuid, key);
      if (!found) return reply.status(404).send({ error: 'Tag not found', message: `Tag '${key}' not found on device ${uuid}` });

      return reply.send({ success: true, message: 'Tag deleted successfully', key });
    } catch (error: unknown) {
      moduleLogger.error('Error deleting device tag', { error: (error as Error).message, deviceUuid: req.params.uuid, key: req.params.key });
      return reply.status(500).send({ error: 'Failed to delete tag', message: (error as Error).message });
    }
  });

  fastify.post<{ Body: DeviceQueryRequest }>('/agents/query', async (req, reply) => {
    try {
      const { tagSelectors } = req.body;
      if (!tagSelectors || typeof tagSelectors !== 'object') return reply.status(400).send({ error: 'Invalid request', message: 'tagSelectors object is required' });

      return reply.send(await TagsService.queryAgentsByTags(tagSelectors as Record<string, string>));
    } catch (error: unknown) {
      moduleLogger.error('Error querying agents by tags', { error: (error as Error).message, tagSelectors: req.body.tagSelectors });
      return reply.status(500).send({ error: 'Failed to query agents', message: (error as Error).message });
    }
  });

  fastify.post<{ Body: BulkTagOperationRequest }>('/agents/tags/bulk', async (req, reply) => {
    try {
      const { deviceUuids, tags } = req.body;
      if (!deviceUuids || !Array.isArray(deviceUuids) || deviceUuids.length === 0) {
        return reply.status(400).send({ error: 'Invalid request', message: 'deviceUuids array is required and must not be empty' });
      }
      if (!tags || typeof tags !== 'object' || Object.keys(tags).length === 0) {
        return reply.status(400).send({ error: 'Invalid request', message: 'tags object is required and must not be empty' });
      }

      const result = await TagsService.bulkApplyTags(deviceUuids, tags as Record<string, string>);
      if (result.missingUuids.length > 0) {
        return reply.status(404).send({ error: 'Devices not found', message: `The following device UUIDs were not found: ${result.missingUuids.join(', ')}` });
      }

      return reply.send({
        success: true,
        message: 'Tags applied to all agents successfully',
        agentsUpdated: result.agentsUpdated,
        tagsApplied: result.tagsApplied,
        totalOperations: result.totalOperations,
      });
    } catch (error: unknown) {
      moduleLogger.error('Error applying bulk tags', { error: (error as Error).message });
      return reply.status(500).send({ error: 'Failed to apply bulk tags', message: (error as Error).message });
    }
  });

  fastify.get('/tags/definitions', async (_req, reply) => {
    try {
      return reply.send(await TagsService.getDefinitions());
    } catch (error: unknown) {
      moduleLogger.error('Error fetching tag definitions', { error: (error as Error).message });
      return reply.status(500).send({ error: 'Failed to fetch tag definitions', message: (error as Error).message });
    }
  });

  fastify.post<{ Body: TagDefinitionRequest }>('/tags/definitions', async (req, reply) => {
    try {
      const { key } = req.body;
      if (!key) return reply.status(400).send({ error: 'Missing required field: key' });

      const keyRegex = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/;
      if (!keyRegex.test(key)) {
        return reply.status(400).send({ error: 'Invalid tag key format', message: 'Key must be lowercase alphanumeric with dashes/underscores' });
      }

      const definition = await TagsService.createDefinition(req.body as Parameters<typeof TagsService.createDefinition>[0]);
      return reply.status(201).send({ success: true, definition });
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === '23505') {
        return reply.status(409).send({ error: 'Tag definition already exists', message: `A tag definition with key '${req.body.key}' already exists` });
      }
      moduleLogger.error('Error creating tag definition', { error: (error as Error).message });
      return reply.status(500).send({ error: 'Failed to create tag definition', message: (error as Error).message });
    }
  });

  fastify.put<{ Params: KeyParams; Body: TagDefinitionUpdateRequest }>('/tags/definitions/:key', async (req, reply) => {
    try {
      const definition = await TagsService.updateDefinition(req.params.key, req.body as Parameters<typeof TagsService.updateDefinition>[1]);
      if (!definition) return reply.status(404).send({ error: 'Tag definition not found', message: `Tag definition with key '${req.params.key}' not found` });

      return reply.send({ success: true, definition });
    } catch (error: unknown) {
      moduleLogger.error('Error updating tag definition', { error: (error as Error).message, key: req.params.key });
      return reply.status(500).send({ error: 'Failed to update tag definition', message: (error as Error).message });
    }
  });

  fastify.delete<{ Params: KeyParams }>('/tags/definitions/:key', async (req, reply) => {
    try {
      const { key } = req.params;
      const result = await TagsService.deleteDefinition(key);

      if (!result.deleted && result.inUseCount > 0) {
        return reply.status(409).send({ error: 'Tag definition in use', message: `Cannot delete tag definition '${key}' as it is used by ${result.inUseCount} device(s)`, agentsAffected: result.inUseCount });
      }
      if (!result.deleted) return reply.status(404).send({ error: 'Tag definition not found', message: `Tag definition with key '${key}' not found` });

      return reply.send({ success: true, message: 'Tag definition deleted successfully', key });
    } catch (error: unknown) {
      moduleLogger.error('Error deleting tag definition', { error: (error as Error).message, key: req.params.key });
      return reply.status(500).send({ error: 'Failed to delete tag definition', message: (error as Error).message });
    }
  });

  fastify.get('/tags/keys', async (_req, reply) => {
    try {
      return reply.send(await TagsService.getTagKeys());
    } catch (error: unknown) {
      moduleLogger.error('Error fetching tag keys', { error: (error as Error).message });
      return reply.status(500).send({ error: 'Failed to fetch tag keys', message: (error as Error).message });
    }
  });

  fastify.get<{ Params: KeyParams }>('/tags/values/:key', async (req, reply) => {
    try {
      return reply.send(await TagsService.getTagValues(req.params.key));
    } catch (error: unknown) {
      moduleLogger.error('Error fetching tag values', { error: (error as Error).message, key: req.params.key });
      return reply.status(500).send({ error: 'Failed to fetch tag values', message: (error as Error).message });
    }
  });
};

export default plugin;
