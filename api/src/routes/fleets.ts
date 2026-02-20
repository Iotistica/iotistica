/**
 * Fleet Management Routes
 * Unified fleet management for virtual and physical devices
 */

import express from 'express';
import { query } from '../db/connection';
import logger from '../utils/logger';
import { jwtAuth } from '../middleware/jwt-auth';

const router = express.Router();

const resolveFleetByIdentifier = async (fleetIdentifier: string) => {
  const result = await query(
    'SELECT * FROM fleets WHERE fleet_uuid::text = $1',
    [fleetIdentifier]
  );
  return result.rows[0] || null;
};

// ============================================================================
// POST /fleets/virtual/estimate - Estimate virtual fleet cost (PUBLIC - no auth)
// ============================================================================
router.post('/fleets/virtual/estimate', async (req, res) => {
  try {
    const { agent_count, devices_per_agent, billing_mode } = req.body;

    if (!agent_count || !devices_per_agent) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'agent_count and devices_per_agent are required'
      });
    }

    // Calculate cost using database function
    const result = await query(
      'SELECT * FROM calculate_fleet_cost($1, $2)',
      [agent_count, devices_per_agent]
    );

    const estimate = result.rows[0];

    res.json({
      agent_count,
      devices_per_agent,
      billing_mode: billing_mode || 'hourly',
      ...estimate
    });

  } catch (error: any) {
    logger.error('[FLEETS] Error estimating cost:', error);
    res.status(500).json({
      error: 'Failed to estimate cost',
      message: error.message
    });
  }
});

// ============================================================================
// PROTECTED ROUTES (require authentication)
// ============================================================================

// ============================================================================
// GET /fleets - List all fleets for customer
// ============================================================================
router.get('/fleets', jwtAuth, async (req, res) => {
  try {
    const { customer_id, fleet_type, status, environment } = req.query;

    let queryText = `
      SELECT 
        f.fleet_uuid, f.fleet_name, f.customer_id, f.fleet_type, f.status,
        f.environment, f.location, f.billing_enabled, f.current_cost,
        f.budget_limit, f.created_at, f.updated_at,
        COUNT(d.uuid) as device_count,
        COUNT(d.uuid) FILTER (WHERE d.is_online = true) as online_count
      FROM fleets f
      LEFT JOIN devices d ON d.fleet_uuid = f.fleet_uuid
      WHERE f.status != 'deleted'
    `;

    const params: any[] = [];
    let paramCount = 1;

    if (customer_id) {
      queryText += ` AND f.customer_id = $${paramCount++}`;
      params.push(customer_id);
    }

    if (fleet_type) {
      queryText += ` AND f.fleet_type = $${paramCount++}`;
      params.push(fleet_type);
    }

    if (status) {
      queryText += ` AND f.status = $${paramCount++}`;
      params.push(status);
    }

    if (environment) {
      queryText += ` AND f.environment = $${paramCount++}`;
      params.push(environment);
    }

    queryText += `
      GROUP BY 
        f.fleet_uuid, f.fleet_name, f.customer_id, f.fleet_type, f.status,
        f.environment, f.location, f.billing_enabled, f.current_cost,
        f.budget_limit, f.created_at, f.updated_at
      ORDER BY f.created_at DESC
    `;

    const result = await query(queryText, params);

    res.json({
      fleets: result.rows,
      total: result.rowCount
    });

  } catch (error: any) {
    logger.error('[FLEETS] Error listing fleets:', error);
    res.status(500).json({
      error: 'Failed to list fleets',
      message: error.message
    });
  }
});

