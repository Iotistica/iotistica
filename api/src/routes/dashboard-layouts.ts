import { Router, Request, Response } from 'express';
import { query } from '../db/connection';
import { jwtAuth } from '../middleware/jwt-auth';
import crypto from 'crypto';

const router = Router();

// All routes require authentication
// NOTE: This router is mounted at ${API_BASE}/dashboard-layouts in index.ts,
//       so '/' here means /dashboard-layouts/* - this is path-specific and safe
router.use('/', jwtAuth);

async function resolveLayoutOwnerKey(req: Request): Promise<string | null> {
  if (!req.user) {
    return null;
  }

  // Legacy local-user fallback to keep old layouts reachable when present.
  if (typeof req.user.id === 'number' && req.user.id > 0) {
    return `legacy:${req.user.id}`;
  }

  // Auth0/federated path: derive stable owner key from tenant + subject identity.
  const customerId = req.user.customerId?.trim() || 'customer-local';
  const subject = req._auth0Payload?.sub?.trim() || req.user.username?.trim() || req.user.email?.trim().toLowerCase();

  if (!subject) {
    return null;
  }

  const rawIdentity = `${customerId}|${subject}`;
  const digest = crypto.createHash('sha256').update(rawIdentity).digest('hex').slice(0, 48);
  return `auth0:${digest}`;
}

/**
 * GET /api/v1/dashboard-layouts/:deviceUuid
 * Get dashboard layout for a device or 'global' for multi-device dashboard
 */
router.get('/:deviceUuid', async (req: Request, res: Response) => {
  try {
    const { deviceUuid } = req.params;
    const ownerKey = await resolveLayoutOwnerKey(req);

    if (!ownerKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Handle global dashboard (agent_uuid = NULL)
    const isGlobal = deviceUuid === 'global';
    const deviceUuidValue = isGlobal ? null : deviceUuid;

    // First try to get user's default layout
    const defaultResult = await query(`
      SELECT id, layout_name, widgets, is_default, share_token, created_at, updated_at
      FROM dashboard_layouts
      WHERE owner_key = $1 AND ${isGlobal ? 'agent_uuid IS NULL' : 'agent_uuid = $2'} AND is_default = true
      LIMIT 1
    `, isGlobal ? [ownerKey] : [ownerKey, deviceUuidValue]);

    if (defaultResult.rows.length > 0) {
      const layout = defaultResult.rows[0];
      return res.json({
        id: layout.id,
        layoutName: layout.layout_name,
        widgets: layout.widgets,
        isDefault: layout.is_default,
        shareToken: layout.share_token,
        createdAt: layout.created_at,
        updatedAt: layout.updated_at
      });
    }

    // If no default, get most recently updated layout
    const latestResult = await query(`
      SELECT id, layout_name, widgets, is_default, share_token, created_at, updated_at
      FROM dashboard_layouts
      WHERE owner_key = $1 AND ${isGlobal ? 'agent_uuid IS NULL' : 'agent_uuid = $2'}
      ORDER BY updated_at DESC
      LIMIT 1
    `, isGlobal ? [ownerKey] : [ownerKey, deviceUuidValue]);

    if (latestResult.rows.length > 0) {
      const layout = latestResult.rows[0];
      return res.json({
        id: layout.id,
        layoutName: layout.layout_name,
        widgets: layout.widgets,
        isDefault: layout.is_default,
        shareToken: layout.share_token,
        createdAt: layout.created_at,
        updatedAt: layout.updated_at
      });
    }

    // No saved layout found - return empty to use client-side default
    res.json({ widgets: [], isDefault: true });
  } catch (error) {
    console.error('Error fetching dashboard layout:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard layout' });
  }
});

/**
 * GET /api/v1/dashboard-layouts/:deviceUuid/all
 * Get all dashboard layouts for a device or 'global' (for layout management)
 */
router.get('/:deviceUuid/all', async (req: Request, res: Response) => {
  try {
    const { deviceUuid } = req.params;
    const ownerKey = await resolveLayoutOwnerKey(req);

    if (!ownerKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const isGlobal = deviceUuid === 'global';
    const deviceUuidValue = isGlobal ? null : deviceUuid;

    const result = await query(`
      SELECT id, layout_name, widgets, is_default, share_token, created_at, updated_at
      FROM dashboard_layouts
      WHERE owner_key = $1 AND ${isGlobal ? 'agent_uuid IS NULL' : 'agent_uuid = $2'}
      ORDER BY is_default DESC, layout_name ASC
    `, isGlobal ? [ownerKey] : [ownerKey, deviceUuidValue]);

    const layouts = result.rows.map(layout => ({
      id: layout.id,
      layoutName: layout.layout_name,
      widgetCount: Array.isArray(layout.widgets) ? layout.widgets.length : 0,
      isDefault: layout.is_default,
      shareToken: layout.share_token,
      createdAt: layout.created_at,
      updatedAt: layout.updated_at
    }));

    res.json(layouts);
  } catch (error) {
    console.error('Error fetching dashboard layouts:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard layouts' });
  }
});

