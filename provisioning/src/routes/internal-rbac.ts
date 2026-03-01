/**
 * Internal RBAC Endpoints
 * 
 * Tenant API calls these endpoints to:
 * - Fetch user role for a given tenant (cached by tenant API)
 * - Get customer status (active/suspended)
 * - Add/update/remove user roles (admin operations)
 * 
 * Protected by X-Internal-Token header (shared secret with tenant API instances)
 */

import { Router, Request, Response } from 'express';
import { query } from '../db/connection';
import { timingSafeEqual } from 'crypto';

const router = Router();

/**
 * Middleware: Verify internal token
 * All endpoints require X-Internal-Token header matching INTERNAL_AUTH_TOKEN env var
 */
function verifyInternalToken(req: Request, res: Response, next: Function) {
  const token = req.headers['x-internal-token'] as string;
  const expectedToken = process.env.INTERNAL_AUTH_TOKEN;

  if (!expectedToken) {
    console.error('FATAL: INTERNAL_AUTH_TOKEN not configured');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  if (!token) {
    return res.status(401).json({ error: 'Missing X-Internal-Token header' });
  }

  // Constant-time comparison to prevent timing attacks
  try {
    const tokenBuffer = Buffer.from(token);
    const expectedBuffer = Buffer.from(expectedToken);
    
    if (tokenBuffer.length !== expectedBuffer.length) {
      return res.status(401).json({ error: 'Invalid internal token' });
    }
    
    if (!timingSafeEqual(tokenBuffer, expectedBuffer)) {
      return res.status(401).json({ error: 'Invalid internal token' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid internal token' });
  }

  next();
}

// Apply to all endpoints in this router
router.use(verifyInternalToken);

/**
 * GET /internal/users/:auth0_sub/tenants/:customer_id/role
 * 
 * Fetch user's role and customer status
 * Called by tenant API to populate cache on every request (or on cache miss)
 * 
 * Response:
 * {
 *   "success": true,
 *   "data": {
 *     "auth0_sub": "auth0|abc123",
 *     "customer_id": "cust_xyz",
 *     "role": "admin",
 *     "customer_status": "active",  // or "suspended"
 *     "last_updated_at": "2026-03-01T12:34:56Z",
 *     "role_assigned_at": "2026-02-01T10:00:00Z"
 *   }
 * }
 */
router.get('/users/:auth0_sub/tenants/:customer_id/role', async (req: Request, res: Response) => {
  try {
    const { auth0_sub, customer_id } = req.params;

    // Validate inputs
    if (!auth0_sub || !customer_id) {
      return res.status(400).json({ error: 'Missing auth0_sub or customer_id' });
    }

    // Fetch role + customer status in one query
    const result = await query(
      `SELECT 
        utr.auth0_sub,
        utr.customer_id,
        utr.role,
        utr.updated_at as role_assigned_at,
        c.deployment_status,
        c.is_active,
        CASE 
          WHEN c.is_active = false THEN 'suspended'
          WHEN c.deployment_status = 'ready' THEN 'active'
          ELSE 'provisioning'
        END as customer_status
      FROM user_tenant_roles utr
      JOIN customers c ON utr.customer_id = c.customer_id
      WHERE utr.auth0_sub = $1 AND utr.customer_id = $2`,
      [auth0_sub, customer_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: `User ${auth0_sub} does not have a role in customer ${customer_id}`
      });
    }

    const row = result.rows[0];

    res.status(200).json({
      success: true,
      data: {
        auth0_sub: row.auth0_sub,
        customer_id: row.customer_id,
        role: row.role,
        customer_status: row.customer_status,
        last_updated_at: new Date().toISOString(),  // Server time for cache validation
        role_assigned_at: row.role_assigned_at?.toISOString()
      }
    });

  } catch (error: any) {
    console.error('Internal RBAC error (fetch role):', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /internal/users
 * 
 * Assign user to a tenant with initial role (called on signup)
 * 
 * Body:
 * {
 *   "auth0_sub": "auth0|abc123",
 *   "customer_id": "cust_xyz",
 *   "role": "admin",
 *   "created_by": "signup_automation"  (optional)
 * }
 */
router.post('/users', async (req: Request, res: Response) => {
  try {
    const { auth0_sub, customer_id, role, created_by } = req.body;

    if (!auth0_sub || !customer_id || !role) {
      return res.status(400).json({ error: 'Missing required fields: auth0_sub, customer_id, role' });
    }

    // Validate role
    const validRoles = ['owner', 'admin', 'manager', 'operator', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
    }

    // Check customer exists
    const customerCheck = await query(
      'SELECT customer_id FROM customers WHERE customer_id = $1',
      [customer_id]
    );

    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ error: `Customer ${customer_id} not found` });
    }

    // Insert role (UNIQUE constraint prevents duplicates)
    const result = await query(
      `INSERT INTO user_tenant_roles (auth0_sub, customer_id, role, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (auth0_sub, customer_id) DO NOTHING
       RETURNING *`,
      [auth0_sub, customer_id, role, created_by || 'signup_automation']
    );

    if (result.rows.length === 0) {
      // Conflict: user already has a role in this tenant
      return res.status(409).json({
        error: 'Conflict',
        message: `User ${auth0_sub} already has a role in customer ${customer_id}`
      });
    }

    res.status(201).json({
      success: true,
      message: 'User assigned to tenant',
      data: result.rows[0]
    });

  } catch (error: any) {
    console.error('Internal RBAC error (assign role):', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /internal/users/:auth0_sub/tenants/:customer_id/role
 * 
 * Update user's role in a tenant
 * 
 * Body:
 * {
 *   "role": "operator"
 * }
 */
router.put('/users/:auth0_sub/tenants/:customer_id/role', async (req: Request, res: Response) => {
  try {
    const { auth0_sub, customer_id } = req.params;
    const { role } = req.body;

    if (!role) {
      return res.status(400).json({ error: 'Missing role in request body' });
    }

    // Validate role
    const validRoles = ['owner', 'admin', 'manager', 'operator', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
    }

    const result = await query(
      `UPDATE user_tenant_roles 
       SET role = $1, updated_at = CURRENT_TIMESTAMP
       WHERE auth0_sub = $2 AND customer_id = $3
       RETURNING *`,
      [role, auth0_sub, customer_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: `User ${auth0_sub} does not have a role in customer ${customer_id}`
      });
    }

    res.status(200).json({
      success: true,
      message: 'Role updated',
      data: result.rows[0]
    });

  } catch (error: any) {
    console.error('Internal RBAC error (update role):', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /internal/users/:auth0_sub/tenants/:customer_id
 * 
 * Remove user from a tenant
 */
router.delete('/users/:auth0_sub/tenants/:customer_id', async (req: Request, res: Response) => {
  try {
    const { auth0_sub, customer_id } = req.params;

    const result = await query(
      `DELETE FROM user_tenant_roles 
       WHERE auth0_sub = $1 AND customer_id = $2
       RETURNING auth0_sub, customer_id, role`,
      [auth0_sub, customer_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: `User ${auth0_sub} does not have a role in customer ${customer_id}`
      });
    }

    res.status(200).json({
      success: true,
      message: 'User removed from tenant',
      data: result.rows[0]
    });

  } catch (error: any) {
    console.error('Internal RBAC error (remove user):', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /internal/tenants/:customer_id/status
 * 
 * Get customer deployment and suspension status (for quick checks)
 */
router.get('/tenants/:customer_id/status', async (req: Request, res: Response) => {
  try {
    const { customer_id } = req.params;

    const result = await query(
      `SELECT 
        customer_id,
        deployment_status,
        is_active,
        CASE 
          WHEN is_active = false THEN 'suspended'
          WHEN deployment_status = 'ready' THEN 'active'
          ELSE 'provisioning'
        END as status
      FROM customers
      WHERE customer_id = $1`,
      [customer_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Customer ${customer_id} not found` });
    }

    res.status(200).json({
      success: true,
      data: result.rows[0]
    });

  } catch (error: any) {
    console.error('Internal RBAC error (customer status):', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
