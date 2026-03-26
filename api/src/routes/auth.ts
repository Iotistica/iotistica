/**
 * Authentication Routes
 * 
 * Handles user registration, login, logout, token refresh, and password management
 */

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import * as authService from '../services/auth/auth.service';
import { jwtAuth, requireRole } from '../middleware/jwt-auth';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// Rate limiting for auth endpoints
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per window
  message: {
    error: 'Too Many Requests',
    message: 'Too many authentication attempts. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

const registerRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 registrations per hour per IP
  message: {
    error: 'Too Many Requests',
    message: 'Too many registration attempts. Please try again later.'
  }
});

/**
 * POST /auth/register
 * 
 * Register a new user account
 * 
 * Body:
 *   - username: string (required, min 3 chars)
 *   - email: string (required, valid email)
 *   - password: string (required, min 8 chars)
 *   - fullName: string (optional)
 * 
 * Returns: { accessToken, refreshToken, user }
 */
router.post('/register', registerRateLimit, async (req: Request, res: Response) => {
  try {
    const { username, email, password, fullName } = req.body;

    if (!username || !email || !password) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Username, email, and password are required'
      });
      return;
    }

    const result = await authService.registerUser({
      username,
      email,
      password,
      fullName,
      role: 'user' // Default role for self-registration
    });

    res.status(201).json({
      message: 'User registered successfully',
      data: result
    });

  } catch (error: any) {
    console.error('Registration error:', error);
    
    if (error.message.includes('already exists') || 
        error.message.includes('at least') ||
        error.message.includes('required')) {
      res.status(400).json({
        error: 'Bad Request',
        message: error.message
      });
      return;
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Registration failed'
    });
  }
});

/**
 * POST /auth/login
 * 
 * Authenticate user and receive JWT tokens
 * 
 * Body:
 *   - username: string (username or email)
 *   - password: string
 * 
 * Returns: { accessToken, refreshToken, user }
 */
router.post('/login', authRateLimit, async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Username and password are required'
      });
      return;
    }

    // Extract client info - req.ip automatically populated from X-Forwarded-For via trust proxy
    const ipAddress = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await authService.loginUser(
      username,
      password,
      ipAddress,
      userAgent
    );

    res.status(200).json({
      message: 'Login successful',
      data: result
    });

  } catch (error: any) {
    console.error('Login error:', error);
    
    if (error.message.includes('Invalid') || 
        error.message.includes('inactive')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: error.message
      });
      return;
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Login failed'
    });
  }
});

/**
 * POST /auth/bootstrap-admin
 *
 * Bootstrap initial admin password for a newly deployed namespace.
 * Protected by a deployment token (x-bootstrap-token header).
 *
 * Headers:
 *   - x-bootstrap-token: string (required)
 *
 * Body:
 *   - password: string (required, min 12)
 *   - email: string (optional)
 */
router.post('/bootstrap-admin', authRateLimit, async (req: Request, res: Response) => {
  try {
    const configuredToken = process.env.INITIAL_ADMIN_BOOTSTRAP_TOKEN;

    if (!configuredToken) {
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'Bootstrap token is not configured on this instance'
      });
      return;
    }

    const requestToken = req.headers['x-bootstrap-token'];
    if (!requestToken || requestToken !== configuredToken) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid bootstrap token'
      });
      return;
    }

    const { password, email } = req.body;

    if (!password) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'password is required'
      });
      return;
    }

    await authService.bootstrapAdminPassword(password, email);

    res.status(200).json({
      message: 'Admin bootstrap password set successfully',
      data: {
        mustChangePassword: true
      }
    });
  } catch (error: any) {
    console.error('Bootstrap admin error:', error);

    if (
      error.message.includes('at least') ||
      error.message.includes('required') ||
      error.message.includes('not found') ||
      error.message.includes('Valid email')
    ) {
      res.status(400).json({
        error: 'Bad Request',
        message: error.message
      });
      return;
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Bootstrap admin failed'
    });
  }
});

