import { Router, Request, Response } from 'express';
import poolWrapper from '../db/connection';
import bcrypt from 'bcrypt';
import { X509Certificate } from 'crypto';
import { logger } from '../utils/logger';
import { jwtAuth, requireRole } from '../middleware/jwt-auth';

const pool = poolWrapper.pool;

const router = Router();

/**
 * Validate X.509 certificate
 * Checks for:
 * - Valid PEM format
 * - Not expired
 * - Proper certificate structure
 */
function validateCertificate(certPEM: string): { valid: boolean; error?: string } {
  try {
    if (!certPEM || typeof certPEM !== 'string') {
      return { valid: false, error: 'Certificate must be a non-empty string' };
    }

    if (!certPEM.includes('-----BEGIN CERTIFICATE-----') || !certPEM.includes('-----END CERTIFICATE-----')) {
      return { valid: false, error: 'Invalid PEM format - must contain BEGIN/END CERTIFICATE markers' };
    }

    const cert = new X509Certificate(certPEM);

    // Check expiration
    const expiryDate = new Date(cert.validTo);
    if (expiryDate < new Date()) {
      return { valid: false, error: `Certificate expired on ${expiryDate.toISOString()}` };
    }

    // Check that certificate has valid subject
    if (!cert.subject || cert.subject.length === 0) {
      return { valid: false, error: 'Certificate has no subject' };
    }

    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: `Invalid certificate: ${err.message}` };
  }
}

/**
 * GET /api/mqtt/brokers
 * List all MQTT broker configurations
 * 
 * REQUIRES AUTHENTICATION - Protected endpoint
 */
router.get('/brokers', jwtAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
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

    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    logger.error('Error fetching broker configurations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch broker configurations'
    });
  }
});

/**
 * GET /api/mqtt/brokers/summary
 * Get broker summary with device counts
 * 
 * REQUIRES AUTHENTICATION - Protected endpoint
 */
router.get('/brokers/summary', jwtAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT * FROM mqtt_broker_summary
      ORDER BY is_default DESC, name ASC
    `);

    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    logger.error('Error fetching broker summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch broker summary'
    });
  }
});

/**
 * GET /api/mqtt/brokers/:id
 * Get a single broker configuration by ID
 * 
 * REQUIRES AUTHENTICATION - Protected endpoint
 */
router.get('/brokers/:id', jwtAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
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
      return res.status(404).json({
        success: false,
        error: 'Broker configuration not found'
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    logger.error('Error fetching broker configuration:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch broker configuration'
    });
  }
});

/**
 * POST /api/mqtt/brokers
 * Create a new broker configuration
 * 
 * REQUIRES AUTHENTICATION - Protected endpoint
 * VALIDATES CERTIFICATES - All certificates must be valid X.509 certificates
 */
router.post('/brokers', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const {
      name,
      description,
      protocol = 'mqtt',
      host,
      port,
      username,
      password,  // Plain text password (will be hashed)
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
      extra_config = {}
    } = req.body;

    // Validate required fields
    if (!name || !host || !port) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name, host, port'
      });
    }

    // Validate certificates if TLS is enabled
    if (use_tls) {
      if (ca_cert) {
        const caValidation = validateCertificate(ca_cert);
        if (!caValidation.valid) {
          return res.status(400).json({
            success: false,
            error: 'Invalid CA certificate',
            details: caValidation.error
          });
        }
      }

      if (client_cert) {
        const clientCertValidation = validateCertificate(client_cert);
        if (!clientCertValidation.valid) {
          return res.status(400).json({
            success: false,
            error: 'Invalid client certificate',
            details: clientCertValidation.error
          });
        }
      }

      if (client_key) {
        // Basic validation that client key exists and has correct format
        if (!client_key.includes('-----BEGIN') || !client_key.includes('-----END')) {
          return res.status(400).json({
            success: false,
            error: 'Invalid client key format - must be in PEM format'
          });
        }
      }
    }

    // Hash password if provided
    let password_hash = null;
    if (password) {
      password_hash = await bcrypt.hash(password, 10);
    }

    // If setting as default, unset other defaults first
    if (is_default) {
      await pool.query(`
        UPDATE mqtt_broker_config 
        SET is_default = false 
        WHERE is_default = true
      `);
    }

    const result = await pool.query(`
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
      is_active, is_default, broker_type, JSON.stringify(extra_config)
    ]);

    logger.info('MQTT broker configuration created', {
      name,
      host,
      port,
      userId: (req as any).user?.id
    });

    res.status(201).json({
      success: true,
      message: 'Broker configuration created successfully',
      data: result.rows[0]
    });
  } catch (error: any) {
    logger.error('Error creating broker configuration:', error);
    
    if (error.code === '23505') {  // Unique violation
      return res.status(409).json({
        success: false,
        error: 'A broker configuration with this name already exists'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      requestId: (req as any).id || 'unknown'
    });
  }
});

/**
 * PUT /api/mqtt/brokers/:id
 * Update an existing broker configuration
 * 
 * REQUIRES AUTHENTICATION - Protected endpoint
 * VALIDATES CERTIFICATES - All certificates must be valid X.509 certificates
 */