// ============================================================================
// GET /fleets/:id - Get fleet details
// ============================================================================
router.get('/fleets/:id', jwtAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Resolve fleet by UUID
    const fleetInfo = await query(
      'SELECT * FROM fleets WHERE fleet_uuid::text = $1',
      [id]
    );

    if (fleetInfo.rows.length === 0) {
      return res.status(404).json({
        error: 'Fleet not found',
        id
      });
    }

    const resolvedFleetUuid = fleetInfo.rows[0].fleet_uuid as string;

    const result = await query(
      'SELECT * FROM get_fleet_stats($1)',
      [resolvedFleetUuid]
    );

    // Get devices in fleet (prefer fleet_uuid)
    const devices = await query(
      `SELECT 
        d.uuid, d.device_name, d.device_type, d.is_online,
        d.cpu_usage, d.memory_usage, d.memory_total,
        d.deployment_status, d.k8s_pod_name,
        (SELECT COUNT(*) FROM device_sensors ds WHERE ds.device_uuid = d.uuid) as endpoint_count
      FROM devices d
      WHERE d.fleet_uuid = $1
      ORDER BY d.device_name`,
      [resolvedFleetUuid]
    );

    res.json({
      ...fleetInfo.rows[0],
      stats: result.rows[0],
      devices: devices.rows
    });

  } catch (error: any) {
    logger.error('[FLEETS] Error getting fleet details:', error);
    res.status(500).json({
      error: 'Failed to get fleet details',
      message: error.message
    });
  }
});

// ============================================================================
// POST /fleets - Create new fleet
// ============================================================================
router.post('/fleets', jwtAuth, async (req, res) => {
  try {
    const {
      fleet_name,
      customer_id = '00000000-0000-0000-0000-000000000001', // Default customer for single-tenant deployments
      fleet_type = 'physical',
      description,
      environment,
      location,
      tags = {},
      billing_enabled = false,
      billing_mode,
      budget_limit,
      agent_count,
      devices_per_agent
    } = req.body;

    // Validation
    if (!fleet_name) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['fleet_name']
      });
    }

    if (!['virtual', 'physical', 'mixed'].includes(fleet_type)) {
      return res.status(400).json({
        error: 'Invalid fleet_type',
        allowed: ['virtual', 'physical', 'mixed']
      });
    }

    // Virtual fleet requires agent configuration
    if (fleet_type === 'virtual' && (!agent_count || !devices_per_agent)) {
      return res.status(400).json({
        error: 'Virtual fleets require agent_count and devices_per_agent',
        required: ['agent_count', 'devices_per_agent']
      });
    }

    // Generate fleet_uuid
    const { v4: uuidv4 } = require('uuid');
    const fleet_uuid = uuidv4(); // Generate UUID for use in K8s namespace creation
    
    // Prepare deployment config for virtual fleets
    const deployment_config = fleet_type === 'virtual' ? {
      agent_count,
      devices_per_agent,
      total_devices: agent_count * devices_per_agent,
      created_at: new Date().toISOString()
    } : {};

    // Create K8s namespace for virtual fleets
    let k8s_namespace = null;
    let namespaceWarning: string | undefined;
    
    if (fleet_type === 'virtual') {
      try {
        // Use VirtualAgentDeployer service which has properly configured K8s client
        const { virtualAgentDeployer } = await import('../services/virtual-agent-deployer.js');
        
        k8s_namespace = await virtualAgentDeployer.createFleetNamespace({
          fleet_uuid: fleet_uuid,
          fleet_name,
          customer_id,
          agent_count,
          devices_per_agent
        });
        
        logger.info(`[FLEETS] Created K8s namespace for virtual fleet`, {
          fleet_uuid,
          namespace: k8s_namespace,
          agent_count,
          total_devices: agent_count * devices_per_agent
        });
        
      } catch (k8sError: any) {
        const k8sBody = k8sError?.body || k8sError?.response?.body;
        const k8sReason = k8sBody?.reason;
        const k8sMessage = k8sBody?.message;
        const statusCode = k8sError?.statusCode;
        const errorMessage = k8sMessage
          || (k8sError instanceof Error ? k8sError.message : String(k8sError));
        
        logger.error('[FLEETS] Failed to create K8s namespace', {
          fleet_uuid,
          error: errorMessage,
          statusCode,
          k8sReason,
          k8sMessage,
          k8sBody
        });
        
        // K8s not available - continue without namespace
        logger.warn('[FLEETS] K8s not available - fleet created without namespace');
        k8s_namespace = null;
        namespaceWarning = errorMessage;
      }
    }

    const result = await query(
      `INSERT INTO fleets (
        fleet_uuid, fleet_name, customer_id, fleet_type, description,
        environment, location, tags, billing_enabled, billing_mode, budget_limit,
        deployment_config, k8s_namespace, target_device_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (fleet_uuid) DO NOTHING
      RETURNING *`,
      [
        fleet_uuid, fleet_name, customer_id, fleet_type, description,
        environment, location, JSON.stringify(tags), billing_enabled,
        billing_mode, budget_limit, JSON.stringify(deployment_config),
        k8s_namespace, fleet_type === 'virtual' ? agent_count * devices_per_agent : null
      ]
    );

    // Check if fleet was created (ON CONFLICT might have skipped insert)
    if (!result.rows || result.rows.length === 0) {
      return res.status(409).json({
        error: 'Fleet with this UUID already exists',
        fleet_uuid
      });
    }

    // Record creation event
    await query(
      `SELECT record_fleet_usage_event($1, $2, $3, $4)`,
      [
        fleet_uuid,
        'fleet_created',
        'api',
        JSON.stringify({ 
          created_via: 'api', 
          fleet_type,
          agent_count: agent_count || null,
          devices_per_agent: devices_per_agent || null,
          k8s_namespace
        })
      ]
    );

    logger.info(`[FLEETS] Created fleet: ${fleet_uuid}`, {
      fleet_name,
      fleet_type,
      customer_id,
      k8s_namespace,
      agent_count: agent_count || null
    });

    const response: any = {
      ...result.rows[0]
    };
    
    // Include warning if namespace creation failed
    if (fleet_type === 'virtual' && !k8s_namespace && namespaceWarning) {
      response.warning = `Fleet created but K8s namespace creation failed: ${namespaceWarning}`;
      response.namespace_status = 'failed';
    } else if (fleet_type === 'virtual' && k8s_namespace) {
      response.namespace_status = 'created';
    }

    res.status(201).json(response);

  } catch (error: any) {
    logger.error('[FLEETS] Error creating fleet:', error);
    res.status(500).json({
      error: 'Failed to create fleet',
      message: error.message
    });
  }
});