/**
 * POST /auth/refresh
 * 
 * Refresh access token using refresh token
 * 
 * Body:
 *   - refreshToken: string
 * 
 * Returns: { accessToken }
 */
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Refresh token is required'
      });
      return;
    }

    // req.ip automatically populated from X-Forwarded-For via trust proxy
    const ipAddress = req.ip || req.socket.remoteAddress;

    const result = await authService.refreshAccessToken(refreshToken, ipAddress);

    res.status(200).json({
      message: 'Token refreshed successfully',
      data: result
    });

  } catch (error: any) {
    console.error('Token refresh error:', error);
    
    res.status(401).json({
      error: 'Unauthorized',
      message: error.message
    });
  }
});

/**
 * POST /auth/logout
 * 
 * Logout user (revoke refresh token)
 * Requires JWT authentication
 * 
 * Body:
 *   - refreshToken: string (optional - if not provided, revokes all tokens)
 * 
 * Returns: { message }
 */
router.post('/logout', jwtAuth, async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    const userId = req.user!.id;

    await authService.logoutUser(userId, refreshToken);

    res.status(200).json({
      message: 'Logged out successfully'
    });

  } catch (error: any) {
    console.error('Logout error:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Logout failed'
    });
  }
});

/**
 * POST /auth/change-password
 * 
 * Change user password
 * Requires JWT authentication
 * 
 * Body:
 *   - currentPassword: string
 *   - newPassword: string
 * 
 * Returns: { message }
 */
router.post('/change-password', jwtAuth, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user!.id;

    if (!currentPassword || !newPassword) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Current password and new password are required'
      });
      return;
    }

    await authService.changePassword(userId, currentPassword, newPassword);

    res.status(200).json({
      message: 'Password changed successfully. Please login again with your new password.'
    });

  } catch (error: any) {
    console.error('Password change error:', error);
    
    if (error.message.includes('incorrect') || 
        error.message.includes('at least')) {
      res.status(400).json({
        error: 'Bad Request',
        message: error.message
      });
      return;
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Password change failed'
    });
  }
});

/**
 * POST /auth/reset-password
 * 
 * Set initial admin password using reset token
 * No authentication required (uses token from email link)
 * 
 * Body:
 *   - token: string (reset token from email)
 *   - customerId: string (customer ID from provisioning)
 *   - password: string (new password, min 12 chars)
 * 
 * Returns: { message, data: { username } }
 */
router.post('/reset-password', authRateLimit, async (req: Request, res: Response) => {
  try {
    const { token, customerId, password } = req.body;

    if (!token || !customerId || !password) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Token, customerId, and password are required'
      });
      return;
    }

    if (password.length < 12) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Password must be at least 12 characters'
      });
      return;
    }

    const provisioningApiUrl = process.env.PROVISIONING_API_URL || 'http://localhost:3100';
    const axios = (await import('axios')).default;

    // Step 1: Validate token with provisioning service
    let validationResponse;
    try {
      validationResponse = await axios.post(
        `${provisioningApiUrl}/api/auth/validate-reset-token`,
        { token, customerId }
      );
    } catch (error: any) {
      console.error('Token validation failed:', error.response?.data || error.message);
      
      const status = error.response?.status || 500;
      const message = error.response?.data?.message || 'Token validation failed';
      
      res.status(status).json({
        error: status === 400 ? 'Bad Request' : 'Internal Server Error',
        message
      });
      return;
    }

    const { username } = validationResponse.data.data;

    // Step 2: Set password in local users table
    const ipAddress = req.ip || req.socket.remoteAddress;
    await authService.setPasswordFromReset(username, password, ipAddress);

    // Step 3: Mark token as used in provisioning service
    try {
      await axios.post(
        `${provisioningApiUrl}/api/auth/mark-token-used`,
        { token, customerId }
      );
    } catch (error: any) {
      console.error('Failed to mark token as used:', error.response?.data || error.message);
      // Continue - password already set, token invalidation is best-effort
    }

    res.status(200).json({
      message: 'Initial password set successfully. You can now login.',
      data: { username }
    });

  } catch (error: any) {
    console.error('Set initial password error:', error);
    
    if (error.message.includes('at least') || 
        error.message.includes('not found')) {
      res.status(400).json({
        error: 'Bad Request',
        message: error.message
      });
      return;
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to set password'
    });
  }
});

