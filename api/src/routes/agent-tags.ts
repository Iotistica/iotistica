/**
 * Device Tags Routes
 * API endpoints for managing device tags and querying devices by tags
 */

import express from 'express';
import { query } from '../db/connection';
import logger from '../utils/logger';
import {
  TagOperationRequest,
  BulkTagOperationRequest,
  DeviceQueryRequest,
  DeviceQueryResponse,
  DeviceTagsResponse
} from '../types/device-tags';

const moduleLogger = logger.child({ module: 'device-tags' });

export const router = express.Router();

/**
 * GET /api/v1/devices/:uuid/tags
 * Get all tags for a device
 */
router.get('/devices/:uuid/tags', async (req, res) => {
  try {
    const { uuid } = req.params;

    // Verify device exists
    const deviceResult = await query(
      'SELECT uuid, device_name FROM devices WHERE uuid = $1',
      [uuid]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Device not found',
        message: `Device ${uuid} not found`
      });
    }

    // Get all tags for the device
    const tagsResult = await query(
      'SELECT key, value, created_at, created_by, updated_at FROM device_tags WHERE device_uuid = $1 ORDER BY key',
      [uuid]
    );

    // Convert to key-value object
    const tags: Record<string, string> = {};
    tagsResult.rows.forEach(row => {
      tags[row.key] = row.value;
    });

    const response: DeviceTagsResponse = {
      deviceUuid: uuid,
      tags
    };

    res.json(response);
  } catch (error: any) {
    moduleLogger.error('Error fetching device tags', {
      error: error.message,
      stack: error.stack,
      deviceUuid: req.params.uuid
    });
    res.status(500).json({
      error: 'Failed to fetch device tags',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/devices/:uuid/tags
 * Add or update a single tag on a device
 */
router.post('/devices/:uuid/tags', async (req, res) => {
  try {
    const { uuid } = req.params;
    const { key, value } = req.body as TagOperationRequest;

    if (!key || !value) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Both key and value are required'
      });
    }

    // Verify device exists
    const deviceResult = await query(
      'SELECT uuid FROM devices WHERE uuid = $1',
      [uuid]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Device not found',
        message: `Device ${uuid} not found`
      });
    }

    // Insert or update tag (upsert)
    await query(
      `INSERT INTO device_tags (device_uuid, key, value, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (device_uuid, key)
       DO UPDATE SET value = $3, updated_at = NOW()`,
      [uuid, key, value]
    );

    moduleLogger.info('Device tag added/updated', {
      deviceUuid: uuid,
      key,
      value
    });

    res.json({
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
    res.status(500).json({
      error: 'Failed to add/update tag',
      message: error.message
    });
  }
});

/**
 * PUT /api/v1/devices/:uuid/tags
 * Replace all tags on a device (bulk update)
 */
router.put('/devices/:uuid/tags', async (req, res) => {
  try {
    const { uuid } = req.params;
    const { tags } = req.body as { tags: Record<string, string> };

    if (!tags || typeof tags !== 'object') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Tags object is required'
      });
    }

    // Verify device exists
    const deviceResult = await query(
      'SELECT uuid FROM devices WHERE uuid = $1',
      [uuid]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Device not found',
        message: `Device ${uuid} not found`
      });
    }

    // Start transaction
    await query('BEGIN');

    try {
      // Delete all existing tags for the device
      await query('DELETE FROM device_tags WHERE device_uuid = $1', [uuid]);

      // Insert new tags
      const tagEntries = Object.entries(tags);
      for (const [key, value] of tagEntries) {
        await query(
          `INSERT INTO device_tags (device_uuid, key, value, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())`,
          [uuid, key, value]
        );
      }

      await query('COMMIT');

      moduleLogger.info('Device tags replaced', {
        deviceUuid: uuid,
        tagCount: tagEntries.length
      });

      res.json({
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
    res.status(500).json({
      error: 'Failed to replace tags',
      message: error.message
    });
  }
});

/**
 * DELETE /api/v1/devices/:uuid/tags/:key
 * Delete a specific tag from a device
 */
