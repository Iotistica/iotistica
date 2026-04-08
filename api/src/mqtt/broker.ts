import { X509Certificate } from 'crypto';
import type { FastifyPluginAsync } from 'fastify';
import poolWrapper from '../db/connection';
import { jwtAuth, requireRole } from '../middleware/jwt-auth';
import { logger } from '../utils/logger';
import { hashPassword } from '../utils/secret-hashing';

interface BrokerIdParams {
  id: string;
}

interface BrokerBody {
  name?: string;
  description?: string | null;
  protocol?: string;
  host?: string;
  port?: number;
  username?: string | null;
  password?: string;
  use_tls?: boolean;
  ca_cert?: string | null;
  client_cert?: string | null;
  client_key?: string | null;
  verify_certificate?: boolean;
  client_id_prefix?: string;
  keep_alive?: number;
  clean_session?: boolean;
  reconnect_period?: number;
  connect_timeout?: number;
  is_active?: boolean;
  is_default?: boolean;
  broker_type?: string;
  extra_config?: Record<string, unknown>;
}

interface BrokerConfigRow {
  id: number;
  name: string;
  description: string | null;
  protocol: string;
  host: string;
  port: number;
  username: string | null;
  use_tls: boolean;
  ca_cert?: string | null;
  client_cert?: string | null;
  verify_certificate?: boolean;
  client_id_prefix: string;
  keep_alive: number;
  clean_session: boolean;
  reconnect_period: number;
  connect_timeout: number;
  is_active: boolean;
  is_default: boolean;
  broker_type: string;
  extra_config: Record<string, unknown> | null;
  created_at: string;
  updated_at?: string;
  last_connected_at?: string | null;
}

interface ExistingBrokerRow {
  id: number;
  is_default: boolean;
}

interface DeviceCountRow {
  count: string;
}

interface DeletedBrokerRow {
  id: number;
  name: string;
}

interface TestBrokerRow {
  protocol: string;
  host: string;
  port: number;
  username: string | null;
  password_hash: string | null;
  use_tls: boolean;
}