/**
 * GET /auth/me
 * 
 * Get current authenticated user info with MQTT broker settings
 * Returns instance-level MQTT credentials (FlowFuse pattern)
 * Requires JWT authentication
 * 
 * Returns: { user (with brokerClient settings) }
 */
router.get('/me', jwtAuth, async (req: Request, res: Response) => {
  try {
    // Get instance-level MQTT credentials from environment
    // These are generated by mqtt-bootstrap service on first startup
    const instanceId = process.env.NODERED_INSTANCE_ID || 'default';
    const mqttBrokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://mosquitto:1883';
    const mqttUsername = process.env.MQTT_USERNAME || `nodered_${instanceId}`;
    const mqttPassword = process.env.MQTT_PASSWORD;
    
    if (!mqttPassword) {
      // This should not happen - credentials should be generated on startup
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'MQTT credentials not configured. Please check server configuration.'
      });
      return;
    }
    
    res.status(200).json({
      data: {
        user: {
          ...req.user,
          brokerClient: {
            url: mqttBrokerUrl,
            username: mqttUsername,
            password: mqttPassword
          }
        }
      }
    });
  } catch (error: any) {
    console.error('Get user error:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get user info'
    });
  }
});

// ============================================================================
// MQTT USERS & ACL MANAGEMENT
// ============================================================================

/**
 * GET /auth/mqtt-users
 * 
 * Get all MQTT users with their ACLs
 * Requires admin role
 * 
 * Returns: { users: [{ id, username, is_superuser, is_active, acls: [] }] }
 */
router.get('/mqtt-users', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { query } = await import('../db/connection');
    
    // Get all MQTT users
    const usersResult = await query(
      `SELECT id, username, is_superuser, is_active, created_at, updated_at 
       FROM mqtt_users 
       ORDER BY created_at DESC`
    );
    
    // Get ACLs for each user
    const users = await Promise.all(
      usersResult.rows.map(async (user) => {
        const aclsResult = await query(
          `SELECT id, topic, access, priority, created_at 
           FROM mqtt_acls 
           WHERE username = $1 
           ORDER BY priority DESC, topic ASC`,
          [user.username]
        );
        
        return {
          ...user,
          acls: aclsResult.rows
        };
      })
    );
    
    res.status(200).json({
      success: true,
      users
    });
  } catch (error: any) {
    console.error('Get MQTT users error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch MQTT users'
    });
  }
});

/**
 * POST /auth/mqtt-users
 * 
 * Create a new MQTT user
 * Requires admin role
 * 
 * Body:
 *   - username: string (required)
 *   - password: string (required)
 *   - is_superuser: boolean (optional, default false)
 *   - is_active: boolean (optional, default true)
 * 
 * Returns: { user }
 */
router.post('/mqtt-users', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { username, password, is_superuser = false, is_active = true } = req.body;
    
    if (!username || !password) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Username and password are required'
      });
      return;
    }
    
    const { query } = await import('../db/connection');
    const bcrypt = await import('bcrypt');
    
    // Hash password with bcrypt (mosquitto-go-auth compatible)
    const passwordHash = await bcrypt.hash(password, 10);
    
    const result = await query(
      `INSERT INTO mqtt_users (username, password_hash, is_superuser, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, is_superuser, is_active, created_at`,
      [username, passwordHash, is_superuser, is_active]
    );
    
    res.status(201).json({
      success: true,
      message: 'MQTT user created successfully',
      user: result.rows[0]
    });
  } catch (error: any) {
    console.error('Create MQTT user error:', error);
    
    if (error.message?.includes('duplicate') || error.code === '23505') {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Username already exists'
      });
      return;
    }
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create MQTT user'
    });
  }
});

/**
 * PUT /auth/mqtt-users/:id
 * 
 * Update an MQTT user
 * Requires admin role
 * 
 * Body:
 *   - password: string (optional)
 *   - is_superuser: boolean (optional)
 *   - is_active: boolean (optional)
 * 
 * Returns: { user }
 */
