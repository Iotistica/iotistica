/**
 * Authentication Routes
 *
 * Handles user registration, login, logout, token refresh, and password management.
 */
import crypto from 'crypto';
import type { FastifyPluginAsync } from 'fastify';
import { fetch } from 'undici';
import { query } from '../db/connection';
import { jwtAuth, requireRole } from '../middleware/jwt-auth';
import { clearMqttAuthCaches } from '../mqtt/auth-cache';
import * as authService from '../services/auth/auth.service';
import logger from '../utils/logger';
import { hashPassword } from '../utils/secret-hashing';

type IdParams = {
  id: string;
};

type RegisterBody = {
  username?: string;
  email?: string;
  password?: string;
  fullName?: string;
};

type LoginBody = {
  username?: string;
  password?: string;
};

type BootstrapAdminBody = {
  password?: string;
  email?: string;
};

type RefreshBody = {
  refreshToken?: string;
};

type LogoutBody = {
  refreshToken?: string;
};

type ChangePasswordBody = {
  currentPassword?: string;
  newPassword?: string;
};

type ResetPasswordBody = {
  token?: string;
  customerId?: string;
  password?: string;
};

type MqttUserCreateBody = {
  username?: string;
  password?: string;
  is_superuser?: boolean;
  is_active?: boolean;
};

type MqttUserUpdateBody = {
  password?: string;
  is_superuser?: boolean;
  is_active?: boolean;
};

type MqttAclCreateBody = {
  topic?: string;
  access?: number;
  priority?: number;
};

type MqttAclUpdateBody = {
  topic?: string;
  access?: number;
  priority?: number;
};

type ApiKeyCreateBody = {
  name?: string;
  description?: string | null;
  expires_at?: string | null;
};

type ValidateResetTokenResponse = {
  data: {
    username: string;
  };
};

type MqttUserRow = {
  id: number;
  username: string;
  is_superuser: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type MqttAclRow = {
  id: number;
  username: string;
  topic: string;
  access: number;
  priority: number;
  created_at: string;
};

type UsernameRow = {
  username: string;
};

type ApiKeyRow = {
  id: number;
  name: string;
  key: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
};

function getHeaderValue(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) {
    return header[0];
  }

  return header;
}