router.put('/brokers/:id', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      protocol,
      host,
      port,
      username,
      password,  // Plain text password (will be hashed if provided)
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
      extra_config
    } = req.body;

    // Check if broker exists
    const existing = await pool.query(
      'SELECT id, is_default FROM mqtt_broker_config WHERE id = $1',
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Broker configuration not found'
      });
    }

    // If setting as default, unset other defaults first
    if (is_default && !existing.rows[0].is_default) {
      await pool.query(`
        UPDATE mqtt_broker_config 
        SET is_default = false 
        WHERE is_default = true AND id != $1
      `, [id]);
    }

    // Validate certificates if TLS is enabled or being updated
    if (use_tls !== undefined && use_tls) {
      if (ca_cert !== undefined && ca_cert) {
        const caValidation = validateCertificate(ca_cert);
        if (!caValidation.valid) {
          return res.status(400).json({
            success: false,
            error: 'Invalid CA certificate',
            details: caValidation.error
          });
        }
      }

      if (client_cert !== undefined && client_cert) {
        const clientCertValidation = validateCertificate(client_cert);
        if (!clientCertValidation.valid) {
          return res.status(400).json({
            success: false,
            error: 'Invalid client certificate',
            details: clientCertValidation.error
          });
        }
      }

      if (client_key !== undefined && client_key) {
        // Basic validation that client key exists and has correct format
        if (!client_key.includes('-----BEGIN') || !client_key.includes('-----END')) {
          return res.status(400).json({
            success: false,
            error: 'Invalid client key format - must be in PEM format'
          });
        }
      }
    }

    // Build dynamic UPDATE query
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    const addUpdate = (field: string, value: any) => {
      if (value !== undefined) {
        updates.push(`${field} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    };

    addUpdate('name', name);
    addUpdate('description', description);
    addUpdate('protocol', protocol);
    addUpdate('host', host);
    addUpdate('port', port);
    addUpdate('username', username);
    
    // Hash password if provided
    if (password) {
      const password_hash = await bcrypt.hash(password, 10);
      addUpdate('password_hash', password_hash);
    }
    
    addUpdate('use_tls', use_tls);
    addUpdate('ca_cert', ca_cert);
    addUpdate('client_cert', client_cert);
    addUpdate('client_key', client_key);
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
      return res.status(400).json({
        success: false,
        error: 'No fields to update'
      });
    }

    values.push(id);  // Add ID for WHERE clause
    const result = await pool.query(`
      UPDATE mqtt_broker_config 
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING 
        id, name, description, protocol, host, port, username, use_tls,
        client_id_prefix, keep_alive, clean_session, reconnect_period, connect_timeout,
        is_active, is_default, broker_type, extra_config, created_at, updated_at
    `, values);

    res.json({
      success: true,
      message: 'Broker configuration updated successfully',
      data: result.rows[0]
    });
  } catch (error: any) {
    logger.error('Error updating broker configuration:', { error: error.message, userId: (req as any).user?.id });
    
    if (error.code === '23505') {  // Unique violation
      return res.status(409).json({
        success: false,
        error: 'A broker configuration with this name already exists'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      requestId: (req as any).id || 'unknown'
    });
  }
});

/**
 * DELETE /api/mqtt/brokers/:id
 * Delete a broker configuration
 * 
 * REQUIRES AUTHENTICATION - Protected endpoint
 */
router.delete('/brokers/:id', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if any agents are using this broker
    const deviceCheck = await pool.query(
      'SELECT COUNT(*) as count FROM agents WHERE mqtt_broker_id = $1',
      [id]
    );

    if (parseInt(deviceCheck.rows[0].count) > 0) {
      return res.status(409).json({
        success: false,
        error: 'Cannot delete broker configuration that is in use by agents',
        agents_count: deviceCheck.rows[0].count
      });
    }

    const result = await pool.query(
      'DELETE FROM mqtt_broker_config WHERE id = $1 RETURNING id, name',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Broker configuration not found'
      });
    }

    res.json({
      success: true,
      message: `Broker configuration "${result.rows[0].name}" deleted successfully`
    });
  } catch (error: any) {
    logger.error('Error deleting broker configuration:', { error: error.message, userId: (req as any).user?.id });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      requestId: (req as any).id || 'unknown'
    });
  }
});

/**
 * POST /api/mqtt/brokers/:id/test
 * Test connection to a broker
 * 
 * REQUIRES AUTHENTICATION - Protected endpoint
 */
router.post('/brokers/:id/test', jwtAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT protocol, host, port, username, password_hash, use_tls
      FROM mqtt_broker_config
      WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Broker configuration not found'
      });
    }

    // TODO: Implement actual MQTT connection test
    // For now, just return the configuration details
    const broker = result.rows[0];
    
    res.json({
      success: true,
      message: 'Connection test endpoint (implementation pending)',
      broker: {
        protocol: broker.protocol,
        host: broker.host,
        port: broker.port,
        username: broker.username,
        has_password: !!broker.password_hash,
        use_tls: broker.use_tls
      }
    });
  } catch (error) {
    logger.error('Error testing broker connection:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to test broker connection'
    });
  }
});

export default router;