router.put('/mqtt-users/:id', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { password, is_superuser, is_active } = req.body;
    
    const { query } = await import('../db/connection');
    
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    if (password) {
      const bcrypt = await import('bcrypt');
      const passwordHash = await bcrypt.hash(password, 10);
      updates.push(`password_hash = $${paramIndex++}`);
      values.push(passwordHash);
    }
    
    if (is_superuser !== undefined) {
      updates.push(`is_superuser = $${paramIndex++}`);
      values.push(is_superuser);
    }
    
    if (is_active !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(is_active);
    }
    
    if (updates.length === 0) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'No fields to update'
      });
      return;
    }
    
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    
    const result = await query(
      `UPDATE mqtt_users 
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, username, is_superuser, is_active, updated_at`,
      values
    );
    
    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: 'MQTT user not found'
      });
      return;
    }
    
    res.status(200).json({
      success: true,
      message: 'MQTT user updated successfully',
      user: result.rows[0]
    });
  } catch (error: any) {
    console.error('Update MQTT user error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update MQTT user'
    });
  }
});

/**
 * DELETE /auth/mqtt-users/:id
 * 
 * Delete an MQTT user and their ACLs
 * Requires admin role
 * 
 * Returns: { message }
 */
router.delete('/mqtt-users/:id', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { query } = await import('../db/connection');
    
    // Get username before deleting
    const userResult = await query(
      'SELECT username FROM mqtt_users WHERE id = $1',
      [id]
    );
    
    if (userResult.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: 'MQTT user not found'
      });
      return;
    }
    
    const username = userResult.rows[0].username;
    
    // Delete ACLs first
    await query('DELETE FROM mqtt_acls WHERE username = $1', [username]);
    
    // Delete user
    await query('DELETE FROM mqtt_users WHERE id = $1', [id]);
    
    res.status(200).json({
      success: true,
      message: 'MQTT user deleted successfully'
    });
  } catch (error: any) {
    console.error('Delete MQTT user error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to delete MQTT user'
    });
  }
});

/**
 * POST /auth/mqtt-users/:id/acls
 * 
 * Add an ACL rule to an MQTT user
 * Requires admin role
 * 
 * Body:
 *   - topic: string (required) - MQTT topic pattern (supports + and # wildcards)
 *   - access: number (required) - 1=read/subscribe, 2=write/publish, 3=both
 *   - priority: number (optional, default 0) - Higher priority rules checked first
 * 
 * Returns: { acl }
 */
router.post('/mqtt-users/:id/acls', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { topic, access, priority = 0 } = req.body;
    
    if (!topic || access === undefined) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Topic and access are required'
      });
      return;
    }
    
    if (![1, 2, 3].includes(access)) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Access must be 1 (read), 2 (write), or 3 (read+write)'
      });
      return;
    }
    
    const { query } = await import('../db/connection');
    
    // Get username
    const userResult = await query(
      'SELECT username FROM mqtt_users WHERE id = $1',
      [id]
    );
    
    if (userResult.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: 'MQTT user not found'
      });
      return;
    }
    
    const username = userResult.rows[0].username;
    
    const result = await query(
      `INSERT INTO mqtt_acls (username, topic, access, priority)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, topic, access, priority, created_at`,
      [username, topic, access, priority]
    );
    
    res.status(201).json({
      success: true,
      message: 'ACL rule created successfully',
      acl: result.rows[0]
    });
  } catch (error: any) {
    console.error('Create ACL error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create ACL rule'
    });
  }
});

/**
 * PUT /auth/mqtt-acls/:id
 * 
 * Update an ACL rule
 * Requires admin role
 * 
 * Body:
 *   - topic: string (optional)
 *   - access: number (optional)
 *   - priority: number (optional)
 * 
 * Returns: { acl }
 */