/**
 * POST /api/v1/dashboard-layouts/:deviceUuid
 * Save/create a dashboard layout (use 'global' for multi-device dashboard)
 */
router.post('/:deviceUuid', async (req: Request, res: Response) => {
  try {
    const { deviceUuid } = req.params;
    const { layoutName = 'Default', widgets, isDefault = false } = req.body;
    const ownerKey = await resolveLayoutOwnerKey(req);

    if (!ownerKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!widgets || !Array.isArray(widgets)) {
      return res.status(400).json({ error: 'Widgets array is required' });
    }

    const isGlobal = deviceUuid === 'global';
    const deviceUuidValue = isGlobal ? null : deviceUuid;

    // Verify device exists (skip for global dashboards)
    if (!isGlobal) {
      const deviceCheck = await query(`SELECT uuid FROM agents WHERE uuid = $1`, [deviceUuid]);
      if (deviceCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Device not found' });
      }
    }

    // If setting as default, unset other defaults for this user/device
    if (isDefault) {
      if (isGlobal) {
        await query(`
          UPDATE dashboard_layouts
          SET is_default = false
          WHERE owner_key = $1 AND agent_uuid IS NULL
        `, [ownerKey]);
      } else {
        await query(`
          UPDATE dashboard_layouts
          SET is_default = false
          WHERE owner_key = $1 AND agent_uuid = $2
        `, [ownerKey, deviceUuidValue]);
      }
    }

    // Check if layout with this name already exists
    let existingResult;
    if (isGlobal) {
      existingResult = await query(`
        SELECT id FROM dashboard_layouts
        WHERE owner_key = $1 AND agent_uuid IS NULL AND layout_name = $2
      `, [ownerKey, layoutName]);
    } else {
      existingResult = await query(`
        SELECT id FROM dashboard_layouts
        WHERE owner_key = $1 AND agent_uuid = $2 AND layout_name = $3
      `, [ownerKey, deviceUuidValue, layoutName]);
    }

    let layout;
    if (existingResult.rows.length > 0) {
      // Update existing layout
      const result = await query(`
        UPDATE dashboard_layouts
        SET widgets = $1, is_default = $2, updated_at = NOW()
        WHERE id = $3
        RETURNING id, layout_name, widgets, is_default, created_at, updated_at
      `, [JSON.stringify(widgets), isDefault, existingResult.rows[0].id]);
      
      layout = result.rows[0];
    } else {
      // Create new layout
      const result = await query(`
        INSERT INTO dashboard_layouts (owner_key, agent_uuid, layout_name, widgets, is_default)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, layout_name, widgets, is_default, created_at, updated_at
      `, [ownerKey, deviceUuidValue, layoutName, JSON.stringify(widgets), isDefault]);

      layout = result.rows[0];
    }

    console.log(`Dashboard layout saved for owner ${ownerKey}, ${isGlobal ? 'global' : 'device ' + deviceUuid}: ${layoutName} (${widgets.length} widgets)`);

    res.json({
      id: layout.id,
      layoutName: layout.layout_name,
      widgets: layout.widgets,
      isDefault: layout.is_default,
      createdAt: layout.created_at,
      updatedAt: layout.updated_at
    });
  } catch (error) {
    console.error('Error saving dashboard layout:', error);
    res.status(500).json({ 
      error: 'Failed to save dashboard layout',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/v1/dashboard-layouts/by-share-token/:shareToken
 * Get a dashboard layout by share token (public access for shared dashboards)
 */
router.get('/by-share-token/:shareToken', async (req: Request, res: Response) => {
  try {
    const { shareToken } = req.params;
    const ownerKey = await resolveLayoutOwnerKey(req);

    if (!ownerKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await query(`
      SELECT id, layout_name, widgets, is_default, share_token, created_at, updated_at
      FROM dashboard_layouts
      WHERE share_token = $1
    `, [shareToken]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dashboard not found' });
    }

    const layout = result.rows[0];
    res.json({
      id: layout.id,
      layoutName: layout.layout_name,
      widgets: layout.widgets,
      isDefault: layout.is_default,
      shareToken: layout.share_token,
      createdAt: layout.created_at,
      updatedAt: layout.updated_at
    });
  } catch (error) {
    console.error('Error fetching layout by share token:', error);
    res.status(500).json({ error: 'Failed to fetch layout' });
  }
});

/**
 * GET /api/v1/dashboard-layouts/by-id/:layoutId
 * Get a specific dashboard layout by ID
 */
router.get('/by-id/:layoutId', async (req: Request, res: Response) => {
  try {
    const { layoutId } = req.params;
    const ownerKey = await resolveLayoutOwnerKey(req);

    if (!ownerKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await query(`
      SELECT id, layout_name, widgets, is_default, share_token, created_at, updated_at
      FROM dashboard_layouts
      WHERE id = $1 AND owner_key = $2
    `, [layoutId, ownerKey]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Layout not found' });
    }

    const layout = result.rows[0];
    res.json({
      id: layout.id,
      layoutName: layout.layout_name,
      widgets: layout.widgets,
      isDefault: layout.is_default,
      shareToken: layout.share_token,
      createdAt: layout.created_at,
      updatedAt: layout.updated_at
    });
  } catch (error) {
    console.error('Error fetching layout by ID:', error);
    res.status(500).json({ error: 'Failed to fetch layout' });
  }
});

/**
 * PUT /api/v1/dashboard-layouts/:layoutId
 * Update an existing dashboard layout
 */
router.put('/:layoutId', async (req: Request, res: Response) => {
  try {
    const { layoutId } = req.params;
    const { layoutName, widgets, isDefault } = req.body;
    const ownerKey = await resolveLayoutOwnerKey(req);

    if (!ownerKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify layout belongs to user
    const layoutResult = await query(`
      SELECT id, agent_uuid FROM dashboard_layouts
      WHERE id = $1 AND owner_key = $2
    `, [layoutId, ownerKey]);

    if (layoutResult.rows.length === 0) {
      return res.status(404).json({ error: 'Layout not found' });
    }

    const layout = layoutResult.rows[0];

    // If setting as default, unset other defaults
    if (isDefault) {
      await query(`
        UPDATE dashboard_layouts
        SET is_default = false
        WHERE owner_key = $1 AND agent_uuid = $2 AND id != $3
      `, [ownerKey, layout.agent_uuid, layoutId]);
    }

    // Build dynamic update query
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (layoutName !== undefined) {
      updates.push(`layout_name = $${paramIndex++}`);
      values.push(layoutName);
    }
    if (widgets !== undefined) {
      updates.push(`widgets = $${paramIndex++}`);
      values.push(JSON.stringify(widgets));
    }
    if (isDefault !== undefined) {
      updates.push(`is_default = $${paramIndex++}`);
      values.push(isDefault);
    }

    if (updates.length > 0) {
      updates.push(`updated_at = NOW()`);
      values.push(layoutId);

      const updateQuery = `
        UPDATE dashboard_layouts
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING id, layout_name, widgets, is_default, created_at, updated_at
      `;

      const result = await query(updateQuery, values);
      const updatedLayout = result.rows[0];

      res.json({
        id: updatedLayout.id,
        layoutName: updatedLayout.layout_name,
        widgets: updatedLayout.widgets,
        isDefault: updatedLayout.is_default,
        createdAt: updatedLayout.created_at,
        updatedAt: updatedLayout.updated_at
      });
    } else {
      // No updates provided, just return current layout
      const result = await query(`
        SELECT id, layout_name, widgets, is_default, created_at, updated_at
        FROM dashboard_layouts
        WHERE id = $1
      `, [layoutId]);

      const currentLayout = result.rows[0];
      res.json({
        id: currentLayout.id,
        layoutName: currentLayout.layout_name,
        widgets: currentLayout.widgets,
        isDefault: currentLayout.is_default,
        createdAt: currentLayout.created_at,
        updatedAt: currentLayout.updated_at
      });
    }
  } catch (error) {
    console.error('Error updating dashboard layout:', error);
    res.status(500).json({ 
      error: 'Failed to update dashboard layout',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * DELETE /api/v1/dashboard-layouts/:layoutId
 * Delete a dashboard layout
 */
router.delete('/:layoutId', async (req: Request, res: Response) => {
  try {
    const { layoutId } = req.params;
    const ownerKey = await resolveLayoutOwnerKey(req);

    if (!ownerKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify layout belongs to user
    const layoutResult = await query(`
      SELECT id FROM dashboard_layouts
      WHERE id = $1 AND owner_key = $2
    `, [layoutId, ownerKey]);

    if (layoutResult.rows.length === 0) {
      return res.status(404).json({ error: 'Layout not found' });
    }

    await query(`DELETE FROM dashboard_layouts WHERE id = $1`, [layoutId]);

    console.log(`Dashboard layout deleted: ${layoutId} by owner ${ownerKey}`);

    res.json({ message: 'Layout deleted successfully' });
  } catch (error) {
    console.error('Error deleting dashboard layout:', error);
    res.status(500).json({ 
      error: 'Failed to delete dashboard layout',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;