// ============================================================================
// PATCH /fleets/:id - Update fleet
// ============================================================================
router.patch('/fleets/:id', jwtAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      fleet_name,
      description,
      environment,
      location,
      tags,
      budget_limit,
      status
    } = req.body;

    const updates: string[] = [];
    const params: any[] = [];
    let paramCount = 1;

    if (fleet_name !== undefined) {
      updates.push(`fleet_name = $${paramCount++}`);
      params.push(fleet_name);
    }

    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      params.push(description);
    }

    if (environment !== undefined) {
      updates.push(`environment = $${paramCount++}`);
      params.push(environment);
    }

    if (location !== undefined) {
      updates.push(`location = $${paramCount++}`);
      params.push(location);
    }

    if (tags !== undefined) {
      updates.push(`tags = $${paramCount++}`);
      params.push(JSON.stringify(tags));
    }

    if (budget_limit !== undefined) {
      updates.push(`budget_limit = $${paramCount++}`);
      params.push(budget_limit);
    }

    if (status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      params.push(status);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: 'No fields to update'
      });
    }

    const fleet = await resolveFleetByIdentifier(id);
    if (!fleet) {
      return res.status(404).json({
        error: 'Fleet not found',
        id
      });
    }

    params.push(fleet.fleet_uuid);

    const result = await query(
      `UPDATE fleets SET ${updates.join(', ')}
       WHERE fleet_uuid = $${paramCount}
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Fleet not found',
        id
      });
    }

    logger.info(`[FLEETS] Updated fleet: ${fleet.fleet_uuid}`, { id, ...req.body });

    res.json(result.rows[0]);

  } catch (error: any) {
    logger.error('[FLEETS] Error updating fleet:', error);
    res.status(500).json({
      error: 'Failed to update fleet',
      message: error.message
    });
  }
});

// ============================================================================
// POST /fleets/:id/stop - Stop fleet (virtual fleets)
// ============================================================================
router.post('/fleets/:id/stop', jwtAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Get fleet info
    const fleet = await resolveFleetByIdentifier(id);

    if (!fleet) {
      return res.status(404).json({
        error: 'Fleet not found',
        id
      });
    }

    if (fleet.status === 'stopped') {
      return res.status(400).json({
        error: 'Fleet is already stopped'
      });
    }

    // Update fleet status
    await query(
      `UPDATE fleets 
       SET status = 'stopped', stopped_at = CURRENT_TIMESTAMP
       WHERE fleet_uuid = $1`,
      [fleet.fleet_uuid]
    );

    // Record event
    await query(
      `SELECT record_fleet_usage_event($1, $2, $3, $4)`,
      [fleet.fleet_uuid, 'stopped', 'api', JSON.stringify({ stopped_via: 'api' })]
    );

    // Get device count using fleet_uuid
    const devices = await query(
      'SELECT COUNT(*) as count FROM devices WHERE fleet_uuid = $1',
      [fleet.fleet_uuid]
    );

    logger.info(`[FLEETS] Stopped fleet: ${fleet.fleet_uuid}`, {
      device_count: devices.rows[0].count
    });

    res.json({
      fleet_uuid: fleet.fleet_uuid,
      status: 'stopped',
      stopped_at: new Date().toISOString(),
      device_count: parseInt(devices.rows[0].count),
      message: `Fleet stopped. ${fleet.billing_enabled ? 'Billing paused.' : ''}`
    });

  } catch (error: any) {
    logger.error('[FLEETS] Error stopping fleet:', error);
    res.status(500).json({
      error: 'Failed to stop fleet',
      message: error.message
    });
  }
});

// ============================================================================
// POST /fleets/:id/start - Start fleet (virtual fleets)
// ============================================================================
router.post('/fleets/:id/start', jwtAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Get fleet info
    const fleet = await resolveFleetByIdentifier(id);

    if (!fleet) {
      return res.status(404).json({
        error: 'Fleet not found',
        id
      });
    }

    if (fleet.status === 'active') {
      return res.status(400).json({
        error: 'Fleet is already active'
      });
    }

    // Update fleet status
    await query(
      `UPDATE fleets 
       SET status = 'active', started_at = CURRENT_TIMESTAMP, stopped_at = NULL
       WHERE fleet_uuid = $1`,
      [fleet.fleet_uuid]
    );

    // Record event
    await query(
      `SELECT record_fleet_usage_event($1, $2, $3, $4)`,
      [fleet.fleet_uuid, 'started', 'api', JSON.stringify({ started_via: 'api' })]
    );

    // Get device count using fleet_uuid
    const devices = await query(
      'SELECT COUNT(*) as count FROM devices WHERE fleet_uuid = $1',
      [fleet.fleet_uuid]
    );

    logger.info(`[FLEETS] Started fleet: ${fleet.fleet_uuid}`, {
      device_count: devices.rows[0].count
    });

    res.json({
      fleet_uuid: fleet.fleet_uuid,
      status: 'active',
      started_at: new Date().toISOString(),
      device_count: parseInt(devices.rows[0].count),
      message: `Fleet started. ${fleet.billing_enabled ? 'Billing resumed.' : ''}`
    });

  } catch (error: any) {
    logger.error('[FLEETS] Error starting fleet:', error);
    res.status(500).json({
      error: 'Failed to start fleet',
      message: error.message
    });
  }
});

// ============================================================================
// DELETE /fleets/:id - Delete fleet (soft delete + K8s namespace cleanup)
// ============================================================================
router.delete('/fleets/:id', jwtAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // First, get fleet info including k8s_namespace (before soft delete)
    const fleet = await resolveFleetByIdentifier(id);

    if (!fleet) {
      return res.status(404).json({
        error: 'Fleet not found',
        id
      });
    }

    if (fleet.status === 'deleted') {
      return res.status(404).json({
        error: 'Fleet already deleted',
        id
      });
    }

    // If this is a virtual fleet with K8s namespace, delete it
    if (fleet.k8s_namespace) {
      try {
        logger.info(`[FLEETS] Deleting K8s namespace for fleet: ${fleet.fleet_uuid}`, { namespace: fleet.k8s_namespace });
        const { virtualAgentDeployer } = await import('../services/virtual-agent-deployer.js');
        await virtualAgentDeployer.deleteFleetNamespace(fleet.k8s_namespace);
        logger.info(`[FLEETS] K8s namespace deleted successfully`, { namespace: fleet.k8s_namespace, fleet_uuid: fleet.fleet_uuid });
      } catch (error: any) {
        // Log error but continue with soft delete - namespace may already be gone or K8s unavailable
        logger.warn(`[FLEETS] Failed to delete K8s namespace (continuing with soft delete)`, {
          fleet_uuid: fleet.fleet_uuid,
          namespace: fleet.k8s_namespace,
          error: error.message
        });
      }
    }

    // Perform soft delete in database
    const result = await query(
      `UPDATE fleets 
       SET status = 'deleted', stopped_at = CURRENT_TIMESTAMP
       WHERE fleet_uuid = $1 AND status != 'deleted'
       RETURNING *`,
      [fleet.fleet_uuid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Fleet not found or already deleted',
        id
      });
    }

    // Record event
    await query(
      `SELECT record_fleet_usage_event($1, $2, $3, $4)`,
      [fleet.fleet_uuid, 'stopped', 'api', JSON.stringify({ deleted_via: 'api', k8s_namespace_deleted: !!fleet.k8s_namespace })]
    );

    logger.info(`[FLEETS] Deleted fleet: ${fleet.fleet_uuid}`, { k8s_namespace_deleted: !!fleet.k8s_namespace });

    res.json({
      fleet_uuid: fleet.fleet_uuid,
      status: 'deleted',
      message: 'Fleet deleted successfully',
      k8s_namespace_deleted: !!fleet.k8s_namespace
    });

  } catch (error: any) {
    logger.error('[FLEETS] Error deleting fleet:', error);
    res.status(500).json({
      error: 'Failed to delete fleet',
      message: error.message
    });
  }
});

// ============================================================================
// GET /fleets/:id/billing - Get billing summary
// ============================================================================
router.get('/fleets/:id/billing', jwtAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const fleet = await resolveFleetByIdentifier(id);
    if (!fleet) {
      return res.status(404).json({
        error: 'Fleet not found',
        id
      });
    }

    const result = await query(
      `SELECT * FROM fleet_billing_summary WHERE fleet_uuid = $1`,
      [fleet.fleet_uuid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Fleet not found or billing not enabled',
        id
      });
    }

    res.json({
      ...result.rows[0],
      fleet_uuid: fleet.fleet_uuid
    });

  } catch (error: any) {
    logger.error('[FLEETS] Error getting billing summary:', error);
    res.status(500).json({
      error: 'Failed to get billing summary',
      message: error.message
    });
  }
});

// ============================================================================
// GET /fleets/:id/usage-events - Get usage event history
// ============================================================================
router.get('/fleets/:id/usage-events', jwtAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50 } = req.query;

    const fleet = await resolveFleetByIdentifier(id);
    if (!fleet) {
      return res.status(404).json({
        error: 'Fleet not found',
        id
      });
    }

    const result = await query(
      `SELECT * FROM fleet_usage_events
       WHERE fleet_uuid = $1
       ORDER BY event_timestamp DESC
       LIMIT $2`,
      [fleet.fleet_uuid, limit]
    );

    res.json({
      fleet_uuid: fleet.fleet_uuid,
      events: result.rows,
      total: result.rowCount
    });

  } catch (error: any) {
    logger.error('[FLEETS] Error getting usage events:', error);
    res.status(500).json({
      error: 'Failed to get usage events',
      message: error.message
    });
  }
});

// ============================================================================
// POST /fleets/virtual/estimate - Estimate virtual fleet cost
// ============================================================================
router.post('/fleets/virtual/estimate', async (req, res) => {
  try {
    const { agent_count, devices_per_agent, billing_mode = 'hourly' } = req.body;

    if (!agent_count || !devices_per_agent) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['agent_count', 'devices_per_agent']
      });
    }

    const result = await query(
      `SELECT * FROM calculate_fleet_cost($1, $2, $3)`,
      [agent_count, devices_per_agent, billing_mode]
    );

    res.json({
      agent_count,
      devices_per_agent,
      billing_mode,
      ...result.rows[0]
    });

  } catch (error: any) {
    logger.error('[FLEETS] Error estimating cost:', error);
    res.status(500).json({
      error: 'Failed to estimate cost',
      message: error.message
    });
  }
});

export default router;
