import { Router, Request, Response } from 'express';
import { query } from '../db/connection';
import { jwtAuth } from '../middleware/jwt-auth';

const router = Router();

interface AuthRequest extends Request {
  user?: {
    id: number;
    username: string;
    email: string;
    role: string;
    isActive: boolean;
  };
}

// All routes require authentication
router.use(jwtAuth);

/**
 * GET /api/v1/dashboard-layouts/:deviceUuid
 * Get dashboard layout for a device or 'global' for multi-device dashboard
 */
router.get('/:deviceUuid', async (req: AuthRequest, res: Response) => {
  try {
    const { deviceUuid } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Handle global dashboard (device_uuid = NULL)
    const isGlobal = deviceUuid === 'global';
    const deviceUuidValue = isGlobal ? null : deviceUuid;

    // First try to get user's default layout
    const defaultResult = await query(`
      SELECT id, layout_name, widgets, is_default, share_token, created_at, updated_at
      FROM dashboard_layouts
      WHERE user_id = $1 AND ${isGlobal ? 'device_uuid IS NULL' : 'device_uuid = $2'} AND is_default = true
      LIMIT 1
    `, isGlobal ? [userId] : [userId, deviceUuidValue]);

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
      WHERE user_id = $1 AND ${isGlobal ? 'device_uuid IS NULL' : 'device_uuid = $2'}
      ORDER BY updated_at DESC
      LIMIT 1
    `, isGlobal ? [userId] : [userId, deviceUuidValue]);

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
router.get('/:deviceUuid/all', async (req: AuthRequest, res: Response) => {
  try {
    const { deviceUuid } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const isGlobal = deviceUuid === 'global';
    const deviceUuidValue = isGlobal ? null : deviceUuid;

    const result = await query(`
      SELECT id, layout_name, widgets, is_default, share_token, created_at, updated_at
      FROM dashboard_layouts
      WHERE user_id = $1 AND ${isGlobal ? 'device_uuid IS NULL' : 'device_uuid = $2'}
      ORDER BY is_default DESC, layout_name ASC
    `, isGlobal ? [userId] : [userId, deviceUuidValue]);

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
router.post('/:deviceUuid', async (req: AuthRequest, res: Response) => {
  try {
    const { deviceUuid } = req.params;
    const { layoutName = 'Default', widgets, isDefault = false } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!widgets || !Array.isArray(widgets)) {
      return res.status(400).json({ error: 'Widgets array is required' });
    }

    const isGlobal = deviceUuid === 'global';
    const deviceUuidValue = isGlobal ? null : deviceUuid;

    // Verify device exists (skip for global dashboards)
    if (!isGlobal) {
      const deviceCheck = await query(`SELECT uuid FROM devices WHERE uuid = $1`, [deviceUuid]);
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
          WHERE user_id = $1 AND device_uuid IS NULL
        `, [userId]);
      } else {
        await query(`
          UPDATE dashboard_layouts
          SET is_default = false
          WHERE user_id = $1 AND device_uuid = $2
        `, [userId, deviceUuidValue]);
      }
    }

    // Check if layout with this name already exists
    let existingResult;
    if (isGlobal) {
      existingResult = await query(`
        SELECT id FROM dashboard_layouts
        WHERE user_id = $1 AND device_uuid IS NULL AND layout_name = $2
      `, [userId, layoutName]);
    } else {
      existingResult = await query(`
        SELECT id FROM dashboard_layouts
        WHERE user_id = $1 AND device_uuid = $2 AND layout_name = $3
      `, [userId, deviceUuidValue, layoutName]);
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
        INSERT INTO dashboard_layouts (user_id, device_uuid, layout_name, widgets, is_default)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, layout_name, widgets, is_default, created_at, updated_at
      `, [userId, deviceUuidValue, layoutName, JSON.stringify(widgets), isDefault]);

      layout = result.rows[0];
    }

    console.log(`Dashboard layout saved for user ${userId}, ${isGlobal ? 'global' : 'device ' + deviceUuid}: ${layoutName} (${widgets.length} widgets)`);

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
router.get('/by-share-token/:shareToken', async (req: AuthRequest, res: Response) => {
  try {
    const { shareToken } = req.params;
    const userId = req.user?.id;

    if (!userId) {
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
router.get('/by-id/:layoutId', async (req: AuthRequest, res: Response) => {
  try {
    const { layoutId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await query(`
      SELECT id, layout_name, widgets, is_default, share_token, created_at, updated_at
      FROM dashboard_layouts
      WHERE id = $1 AND user_id = $2
    `, [layoutId, userId]);

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
router.put('/:layoutId', async (req: AuthRequest, res: Response) => {
  try {
    const { layoutId } = req.params;
    const { layoutName, widgets, isDefault } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify layout belongs to user
    const layoutResult = await query(`
      SELECT id, device_uuid FROM dashboard_layouts
      WHERE id = $1 AND user_id = $2
    `, [layoutId, userId]);

    if (layoutResult.rows.length === 0) {
      return res.status(404).json({ error: 'Layout not found' });
    }

    const layout = layoutResult.rows[0];

    // If setting as default, unset other defaults
    if (isDefault) {
      await query(`
        UPDATE dashboard_layouts
        SET is_default = false
        WHERE user_id = $1 AND device_uuid = $2 AND id != $3
      `, [userId, layout.device_uuid, layoutId]);
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
router.delete('/:layoutId', async (req: AuthRequest, res: Response) => {
  try {
    const { layoutId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify layout belongs to user
    const layoutResult = await query(`
      SELECT id FROM dashboard_layouts
      WHERE id = $1 AND user_id = $2
    `, [layoutId, userId]);

    if (layoutResult.rows.length === 0) {
      return res.status(404).json({ error: 'Layout not found' });
    }

    await query(`DELETE FROM dashboard_layouts WHERE id = $1`, [layoutId]);

    console.log(`Dashboard layout deleted: ${layoutId} by user ${userId}`);

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