router.delete('/devices/:uuid/tags/:key', async (req, res) => {
  try {
    const { uuid, key } = req.params;

    const result = await query(
      'DELETE FROM device_tags WHERE device_uuid = $1 AND key = $2 RETURNING key',
      [uuid, key]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Tag not found',
        message: `Tag '${key}' not found on device ${uuid}`
      });
    }

    moduleLogger.info('Device tag deleted', {
      deviceUuid: uuid,
      key
    });

    res.json({
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
    res.status(500).json({
      error: 'Failed to delete tag',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/devices/query
 * Query devices by tag selectors
 */
router.post('/devices/query', async (req, res) => {
  try {
    const { tagSelectors } = req.body as DeviceQueryRequest;

    if (!tagSelectors || typeof tagSelectors !== 'object') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'tagSelectors object is required'
      });
    }

    // Use the database function to find devices
    const result = await query(
      'SELECT * FROM find_devices_by_tags($1::jsonb)',
      [JSON.stringify(tagSelectors)]
    );

    const deviceUuids = result.rows.map(row => row.device_uuid);

    // If no devices found, return empty result
    if (deviceUuids.length === 0) {
      const response: DeviceQueryResponse = {
        count: 0,
        devices: []
      };
      return res.json(response);
    }

    // Fetch device details and their tags
    const devicesResult = await query(
      `SELECT d.uuid, d.device_name, d.device_type, d.is_online,
              jsonb_object_agg(dt.key, dt.value) FILTER (WHERE dt.key IS NOT NULL) as tags
       FROM devices d
       LEFT JOIN device_tags dt ON d.uuid = dt.device_uuid
       WHERE d.uuid = ANY($1::uuid[])
       GROUP BY d.uuid, d.device_name, d.device_type, d.is_online`,
      [deviceUuids]
    );

    const devices = devicesResult.rows.map(row => ({
      uuid: row.uuid,
      deviceName: row.device_name,
      deviceType: row.device_type,
      isOnline: row.is_online,
      tags: row.tags || {}
    }));

    const response: DeviceQueryResponse = {
      count: devices.length,
      devices
    };

    moduleLogger.info('Device query executed', {
      tagSelectors,
      matchCount: devices.length
    });

    res.json(response);
  } catch (error: any) {
    moduleLogger.error('Error querying devices by tags', {
      error: error.message,
      stack: error.stack,
      tagSelectors: req.body.tagSelectors
    });
    res.status(500).json({
      error: 'Failed to query devices',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/devices/tags/bulk
 * Apply tags to multiple devices at once
 */
router.post('/devices/tags/bulk', async (req, res) => {
  try {
    const { deviceUuids, tags } = req.body as BulkTagOperationRequest;

    if (!deviceUuids || !Array.isArray(deviceUuids) || deviceUuids.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'deviceUuids array is required and must not be empty'
      });
    }

    if (!tags || typeof tags !== 'object' || Object.keys(tags).length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'tags object is required and must not be empty'
      });
    }

    // Verify all devices exist
    const devicesResult = await query(
      'SELECT uuid FROM devices WHERE uuid = ANY($1::uuid[])',
      [deviceUuids]
    );

    const existingUuids = devicesResult.rows.map(row => row.uuid);
    const missingUuids = deviceUuids.filter(uuid => !existingUuids.includes(uuid));

    if (missingUuids.length > 0) {
      return res.status(404).json({
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
            `INSERT INTO device_tags (device_uuid, key, value, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())
             ON CONFLICT (device_uuid, key)
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

      res.json({
        success: true,
        message: 'Tags applied to all devices successfully',
        devicesUpdated: existingUuids.length,
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
    res.status(500).json({
      error: 'Failed to apply bulk tags',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/tags/definitions
 * Get all tag definitions
 */
router.get('/tags/definitions', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, key, description, allowed_values, is_required, created_at, created_by, updated_at
       FROM tag_definitions
       ORDER BY key`
    );

    const definitions = result.rows.map(row => ({
      id: row.id,
      key: row.key,
      description: row.description,
      allowedValues: row.allowed_values,
      isRequired: row.is_required,
      createdAt: row.created_at,
      createdBy: row.created_by,
      updatedAt: row.updated_at
    }));

    res.json({
      count: definitions.length,
      definitions
    });
  } catch (error: any) {
    moduleLogger.error('Error fetching tag definitions', {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({
      error: 'Failed to fetch tag definitions',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/tags/definitions
 * Create a new tag definition
 */
router.post('/tags/definitions', async (req, res) => {
  try {
    const { key, description, allowedValues, isRequired } = req.body;

    // Validate required fields
    if (!key) {
      return res.status(400).json({
        error: 'Missing required field: key'
      });
    }

    // Validate key format
    const keyRegex = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/;
    if (!keyRegex.test(key)) {
      return res.status(400).json({
        error: 'Invalid tag key format',
        message: 'Key must be lowercase alphanumeric with dashes/underscores'
      });
    }

    const result = await query(
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

    res.status(201).json({
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
      return res.status(409).json({
        error: 'Tag definition already exists',
        message: `A tag definition with key '${req.body.key}' already exists`
      });
    }

    moduleLogger.error('Error creating tag definition', {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({
      error: 'Failed to create tag definition',
      message: error.message
    });
  }
});

/**
 * PUT /api/v1/tags/definitions/:key
 * Update an existing tag definition
 */
router.put('/tags/definitions/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { description, allowedValues, isRequired } = req.body;

    const result = await query(
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
      return res.status(404).json({
        error: 'Tag definition not found',
        message: `Tag definition with key '${key}' not found`
      });
    }

    const definition = result.rows[0];

    moduleLogger.info('Tag definition updated', {
      key,
      changes: { description, allowedValues, isRequired }
    });

    res.json({
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
    res.status(500).json({
      error: 'Failed to update tag definition',
      message: error.message
    });
  }
});

/**
 * DELETE /api/v1/tags/definitions/:key
 * Delete a tag definition
 */
router.delete('/tags/definitions/:key', async (req, res) => {
  try {
    const { key } = req.params;

    // Check if tag is in use
    const usageCheck = await query(
      'SELECT COUNT(*) as count FROM device_tags WHERE key = $1',
      [key]
    );

    const inUseCount = parseInt(usageCheck.rows[0].count);
    if (inUseCount > 0) {
      return res.status(409).json({
        error: 'Tag definition in use',
        message: `Cannot delete tag definition '${key}' as it is used by ${inUseCount} device(s)`,
        devicesAffected: inUseCount
      });
    }

    const result = await query(
      'DELETE FROM tag_definitions WHERE key = $1 RETURNING key',
      [key]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Tag definition not found',
        message: `Tag definition with key '${key}' not found`
      });
    }

    moduleLogger.info('Tag definition deleted', {
      key
    });

    res.json({
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
    res.status(500).json({
      error: 'Failed to delete tag definition',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/tags/keys
 * Get all unique tag keys in use
 */
router.get('/tags/keys', async (req, res) => {
  try {
    const result = await query(
      `SELECT DISTINCT key, COUNT(*) as device_count
       FROM device_tags
       GROUP BY key
       ORDER BY key`
    );

    const keys = result.rows.map(row => ({
      key: row.key,
      deviceCount: parseInt(row.device_count)
    }));

    res.json({
      count: keys.length,
      keys
    });
  } catch (error: any) {
    moduleLogger.error('Error fetching tag keys', {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({
      error: 'Failed to fetch tag keys',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/tags/values/:key
 * Get all unique values for a specific tag key
 */
router.get('/tags/values/:key', async (req, res) => {
  try {
    const { key } = req.params;

    const result = await query(
      `SELECT DISTINCT value, COUNT(*) as device_count
       FROM device_tags
       WHERE key = $1
       GROUP BY value
       ORDER BY value`,
      [key]
    );

    const values = result.rows.map(row => ({
      value: row.value,
      deviceCount: parseInt(row.device_count)
    }));

    res.json({
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
    res.status(500).json({
      error: 'Failed to fetch tag values',
      message: error.message
    });
  }
});
