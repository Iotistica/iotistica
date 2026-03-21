/**
 * Application Template Management Routes
 * Endpoints for managing application templates (Docker Compose-like stacks)
 * and legacy app/service ID generation
 */

import express from 'express';
import { query } from '../db/connection';
import { logger } from '../utils/logger';

export const router = express.Router();

// ============================================================================
// Application Template Management (Hybrid Approach)
// ============================================================================

/**
 * Create application template (Docker Compose-like stack)
 * POST /api/v1/applications
 * 
 * Body: {
 *   appName: string,
 *   slug: string,
 *   description?: string,
 *   defaultConfig: {
 *     services: [
 *       { serviceName, image, defaultPorts?, defaultEnvironment?, defaultVolumes? }
 *     ]
 *   }
 * }
 * 
 * Returns: { appId, appName, slug }
 */
router.post('/applications', async (req, res) => {
  try {
    const { appName, slug, description, defaultConfig } = req.body;

    // Validation
    if (!appName || typeof appName !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'appName is required and must be a string'
      });
    }

    if (!slug || typeof slug !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'slug is required and must be a string (URL-safe identifier)'
      });
    }

    if (defaultConfig && typeof defaultConfig !== 'object') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'defaultConfig must be an object'
      });
    }

    // Check if slug already exists
    const existingApp = await query(
      'SELECT id, app_name FROM applications WHERE slug = $1',
      [slug]
    );

    if (existingApp.rows.length > 0) {
      return res.status(409).json({
        error: 'Conflict',
        message: `Application with slug "${slug}" already exists (ID: ${existingApp.rows[0].id})`
      });
    }

    // Get next app ID from sequence (starts at 1000)
    const idResult = await query<{ nextval: number }>(
      "SELECT nextval('global_app_id_seq') as nextval"
    );
    const appId = idResult.rows[0].nextval;

    // Insert into applications table with explicit ID
    const result = await query(
      `INSERT INTO applications (id, app_name, slug, description, default_config)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        appId,
        appName,
        slug,
        description || '',
        JSON.stringify(defaultConfig || { services: [] })
      ]
    );

    const app = result.rows[0];

    // Also register in app_service_ids registry for tracking
    await query(
      `INSERT INTO app_service_ids (entity_type, entity_id, entity_name, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        'app',
        appId,
        appName,
        JSON.stringify({ slug, description }),
        req.headers['x-user-id'] || 'system'
      ]
    );

    logger.info(`Created application template: ${appName} (ID: ${appId}, slug: ${slug})`);

    res.status(201).json({
      appId: app.id,
      appName: app.app_name,
      slug: app.slug,
      description: app.description,
      defaultConfig: typeof app.default_config === 'string' 
        ? JSON.parse(app.default_config) 
        : app.default_config,
      createdAt: app.created_at
    });

  } catch (error: any) {
    logger.error('Error creating application template:', error);
    res.status(500).json({
      error: 'Failed to create application template',
      message: error.message
    });
  }
});

/**
 * List all application templates
 * GET /api/v1/applications
 * 
 * Query params: ?search=keyword
 */
router.get('/applications', async (req, res) => {
  try {
    const { search } = req.query;

    let sql = 'SELECT * FROM applications WHERE 1=1';
    const params: any[] = [];

    if (search && typeof search === 'string') {
      params.push(`%${search}%`);
      sql += ` AND (app_name ILIKE $${params.length} OR description ILIKE $${params.length})`;
    }

    sql += ' ORDER BY id DESC';

    const result = await query(sql, params);

    const applications = result.rows.map(app => ({
      appId: app.id,
      appName: app.app_name,
      slug: app.slug,
      description: app.description,
      defaultConfig: typeof app.default_config === 'string' 
        ? JSON.parse(app.default_config) 
        : app.default_config,
      createdAt: app.created_at,
      modifiedAt: app.modified_at
    }));

    res.json({
      count: applications.length,
      applications
    });

  } catch (error: any) {
    logger.error('Error listing applications:', error);
    res.status(500).json({
      error: 'Failed to list applications',
      message: error.message
    });
  }
});

/**
 * Get specific application template
 * GET /api/v1/applications/:appId
 */
