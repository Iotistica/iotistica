/**
 * User Management Routes
 * 
 * Handles CRUD operations for dashboard users with role-based permissions
 */

import { query } from '../db/connection';
import { jwtAuth, requireRole } from '../middleware/jwt-auth';
import { ROLE_PERMISSIONS, ROLES, type Role, UserWithPermissions } from '../types/permissions';
import { logger } from '../utils/logger';
import type { FastifyPluginAsync } from 'fastify'
import { hashPassword } from '../utils/secret-hashing';

interface UserIdParams {
  id: string;
}

interface CreateUserBody {
  username?: string;
  email?: string;
  password?: string;
  role?: Role;
}

interface UpdateUserBody {
  email?: string;
  role?: Role;
  isActive?: boolean;
}

interface ExistingUserRow {
  id: number;
  role: Role;
}

const plugin: FastifyPluginAsync = async (fastify) => {



/**
 * GET /api/v1/users
 * List all users (requires admin role)
 */
fastify.get('/', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
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

      return reply.send(result.rows);
    } catch (error) {
      logger.error('List users error:', error);
      return reply.status(500).send({ 
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
fastify.get<{ Params: UserIdParams }>('/:id', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
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
        return reply.status(404).send({ error: 'User not found' });
      }

      return reply.send(result.rows[0]);
    } catch (error) {
      logger.error('Get user error:', error);
      return reply.status(500).send({ 
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
fastify.post<{ Body: CreateUserBody }>('/', {
  preHandler: [jwtAuth, requireRole('admin')],
  config: {
    rateLimit: {
      max: 5,
      timeWindow: '15 minutes'
    }
  }
}, async (req, reply) => {
    try {
      const { username, email, password, role = ROLES.VIEWER } = req.body;

      // Validation
      if (!username || !email || !password) {
        return reply.status(400).send({ 
          error: 'Missing required fields',
          required: ['username', 'email', 'password']
        });
      }

      // Only owner can create other owners
      if (role === ROLES.OWNER && req.user?.role !== ROLES.OWNER) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only owners can create other owners'
        });
      }

      // Hash password
      const passwordHash = await hashPassword(password);

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

      return reply.status(201).send(result.rows[0]);
    } catch (error: unknown) {
      logger.error('Create user error:', error);
      
      // Handle unique constraint violations
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        if ('constraint' in error && error.constraint === 'users_username_key') {
          return reply.status(409).send({ error: 'Username already exists' });
        }
        if ('constraint' in error && error.constraint === 'users_email_key') {
          return reply.status(409).send({ error: 'Email already exists' });
        }
      }

      return reply.status(500).send({ 
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
fastify.put<{ Params: UserIdParams; Body: UpdateUserBody }>('/:id', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const { email, role, isActive } = req.body;

      // Get existing user
      const existing = await query<ExistingUserRow>(`SELECT id, role FROM users WHERE id = $1`, [id]);
      if (existing.rows.length === 0) {
        return reply.status(404).send({ error: 'User not found' });
      }

      const existingUser = existing.rows[0];

      // Prevent modifying owner role unless you're an owner
      if (existingUser.role === ROLES.OWNER && req.user?.role !== ROLES.OWNER) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only owners can modify other owners'
        });
      }

      // Prevent setting role to owner unless you're an owner
      if (role === ROLES.OWNER && req.user?.role !== ROLES.OWNER) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only owners can promote users to owner'
        });
      }

      // Build update query
      const updates: string[] = [];
      const values: Array<string | boolean> = [];
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
        return reply.status(400).send({ error: 'No fields to update' });
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

      return reply.send(result.rows[0]);
    } catch (error: unknown) {
      logger.error('Update user error:', error);

      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        if ('constraint' in error && error.constraint === 'users_email_key') {
          return reply.status(409).send({ error: 'Email already exists' });
        }
      }

      return reply.status(500).send({ 
        error: 'Failed to update user',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

/**
 * DELETE /api/v1/users/:id
 * Delete user (requires admin role)
 */
fastify.delete<{ Params: UserIdParams }>('/:id', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const { id } = req.params;

      // Get existing user
      const existing = await query<ExistingUserRow>(`SELECT id, role FROM users WHERE id = $1`, [id]);
      if (existing.rows.length === 0) {
        return reply.status(404).send({ error: 'User not found' });
      }

      const existingUser = existing.rows[0];

      // Prevent deleting owner unless you're an owner
      if (existingUser.role === ROLES.OWNER && req.user?.role !== ROLES.OWNER) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only owners can delete other owners'
        });
      }

      // Prevent deleting yourself
      if (parseInt(id) === req.user?.id) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Cannot delete your own account'
        });
      }

      // Delete user (CASCADE will handle refresh_tokens and user_sessions)
      await query(`DELETE FROM users WHERE id = $1`, [id]);

      return reply.status(204).send();
    } catch (error) {
      logger.error('Delete user error:', error);
      return reply.status(500).send({ 
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
fastify.get('/me/permissions', { preHandler: [jwtAuth] }, async (req, reply) => {
    if (!req.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const permissions = ROLE_PERMISSIONS[req.user.role as Role] ?? [];

    return reply.send({
      user: req.user,
      permissions,
      role: req.user.role
    });
  }
);

};

export default plugin;