const plugin: FastifyPluginAsync = async (fastify) => {
  const pool = poolWrapper.pool;

  function validateCertificate(certPEM: string): { valid: boolean; error?: string } {
    try {
      if (!certPEM || typeof certPEM !== 'string') {
        return { valid: false, error: 'Certificate must be a non-empty string' };
      }

      if (!certPEM.includes('-----BEGIN CERTIFICATE-----') || !certPEM.includes('-----END CERTIFICATE-----')) {
        return { valid: false, error: 'Invalid PEM format - must contain BEGIN/END CERTIFICATE markers' };
      }

      const cert = new X509Certificate(certPEM);
      const expiryDate = new Date(cert.validTo);
      if (expiryDate < new Date()) {
        return { valid: false, error: `Certificate expired on ${expiryDate.toISOString()}` };
      }

      if (!cert.subject || cert.subject.length === 0) {
        return { valid: false, error: 'Certificate has no subject' };
      }

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: `Invalid certificate: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  fastify.get('/brokers', { preHandler: [jwtAuth] }, async (_req, reply) => {
    try {
      const result = await pool.query<BrokerConfigRow>(`
        SELECT 
          id,
          name,
          description,
          protocol,
          host,
          port,
          username,
          use_tls,
          client_id_prefix,
          keep_alive,
          clean_session,
          reconnect_period,
          connect_timeout,
          is_active,
          is_default,
          broker_type,
          extra_config,
          created_at,
          updated_at,
          last_connected_at
        FROM mqtt_broker_config
        ORDER BY is_default DESC, name ASC
      `);

      return reply.send({ success: true, data: result.rows, count: result.rows.length });
    } catch (error) {
      logger.error('Error fetching broker configurations:', error);
      return reply.status(500).send({ success: false, error: 'Failed to fetch broker configurations' });
    }
  });

  fastify.get('/brokers/summary', { preHandler: [jwtAuth] }, async (_req, reply) => {
    try {
      const result = await pool.query('SELECT * FROM mqtt_broker_summary ORDER BY is_default DESC, name ASC');
      return reply.send({ success: true, data: result.rows, count: result.rows.length });
    } catch (error) {
      logger.error('Error fetching broker summary:', error);
      return reply.status(500).send({ success: false, error: 'Failed to fetch broker summary' });
    }
  });

  fastify.get<{ Params: BrokerIdParams }>('/brokers/:id', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const result = await pool.query<BrokerConfigRow>(`
        SELECT 
          id,
          name,
          description,
          protocol,
          host,
          port,
          username,
          use_tls,
          ca_cert,
          client_cert,
          verify_certificate,
          client_id_prefix,
          keep_alive,
          clean_session,
          reconnect_period,
          connect_timeout,
          is_active,
          is_default,
          broker_type,
          extra_config,
          created_at,
          updated_at,
          last_connected_at
        FROM mqtt_broker_config
        WHERE id = $1
      `, [id]);

      if (result.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Broker configuration not found' });
      }

      return reply.send({ success: true, data: result.rows[0] });
    } catch (error) {
      logger.error('Error fetching broker configuration:', error);
      return reply.status(500).send({ success: false, error: 'Failed to fetch broker configuration' });
    }
  });

  fastify.post<{ Body: BrokerBody }>('/brokers', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const {
        name,
        description,
        protocol = 'mqtt',
        host,
        port,
        username,
        password,
        use_tls = false,
        ca_cert,
        client_cert,
        client_key,
        verify_certificate = true,
        client_id_prefix = 'Iotistic',
        keep_alive = 60,
        clean_session = true,
        reconnect_period = 1000,
        connect_timeout = 30000,
        is_active = true,
        is_default = false,
        broker_type = 'local',
        extra_config = {},
      } = req.body;

      if (!name || !host || !port) {
        return reply.status(400).send({ success: false, error: 'Missing required fields: name, host, port' });
      }

      if (use_tls) {
        if (ca_cert) {
          const caValidation = validateCertificate(ca_cert);
          if (!caValidation.valid) {
            return reply.status(400).send({ success: false, error: 'Invalid CA certificate', details: caValidation.error });
          }
        }

        if (client_cert) {
          const clientCertValidation = validateCertificate(client_cert);
          if (!clientCertValidation.valid) {
            return reply.status(400).send({ success: false, error: 'Invalid client certificate', details: clientCertValidation.error });
          }
        }

        if (client_key && (!client_key.includes('-----BEGIN') || !client_key.includes('-----END'))) {
          return reply.status(400).send({ success: false, error: 'Invalid client key format - must be in PEM format' });
        }
      }

      const password_hash = password ? await hashPassword(password) : null;

      if (is_default) {
        await pool.query('UPDATE mqtt_broker_config SET is_default = false WHERE is_default = true');
      }

      const result = await pool.query<BrokerConfigRow>(`
        INSERT INTO mqtt_broker_config (
          name, description, protocol, host, port, username, password_hash,
          use_tls, ca_cert, client_cert, client_key, verify_certificate,
          client_id_prefix, keep_alive, clean_session, reconnect_period, connect_timeout,
          is_active, is_default, broker_type, extra_config
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
        ) RETURNING 
          id, name, description, protocol, host, port, username, use_tls,
          client_id_prefix, keep_alive, clean_session, reconnect_period, connect_timeout,
          is_active, is_default, broker_type, extra_config, created_at
      `, [
        name, description, protocol, host, port, username, password_hash,
        use_tls, ca_cert, client_cert, client_key, verify_certificate,
        client_id_prefix, keep_alive, clean_session, reconnect_period, connect_timeout,
        is_active, is_default, broker_type, JSON.stringify(extra_config),
      ]);

      logger.info('MQTT broker configuration created', { name, host, port, userId: req.user?.id });
      return reply.status(201).send({
        success: true,
        message: 'Broker configuration created successfully',
        data: result.rows[0],
      });
    } catch (error) {
      logger.error('Error creating broker configuration:', error);
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        return reply.status(409).send({ success: false, error: 'A broker configuration with this name already exists' });
      }

      return reply.status(500).send({
        success: false,
        error: 'Internal server error',
        requestId: req.id || 'unknown',
      });
    }
  });

  fastify.put<{ Params: BrokerIdParams; Body: BrokerBody }>('/brokers/:id', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const {
        name,
        description,
        protocol,
        host,
        port,
        username,
        password,
        use_tls,
        ca_cert,
        client_cert,
        client_key,
        verify_certificate,
        client_id_prefix,
        keep_alive,
        clean_session,
        reconnect_period,
        connect_timeout,
        is_active,
        is_default,
        broker_type,
        extra_config,
      } = req.body;

      const existing = await pool.query<ExistingBrokerRow>(
        'SELECT id, is_default FROM mqtt_broker_config WHERE id = $1',
        [id],
      );

      if (existing.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Broker configuration not found' });
      }

      if (is_default && !existing.rows[0].is_default) {
        await pool.query('UPDATE mqtt_broker_config SET is_default = false WHERE is_default = true AND id != $1', [id]);
      }

      if (use_tls !== undefined && use_tls) {
        if (ca_cert) {
          const caValidation = validateCertificate(ca_cert);
          if (!caValidation.valid) {
            return reply.status(400).send({ success: false, error: 'Invalid CA certificate', details: caValidation.error });
          }
        }

        if (client_cert) {
          const clientCertValidation = validateCertificate(client_cert);
          if (!clientCertValidation.valid) {
            return reply.status(400).send({ success: false, error: 'Invalid client certificate', details: clientCertValidation.error });
          }
        }

        if (client_key && (!client_key.includes('-----BEGIN') || !client_key.includes('-----END'))) {
          return reply.status(400).send({ success: false, error: 'Invalid client key format - must be in PEM format' });
        }
      }

      const updates: string[] = [];
      const values: Array<string | number | boolean | null> = [];
      let paramIndex = 1;

      const addUpdate = (field: string, value: string | number | boolean | null | undefined) => {
        if (value !== undefined) {
          updates.push(`${field} = $${paramIndex}`);
          values.push(value);
          paramIndex += 1;
        }
      };

      addUpdate('name', name);
      addUpdate('description', description ?? null);
      addUpdate('protocol', protocol);
      addUpdate('host', host);
      addUpdate('port', port);
      addUpdate('username', username ?? null);

      if (password) {
        addUpdate('password_hash', await hashPassword(password));
      }

      addUpdate('use_tls', use_tls);
      addUpdate('ca_cert', ca_cert ?? null);
      addUpdate('client_cert', client_cert ?? null);
      addUpdate('client_key', client_key ?? null);
      addUpdate('verify_certificate', verify_certificate);
      addUpdate('client_id_prefix', client_id_prefix);
      addUpdate('keep_alive', keep_alive);
      addUpdate('clean_session', clean_session);
      addUpdate('reconnect_period', reconnect_period);
      addUpdate('connect_timeout', connect_timeout);
      addUpdate('is_active', is_active);
      addUpdate('is_default', is_default);
      addUpdate('broker_type', broker_type);

      if (extra_config !== undefined) {
        addUpdate('extra_config', JSON.stringify(extra_config));
      }

      if (updates.length === 0) {
        return reply.status(400).send({ success: false, error: 'No fields to update' });
      }

      values.push(id);
      const result = await pool.query<BrokerConfigRow>(`
        UPDATE mqtt_broker_config 
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING 
          id, name, description, protocol, host, port, username, use_tls,
          client_id_prefix, keep_alive, clean_session, reconnect_period, connect_timeout,
          is_active, is_default, broker_type, extra_config, created_at, updated_at
      `, values);

      return reply.send({
        success: true,
        message: 'Broker configuration updated successfully',
        data: result.rows[0],
      });
    } catch (error) {
      logger.error('Error updating broker configuration:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userId: req.user?.id,
      });

      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        return reply.status(409).send({ success: false, error: 'A broker configuration with this name already exists' });
      }

      return reply.status(500).send({
        success: false,
        error: 'Internal server error',
        requestId: req.id || 'unknown',
      });
    }
  });

  fastify.delete<{ Params: BrokerIdParams }>('/brokers/:id', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const deviceCheck = await pool.query<DeviceCountRow>(
        'SELECT COUNT(*) as count FROM agents WHERE mqtt_broker_id = $1',
        [id],
      );

      if (parseInt(deviceCheck.rows[0].count, 10) > 0) {
        return reply.status(409).send({
          success: false,
          error: 'Cannot delete broker configuration that is in use by agents',
          agents_count: deviceCheck.rows[0].count,
        });
      }

      const result = await pool.query<DeletedBrokerRow>(
        'DELETE FROM mqtt_broker_config WHERE id = $1 RETURNING id, name',
        [id],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Broker configuration not found' });
      }

      return reply.send({
        success: true,
        message: `Broker configuration "${result.rows[0].name}" deleted successfully`,
      });
    } catch (error) {
      logger.error('Error deleting broker configuration:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userId: req.user?.id,
      });
      return reply.status(500).send({
        success: false,
        error: 'Internal server error',
        requestId: req.id || 'unknown',
      });
    }
  });

  fastify.post<{ Params: BrokerIdParams }>('/brokers/:id/test', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const result = await pool.query<TestBrokerRow>(`
        SELECT protocol, host, port, username, password_hash, use_tls
        FROM mqtt_broker_config
        WHERE id = $1
      `, [id]);

      if (result.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Broker configuration not found' });
      }

      const broker = result.rows[0];
      return reply.send({
        success: true,
        message: 'Connection test endpoint (implementation pending)',
        broker: {
          protocol: broker.protocol,
          host: broker.host,
          port: broker.port,
          username: broker.username,
          has_password: !!broker.password_hash,
          use_tls: broker.use_tls,
        },
      });
    } catch (error) {
      logger.error('Error testing broker connection:', error);
      return reply.status(500).send({ success: false, error: 'Failed to test broker connection' });
    }
  });
};

export default plugin;