router.put('/mqtt-acls/:id', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { topic, access, priority } = req.body;
    
    const { query } = await import('../db/connection');
    
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    if (topic) {
      updates.push(`topic = $${paramIndex++}`);
      values.push(topic);
    }
    
    if (access !== undefined) {
      if (![1, 2, 3].includes(access)) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Access must be 1 (read), 2 (write), or 3 (read+write)'
        });
        return;
      }
      updates.push(`access = $${paramIndex++}`);
      values.push(access);
    }
    
    if (priority !== undefined) {
      updates.push(`priority = $${paramIndex++}`);
      values.push(priority);
    }
    
    if (updates.length === 0) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'No fields to update'
      });
      return;
    }
    
    values.push(id);
    
    const result = await query(
      `UPDATE mqtt_acls 
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, username, topic, access, priority`,
      values
    );
    
    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: 'ACL rule not found'
      });
      return;
    }
    
    res.status(200).json({
      success: true,
      message: 'ACL rule updated successfully',
      acl: result.rows[0]
    });
  } catch (error: any) {
    console.error('Update ACL error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update ACL rule'
    });
  }
});

/**
 * DELETE /auth/mqtt-acls/:id
 * 
 * Delete an ACL rule
 * Requires admin role
 * 
 * Returns: { success: true }
 */
router.delete('/mqtt-acls/:id', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { query } = await import('../db/connection');
    
    const result = await query(
      'DELETE FROM mqtt_acls WHERE id = $1 RETURNING id',
      [id]
    );
    
    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: 'ACL rule not found'
      });
      return;
    }
    
    res.status(200).json({
      success: true,
      message: 'ACL rule deleted successfully'
    });
  } catch (error: any) {
    console.error('Delete ACL error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to delete ACL rule'
    });
  }
});

/**
 * GET /auth/api-keys
 *
 * List service API keys
 * Requires admin role
 */
router.get('/api-keys', jwtAuth, requireRole('admin'), async (_req: Request, res: Response) => {
  try {
    const { query } = await import('../db/connection');

    const result = await query(
      `SELECT id, name, key, description, is_active, created_at, expires_at, last_used_at
       FROM api_keys
       ORDER BY created_at DESC`
    );

    const keys = result.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      key: row.key,
      key_prefix: row.key ? row.key.substring(0, 8) : '',
      description: row.description,
      is_active: row.is_active,
      created_at: row.created_at,
      expires_at: row.expires_at,
      last_used_at: row.last_used_at,
    }));

    res.status(200).json({ success: true, keys });
  } catch (error: any) {
    console.error('List API keys error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch API keys'
    });
  }
});

/**
 * POST /auth/api-keys
 *
 * Create a new service API key
 * Requires admin role
 */
router.post('/api-keys', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { name, description = null, expires_at = null } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Name is required'
      });
      return;
    }

    const key = crypto.randomBytes(32).toString('hex');
    const { query } = await import('../db/connection');

    const result = await query(
      `INSERT INTO api_keys (name, key, description, is_active, expires_at)
       VALUES ($1, $2, $3, true, $4)
       RETURNING id, name, key, description, is_active, created_at, expires_at, last_used_at`,
      [name.trim(), key, description, expires_at || null]
    );

    const created = result.rows[0];

    res.status(201).json({
      success: true,
      message: 'API key created successfully',
      key: {
        id: created.id,
        name: created.name,
        key: created.key,
        key_prefix: created.key.substring(0, 8),
        description: created.description,
        is_active: created.is_active,
        created_at: created.created_at,
        expires_at: created.expires_at,
        last_used_at: created.last_used_at,
      }
    });
  } catch (error: any) {
    console.error('Create API key error:', error);

    if (error.code === '23505') {
      res.status(400).json({
        error: 'Bad Request',
        message: 'API key name already exists'
      });
      return;
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create API key'
    });
  }
});

/**
 * DELETE /auth/api-keys/:id
 *
 * Revoke (deactivate) an API key
 * Requires admin role
 */
router.delete('/api-keys/:id', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { query } = await import('../db/connection');

    const result = await query(
      `UPDATE api_keys
       SET is_active = false
       WHERE id = $1
       RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: 'API key not found'
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: 'API key revoked successfully'
    });
  } catch (error: any) {
    console.error('Revoke API key error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to revoke API key'
    });
  }
});

export default router;