function isAccessValue(value: unknown): value is 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3;
}

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: RegisterBody }>('/register', async (req, reply) => {
    try {
      const { username, email, password, fullName } = req.body;

      if (!username || !email || !password) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Username, email, and password are required',
        });
      }

      const result = await authService.registerUser({
        username,
        email,
        password,
        fullName,
        role: 'viewer',
      });

      reply.status(201).send({
        message: 'User registered successfully',
        data: result,
      });
    } catch (error: any) {
      logger.error('Registration error', { error: error.message, stack: error.stack });

      if (error.message.includes('already exists')
        || error.message.includes('at least')
        || error.message.includes('required')) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: error.message,
        });
      }

      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Registration failed',
      });
    }
  });

  fastify.post<{ Body: LoginBody }>('/login', async (req, reply) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Username and password are required',
        });
      }

      const ipAddress = req.ip || req.socket.remoteAddress;
      const userAgent = getHeaderValue(req.headers['user-agent']);

      const result = await authService.loginUser(username, password, ipAddress, userAgent);

      reply.status(200).send({
        message: 'Login successful',
        data: result,
      });
    } catch (error: any) {
      logger.error('Login error', { error: error.message, stack: error.stack });

      if (error.message.includes('Invalid') || error.message.includes('inactive')) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: error.message,
        });
      }

      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Login failed',
      });
    }
  });

  fastify.post<{ Body: BootstrapAdminBody }>('/bootstrap-admin', async (req, reply) => {
    try {
      const configuredToken = process.env.INITIAL_ADMIN_BOOTSTRAP_TOKEN;
      if (!configuredToken) {
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: 'Bootstrap token is not configured on this instance',
        });
      }

      const requestToken = getHeaderValue(req.headers['x-bootstrap-token']);
      if (!requestToken || requestToken !== configuredToken) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid bootstrap token',
        });
      }

      const { password, email } = req.body;
      if (!password) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'password is required',
        });
      }

      await authService.bootstrapAdminPassword(password, email);

      reply.status(200).send({
        message: 'Admin bootstrap password set successfully',
        data: {
          mustChangePassword: true,
        },
      });
    } catch (error: any) {
      logger.error('Bootstrap admin error', { error: error.message, stack: error.stack });

      if (error.message.includes('at least')
        || error.message.includes('required')
        || error.message.includes('not found')
        || error.message.includes('Valid email')) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: error.message,
        });
      }

      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Bootstrap admin failed',
      });
    }
  });

  fastify.post<{ Body: RefreshBody }>('/refresh', async (req, reply) => {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Refresh token is required',
        });
      }

      const ipAddress = req.ip || req.socket.remoteAddress;
      const result = await authService.refreshAccessToken(refreshToken, ipAddress);

      reply.status(200).send({
        message: 'Token refreshed successfully',
        data: result,
      });
    } catch (error: any) {
      logger.error('Token refresh error', { error: error.message, stack: error.stack });

      reply.status(401).send({
        error: 'Unauthorized',
        message: error.message,
      });
    }
  });

  fastify.post<{ Body: LogoutBody }>('/logout', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      if (!req.user) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }

      const { refreshToken } = req.body;
      await authService.logoutUser(req.user.id, refreshToken);

      reply.status(200).send({
        message: 'Logged out successfully',
      });
    } catch (error: any) {
      logger.error('Logout error', { error: error.message, stack: error.stack });

      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Logout failed',
      });
    }
  });

  fastify.post<{ Body: ChangePasswordBody }>('/change-password', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      if (!req.user) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }

      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Current password and new password are required',
        });
      }

      await authService.changePassword(req.user.id, currentPassword, newPassword);

      reply.status(200).send({
        message: 'Password changed successfully. Please login again with your new password.',
      });
    } catch (error: any) {
      logger.error('Password change error', { error: error.message, stack: error.stack });

      if (error.message.includes('incorrect') || error.message.includes('at least')) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: error.message,
        });
      }

      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Password change failed',
      });
    }
  });

  fastify.post<{ Body: ResetPasswordBody }>('/reset-password', async (req, reply) => {
    try {
      const { token, customerId, password } = req.body;

      if (!token || !customerId || !password) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Token, customerId, and password are required',
        });
      }

      if (password.length < 12) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Password must be at least 12 characters',
        });
      }

      const provisioningApiUrl = process.env.PROVISIONING_API_URL || 'http://localhost:3100';
      let validationResponse: ValidateResetTokenResponse;

      try {
        const resp = await fetch(`${provisioningApiUrl}/api/auth/validate-reset-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, customerId }),
        });

        if (!resp.ok) {
          let errData: { message?: string } = {};
          try {
            errData = await resp.json() as { message?: string };
          } catch {
            errData = {};
          }

          const err = new Error(errData.message || 'Token validation failed') as Error & { status?: number };
          err.status = resp.status;
          throw err;
        }

        validationResponse = await resp.json() as ValidateResetTokenResponse;
      } catch (error: any) {
        logger.error('Token validation failed', { error: error.message, stack: error.stack });

        const status = error.status || 500;
        const message = error.message || 'Token validation failed';

        return reply.status(status).send({
          error: status === 400 ? 'Bad Request' : 'Internal Server Error',
          message,
        });
      }

      const { username } = validationResponse.data;
      const ipAddress = req.ip || req.socket.remoteAddress;
      await authService.setPasswordFromReset(username, password, ipAddress);

      try {
        await fetch(`${provisioningApiUrl}/api/auth/mark-token-used`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, customerId }),
        });
      } catch (error: any) {
        logger.error('Failed to mark token as used', { error: error.message, stack: error.stack });
      }

      reply.status(200).send({
        message: 'Initial password set successfully. You can now login.',
        data: { username },
      });
    } catch (error: any) {
      logger.error('Set initial password error', { error: error.message, stack: error.stack });

      if (error.message.includes('at least') || error.message.includes('not found')) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: error.message,
        });
      }

      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to set password',
      });
    }
  });

  fastify.get('/me', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      if (!req.user) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }

      const instanceId = process.env.NODERED_INSTANCE_ID || 'default';
      const mqttBrokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://mosquitto:1883';
      const mqttUsername = process.env.MQTT_USERNAME || `nodered_${instanceId}`;
      const mqttPassword = process.env.MQTT_PASSWORD;

      if (!mqttPassword) {
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'MQTT credentials not configured. Please check server configuration.',
        });
      }

      reply.status(200).send({
        data: {
          user: {
            ...req.user,
            brokerClient: {
              url: mqttBrokerUrl,
              username: mqttUsername,
              password: mqttPassword,
            },
          },
        },
      });
    } catch (error: any) {
      logger.error('Get user error', { error: error.message, stack: error.stack });
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to get user info',
      });
    }
  });

  fastify.get('/mqtt-users', { preHandler: [jwtAuth, requireRole('admin')] }, async (_req, reply) => {
    try {
      const usersResult = await query<MqttUserRow>(
        `SELECT id, username, is_superuser, is_active, created_at, updated_at
         FROM mqtt_users
         ORDER BY created_at DESC`
      );

      const users = await Promise.all(usersResult.rows.map(async (user) => {
        const aclsResult = await query<MqttAclRow>(
          `SELECT id, topic, access, priority, created_at, username
           FROM mqtt_acls
           WHERE username = $1
           ORDER BY priority DESC, topic ASC`,
          [user.username]
        );

        return {
          ...user,
          acls: aclsResult.rows,
        };
      }));

      reply.status(200).send({
        success: true,
        users,
      });
    } catch (error: any) {
      logger.error('Get MQTT users error', { error: error.message, stack: error.stack });
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to fetch MQTT users',
      });
    }
  });

  fastify.post<{ Body: MqttUserCreateBody }>('/mqtt-users', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const { username, password, is_superuser = false, is_active = true } = req.body;

      if (!username || !password) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Username and password are required',
        });
      }

      const passwordHash = await hashPassword(password);
      const result = await query<MqttUserRow>(
        `INSERT INTO mqtt_users (username, password_hash, is_superuser, is_active)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, is_superuser, is_active, created_at, updated_at`,
        [username, passwordHash, is_superuser, is_active]
      );
      await clearMqttAuthCaches();

      reply.status(201).send({
        success: true,
        message: 'MQTT user created successfully',
        user: result.rows[0],
      });
    } catch (error: any) {
      logger.error('Create MQTT user error', { error: error.message, stack: error.stack, code: error.code });

      if (error.message?.includes('duplicate') || error.code === '23505') {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Username already exists',
        });
      }

      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to create MQTT user',
      });
    }
  });

  fastify.put<{ Params: IdParams; Body: MqttUserUpdateBody }>('/mqtt-users/:id', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const { password, is_superuser, is_active } = req.body;

      const updates: string[] = [];
      const values: Array<string | boolean> = [];
      let paramIndex = 1;

      if (password) {
        const passwordHash = await hashPassword(password);
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
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'No fields to update',
        });
      }

      updates.push('updated_at = CURRENT_TIMESTAMP');

      const result = await query<MqttUserRow>(
        `UPDATE mqtt_users
         SET ${updates.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING id, username, is_superuser, is_active, created_at, updated_at`,
        [...values, id]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'MQTT user not found',
        });
      }

      await clearMqttAuthCaches();

      reply.status(200).send({
        success: true,
        message: 'MQTT user updated successfully',
        user: result.rows[0],
      });
    } catch (error: any) {
      logger.error('Update MQTT user error', { error: error.message, stack: error.stack });
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to update MQTT user',
      });
    }
  });

  fastify.delete<{ Params: IdParams }>('/mqtt-users/:id', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const { id } = req.params;

      const userResult = await query<UsernameRow>('SELECT username FROM mqtt_users WHERE id = $1', [id]);
      if (userResult.rows.length === 0) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'MQTT user not found',
        });
      }

      const username = userResult.rows[0].username;
      await query('DELETE FROM mqtt_acls WHERE username = $1', [username]);
      await query('DELETE FROM mqtt_users WHERE id = $1', [id]);
      await clearMqttAuthCaches();

      reply.status(200).send({
        success: true,
        message: 'MQTT user deleted successfully',
      });
    } catch (error: any) {
      logger.error('Delete MQTT user error', { error: error.message, stack: error.stack });
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to delete MQTT user',
      });
    }
  });

  fastify.post<{ Params: IdParams; Body: MqttAclCreateBody }>('/mqtt-users/:id/acls', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const { topic, access, priority = 0 } = req.body;

      if (!topic || access === undefined) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Topic and access are required',
        });
      }

      if (!isAccessValue(access)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Access must be 1 (read), 2 (write), or 3 (read+write)',
        });
      }

      const userResult = await query<UsernameRow>('SELECT username FROM mqtt_users WHERE id = $1', [id]);
      if (userResult.rows.length === 0) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'MQTT user not found',
        });
      }

      const username = userResult.rows[0].username;
      const result = await query<MqttAclRow>(
        `INSERT INTO mqtt_acls (username, topic, access, priority)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, topic, access, priority, created_at`,
        [username, topic, access, priority]
      );
      await clearMqttAuthCaches();

      reply.status(201).send({
        success: true,
        message: 'ACL rule created successfully',
        acl: result.rows[0],
      });
    } catch (error: any) {
      logger.error('Create ACL error', { error: error.message, stack: error.stack });
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to create ACL rule',
      });
    }
  });

  fastify.put<{ Params: IdParams; Body: MqttAclUpdateBody }>('/mqtt-acls/:id', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const { topic, access, priority } = req.body;

      const updates: string[] = [];
      const values: Array<string | number> = [];
      let paramIndex = 1;

      if (topic) {
        updates.push(`topic = $${paramIndex++}`);
        values.push(topic);
      }

      if (access !== undefined) {
        if (!isAccessValue(access)) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Access must be 1 (read), 2 (write), or 3 (read+write)',
          });
        }
        updates.push(`access = $${paramIndex++}`);
        values.push(access);
      }

      if (priority !== undefined) {
        updates.push(`priority = $${paramIndex++}`);
        values.push(priority);
      }

      if (updates.length === 0) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'No fields to update',
        });
      }

      const result = await query<MqttAclRow>(
        `UPDATE mqtt_acls
         SET ${updates.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING id, username, topic, access, priority, created_at`,
        [...values, id]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'ACL rule not found',
        });
      }

      await clearMqttAuthCaches();

      reply.status(200).send({
        success: true,
        message: 'ACL rule updated successfully',
        acl: result.rows[0],
      });
    } catch (error: any) {
      logger.error('Update ACL error', { error: error.message, stack: error.stack });
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to update ACL rule',
      });
    }
  });

  fastify.delete<{ Params: IdParams }>('/mqtt-acls/:id', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const result = await query<{ id: number }>('DELETE FROM mqtt_acls WHERE id = $1 RETURNING id', [id]);

      if (result.rows.length === 0) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'ACL rule not found',
        });
      }

      await clearMqttAuthCaches();

      reply.status(200).send({
        success: true,
        message: 'ACL rule deleted successfully',
      });
    } catch (error: any) {
      logger.error('Delete ACL error', { error: error.message, stack: error.stack });
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to delete ACL rule',
      });
    }
  });

  fastify.get('/api-keys', { preHandler: [jwtAuth, requireRole('admin')] }, async (_req, reply) => {
    try {
      const result = await query<ApiKeyRow>(
        `SELECT id, name, key, description, is_active, created_at, expires_at, last_used_at
         FROM api_keys
         ORDER BY created_at DESC`
      );

      const keys = result.rows.map((row) => ({
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

      reply.status(200).send({ success: true, keys });
    } catch (error: any) {
      logger.error('List API keys error', { error: error.message, stack: error.stack });
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to fetch API keys',
      });
    }
  });

  fastify.post<{ Body: ApiKeyCreateBody }>('/api-keys', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const { name, description = null, expires_at = null } = req.body;

      if (!name || typeof name !== 'string' || !name.trim()) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Name is required',
        });
      }

      const key = crypto.randomBytes(32).toString('hex');
      const result = await query<ApiKeyRow>(
        `INSERT INTO api_keys (name, key, description, is_active, expires_at)
         VALUES ($1, $2, $3, true, $4)
         RETURNING id, name, key, description, is_active, created_at, expires_at, last_used_at`,
        [name.trim(), key, description, expires_at || null]
      );

      const created = result.rows[0];

      reply.status(201).send({
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
        },
      });
    } catch (error: any) {
      logger.error('Create API key error', { error: error.message, stack: error.stack, code: error.code });

      if (error.code === '23505') {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'API key name already exists',
        });
      }

      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to create API key',
      });
    }
  });

  fastify.delete<{ Params: IdParams }>('/api-keys/:id', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const result = await query<{ id: number }>(
        `UPDATE api_keys
         SET is_active = false
         WHERE id = $1
         RETURNING id`,
        [id]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'API key not found',
        });
      }

      reply.status(200).send({
        success: true,
        message: 'API key revoked successfully',
      });
    } catch (error: any) {
      logger.error('Revoke API key error', { error: error.message, stack: error.stack });
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to revoke API key',
      });
    }
  });
};

export default plugin;