router.get('/applications/:appId', async (req, res) => {
  try {
    const appId = parseInt(req.params.appId);

    if (isNaN(appId)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'appId must be a number'
      });
    }

    const result = await query(
      'SELECT * FROM applications WHERE id = $1',
      [appId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: `Application with ID ${appId} not found`
      });
    }

    const app = result.rows[0];

    res.json({
      appId: app.id,
      appName: app.app_name,
      slug: app.slug,
      description: app.description,
      defaultConfig: typeof app.default_config === 'string' 
        ? JSON.parse(app.default_config) 
        : app.default_config,
      createdAt: app.created_at,
      modifiedAt: app.modified_at
    });

  } catch (error: any) {
    logger.error('Error getting application:', error);
    res.status(500).json({
      error: 'Failed to get application',
      message: error.message
    });
  }
});

/**
 * Update application template
 * PATCH /api/v1/applications/:appId
 * 
 * Body: { appName?, description?, defaultConfig? }
 */
router.patch('/applications/:appId', async (req, res) => {
  try {
    const appId = parseInt(req.params.appId);
    const { appName, description, defaultConfig } = req.body;

    if (isNaN(appId)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'appId must be a number'
      });
    }

    // Build dynamic UPDATE query
    const updates: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (appName !== undefined) {
      params.push(appName);
      updates.push(`app_name = $${paramIndex++}`);
    }

    if (description !== undefined) {
      params.push(description);
      updates.push(`description = $${paramIndex++}`);
    }

    if (defaultConfig !== undefined) {
      params.push(JSON.stringify(defaultConfig));
      updates.push(`default_config = $${paramIndex++}`);
    }

    updates.push(`modified_at = CURRENT_TIMESTAMP`);

    if (updates.length === 1) { // Only modified_at
      return res.status(400).json({
        error: 'Invalid request',
        message: 'At least one field must be provided for update'
      });
    }

    params.push(appId);
    const sql = `UPDATE applications SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

    const result = await query(sql, params);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: `Application with ID ${appId} not found`
      });
    }

    const app = result.rows[0];

    logger.info(`Updated application template: ${app.app_name} (ID: ${appId})`);

    res.json({
      appId: app.id,
      appName: app.app_name,
      slug: app.slug,
      description: app.description,
      defaultConfig: typeof app.default_config === 'string' 
        ? JSON.parse(app.default_config) 
        : app.default_config,
      modifiedAt: app.modified_at
    });

  } catch (error: any) {
    logger.error('Error updating application:', error);
    res.status(500).json({
      error: 'Failed to update application',
      message: error.message
    });
  }
});

/**
 * Delete application template
 * DELETE /api/v1/applications/:appId
 */
router.delete('/applications/:appId', async (req, res) => {
  try {
    const appId = parseInt(req.params.appId);

    if (isNaN(appId)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'appId must be a number'
      });
    }

    // Check if any agents are using this app
    const agentsUsing = await query(
      `SELECT agent_uuid, apps 
       FROM agent_target_state 
       WHERE apps::text LIKE $1`,
      [`%"appId":${appId}%`]
    );

    if (agentsUsing.rows.length > 0) {
      return res.status(409).json({
        error: 'Conflict',
        message: `Cannot delete application: ${agentsUsing.rows.length} device(s) are using this app`,
        agentsAffected: agentsUsing.rows.map(r => r.agent_uuid)
      });
    }

    const result = await query(
      'DELETE FROM applications WHERE id = $1 RETURNING app_name',
      [appId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: `Application with ID ${appId} not found`
      });
    }

    logger.info(`Deleted application template: ${result.rows[0].app_name} (ID: ${appId})`);

    res.json({
      status: 'ok',
      message: 'Application template deleted',
      appId
    });

  } catch (error: any) {
    logger.error('Error deleting application:', error);
    res.status(500).json({
      error: 'Failed to delete application',
      message: error.message
    });
  }
});

// ============================================================================
// App/Service ID Management Endpoints (Legacy - for backwards compatibility)
// ============================================================================

/**
 * Generate next app ID
 * POST /api/v1/apps/next-id
 * 
 * Body: { appName: string, metadata?: object }
 * Returns: { appId: number, appName: string }
 */
router.post('/apps/next-id', async (req, res) => {
  try {
    const { appName, metadata } = req.body;

    if (!appName || typeof appName !== 'string') {
      return res.status(400).json({ 
        error: 'Invalid request',
        message: 'appName is required and must be a string' 
      });
    }

    // Get next app ID from sequence
    const idResult = await query<{ nextval: number }>(
      "SELECT nextval('global_app_id_seq') as nextval"
    );
    const appId = idResult.rows[0].nextval;

    // Register the ID in registry table (for tracking/auditability)
    await query(
      `INSERT INTO app_service_ids (entity_type, entity_id, entity_name, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (entity_type, entity_id) DO UPDATE SET
         entity_name = $3,
         metadata = $4`,
      [
        'app', 
        appId, 
        appName, 
        metadata ? JSON.stringify(metadata) : '{}',
        req.headers['x-user-id'] || 'system'
      ]
    );

    logger.info(`Generated app ID ${appId} for "${appName}"`);

    res.json({ 
      appId, 
      appName,
      metadata: metadata || {}
    });


  } catch (error: any) {
    logger.error('Error generating app ID:', error);
    res.status(500).json({
      error: 'Failed to generate app ID',
      message: error.message
    });
  }
});/**
 * Generate next service ID
 * POST /api/v1/services/next-id
 * 
 * Body: { serviceName: string, appId: number, imageName?: string, metadata?: object }
 * Returns: { serviceId: number, serviceName: string, appId: number }
 */
router.post('/services/next-id', async (req, res) => {
  try {
    const { serviceName, appId, imageName, metadata } = req.body;

    if (!serviceName || typeof serviceName !== 'string') {
      return res.status(400).json({ 
        error: 'Invalid request',
        message: 'serviceName is required and must be a string' 
      });
    }

    if (!appId || typeof appId !== 'number') {
      return res.status(400).json({ 
        error: 'Invalid request',
        message: 'appId is required and must be a number' 
      });
    }

    // Get next service ID from sequence
    const idResult = await query<{ nextval: number }>(
      "SELECT nextval('global_service_id_seq') as nextval"
    );
    const serviceId = idResult.rows[0].nextval;

    // Merge metadata with appId and imageName
    const fullMetadata = {
      appId,
      ...(imageName && { imageName }),
      ...(metadata || {})
    };

    // Register the ID in registry table
    await query(
      `INSERT INTO app_service_ids (entity_type, entity_id, entity_name, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (entity_type, entity_id) DO UPDATE SET
         entity_name = $3,
         metadata = $4`,
      [
        'service', 
        serviceId, 
        serviceName, 
        JSON.stringify(fullMetadata),
        req.headers['x-user-id'] || 'system'
      ]
    );

    logger.info(`Generated service ID ${serviceId} for "${serviceName}" (app ${appId})`);

    res.json({ 
      serviceId, 
      serviceName, 
      appId,
      imageName,
      metadata: fullMetadata
    });


  } catch (error: any) {
    logger.error('Error generating service ID:', error);
    res.status(500).json({
      error: 'Failed to generate service ID',
      message: error.message
    });
  }
});/**
 * Get all registered app/service IDs
 * GET /api/v1/apps-services/registry
 * 
 * Query params: ?type=app|service
 */
router.get('/apps-services/registry', async (req, res) => {
  try {
    const { type } = req.query;

    let sql = 'SELECT * FROM app_service_ids WHERE 1=1';
    const params: any[] = [];

    if (type === 'app' || type === 'service') {
      params.push(type);
      sql += ` AND entity_type = $${params.length}`;
    }

    sql += ' ORDER BY entity_id DESC';

    const result = await query(sql, params);

    res.json({
      count: result.rows.length,
      items: result.rows.map(row => ({
        id: row.id,
        type: row.entity_type,
        entityId: row.entity_id,
        name: row.entity_name,
        metadata: row.metadata,
        createdBy: row.created_by,
        createdAt: row.created_at
      }))
    });

  } catch (error: any) {
    logger.error('Error fetching app/service registry:', error);
    res.status(500).json({
      error: 'Failed to fetch app/service registry',
      message: error.message
    });
  }
});

/**
 * Get specific app or service by ID
 * GET /api/v1/apps-services/:type/:id
 * 
 * Params: type=app|service, id=number
 */
router.get('/apps-services/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;

    if (type !== 'app' && type !== 'service') {
      return res.status(400).json({ 
        error: 'Invalid type',
        message: 'type must be "app" or "service"' 
      });
    }

    const entityId = parseInt(id);
    if (isNaN(entityId)) {
      return res.status(400).json({ 
        error: 'Invalid ID',
        message: 'id must be a number' 
      });
    }

    const result = await query(
      'SELECT * FROM app_service_ids WHERE entity_type = $1 AND entity_id = $2',
      [type, entityId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Not found',
        message: `${type} with ID ${entityId} not found` 
      });
    }

    const row = result.rows[0];
    res.json({
      id: row.id,
      type: row.entity_type,
      entityId: row.entity_id,
      name: row.entity_name,
      metadata: row.metadata,
      createdBy: row.created_by,
      createdAt: row.created_at
    });


  } catch (error: any) {
    logger.error('Error fetching app/service:', error);
    res.status(500).json({
      error: 'Failed to fetch app/service',
      message: error.message
    });
  }
});export default router;
