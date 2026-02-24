/**
 * User Management Routes
 * 
 * Handles CRUD operations for dashboard users with role-based permissions
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { query } from '../db/connection';
import { jwtAuth, requireRole } from '../middleware/jwt-auth';
import { PERMISSIONS, ROLES, UserWithPermissions } from '../types/permissions';
import { logger } from '../utils/logger';

const router = Router();

// SECURITY: Rate limit for user creation (expensive operation, prevents spam)
const createUserRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Max 10 user creations per hour per IP
  message: 'Too many user creation attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('[SECURITY] User creation rate limit exceeded', {
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });
    res.status(429).json({
      error: 'Too many requests',
      message: 'Too many user creation attempts. Please try again later.'
    });
  }
});

/**
 * GET /api/v1/users
 * List all users (requires admin role)
 */
router.get('/', 
  jwtAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const result = await query<UserWithPermissions>(`
        SELECT 
          id, 
          username, 
          email, 
          role, 
          is_active as "isActive",
          created_at as "createdAt",
          last_login_at as "lastLoginAt"
        FROM users
        ORDER BY created_at DESC
      `);

      res.json(result.rows);
    } catch (error) {
      logger.error('List users error:', error);
      res.status(500).json({ 
        error: 'Internal server error',
        requestId: req.id || 'unknown'
      });
    }
  }
);

/**
 * GET /api/v1/users/:id
 * Get single user details (requires admin role)
 */
router.get('/:id',
  jwtAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const result = await query<UserWithPermissions>(`
        SELECT 
          id, 
          username, 
          email, 
          role, 
          is_active as "isActive",
          created_at as "createdAt",
          last_login_at as "lastLoginAt"
        FROM users
        WHERE id = $1
      `, [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json(result.rows[0]);
    } catch (error) {
      logger.error('Get user error:', error);
      res.status(500).json({ 
        error: 'Internal server error',
        requestId: req.id || 'unknown'
      });
    }
  }
);

/**
 * POST /api/v1/users
 * Create new user (requires admin role)
 * SECURITY: Rate limited to prevent abuse
 */
router.post('/',
  jwtAuth,
  requireRole('admin'),
  createUserRateLimit,
  async (req: Request, res: Response) => {
    try {
      const { username, email, password, role = ROLES.VIEWER } = req.body;

      // Validation
      if (!username || !email || !password) {
        return res.status(400).json({ 
          error: 'Missing required fields',
          required: ['username', 'email', 'password']
        });
      }

      // Only owner can create other owners
      if (role === ROLES.OWNER && req.user?.role !== ROLES.OWNER) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Only owners can create other owners'
        });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Create user
      const result = await query<UserWithPermissions>(`
        INSERT INTO users (username, email, password_hash, role)
        VALUES ($1, $2, $3, $4)
        RETURNING 
          id, 
          username, 
          email, 
          role, 
          is_active as "isActive",
          created_at as "createdAt"
      `, [username, email, passwordHash, role]);

      res.status(201).json(result.rows[0]);
    } catch (error: any) {
      logger.error('Create user error:', error);
      
      // Handle unique constraint violations
      if (error.code === '23505') {
        if (error.constraint === 'users_username_key') {
          return res.status(409).json({ error: 'Username already exists' });
        }
        if (error.constraint === 'users_email_key') {
          return res.status(409).json({ error: 'Email already exists' });
        }
      }

      res.status(500).json({ 
        error: 'Internal server error',
        requestId: req.id || 'unknown'
      });
    }
  }
);

/**
 * PUT /api/v1/users/:id
 * Update user (requires admin role)
 */
router.put('/:id',
  jwtAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { email, role, isActive } = req.body;

      // Get existing user
      const existing = await query(`SELECT * FROM users WHERE id = $1`, [id]);
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const existingUser = existing.rows[0];

      // Prevent modifying owner role unless you're an owner
      if (existingUser.role === ROLES.OWNER && req.user?.role !== ROLES.OWNER) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Only owners can modify other owners'
        });
      }

      // Prevent setting role to owner unless you're an owner
      if (role === ROLES.OWNER && req.user?.role !== ROLES.OWNER) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Only owners can promote users to owner'
        });
      }

      // Build update query
      const updates: string[] = [];
      const values: any[] = [];
      let paramCount = 1;

      if (email !== undefined) {
        updates.push(`email = $${paramCount++}`);
        values.push(email);
      }

      if (role !== undefined) {
        updates.push(`role = $${paramCount++}`);
        values.push(role);
      }

      if (isActive !== undefined) {
        updates.push(`is_active = $${paramCount++}`);
        values.push(isActive);
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      updates.push(`updated_at = NOW()`);
      values.push(id);

      const result = await query<UserWithPermissions>(`
        UPDATE users
        SET ${updates.join(', ')}
        WHERE id = $${paramCount}
        RETURNING 
          id, 
          username, 
          email, 
          role, 
          is_active as "isActive",
          created_at as "createdAt",
          last_login_at as "lastLoginAt"
      `, values);

      res.json(result.rows[0]);
    } catch (error: any) {
      logger.error('Update user error:', error);

      if (error.code === '23505') {
        if (error.constraint === 'users_email_key') {
          return res.status(409).json({ error: 'Email already exists' });
        }
      }

      res.status(500).json({ 
        error: 'Failed to update user',
        message: error.message
      });
    }
  }
);

/**
 * DELETE /api/v1/users/:id
 * Delete user (requires admin role)
 */
router.delete('/:id',
  jwtAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Get existing user
      const existing = await query(`SELECT * FROM users WHERE id = $1`, [id]);
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const existingUser = existing.rows[0];

      // Prevent deleting owner unless you're an owner
      if (existingUser.role === ROLES.OWNER && req.user?.role !== ROLES.OWNER) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Only owners can delete other owners'
        });
      }

      // Prevent deleting yourself
      if (parseInt(id) === req.user?.id) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Cannot delete your own account'
        });
      }

      // Delete user (CASCADE will handle refresh_tokens and user_sessions)
      await query(`DELETE FROM users WHERE id = $1`, [id]);

      res.status(204).send();
    } catch (error) {
      logger.error('Delete user error:', error);
      res.status(500).json({ 
        error: 'Failed to delete user',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

/**
 * GET /api/v1/users/me/permissions
 * Get current user's permissions
 */
router.get('/me/permissions',
  jwtAuth,
  async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { ROLE_PERMISSIONS } = await import('../types/permissions');
    const permissions = ROLE_PERMISSIONS[req.user.role as any] || [];

    res.json({
      user: req.user,
      permissions,
      role: req.user.role
    });
  }
);

export default router;
