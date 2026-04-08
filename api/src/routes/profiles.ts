/**
 * Profile Configuration Management Routes
 *
 * Replaces static dataPoints.json file with dynamic database-backed profile configs.
 * Allows adding/updating protocol profile configurations via API.
 *
 * Routes:
 * - GET    /api/v1/profiles?protocol=modbus - List all profiles for protocol
 * - GET    /api/v1/profiles/:name?protocol=modbus - Get specific profile config
 * - POST   /api/v1/profiles - Create/update profile config
 * - DELETE /api/v1/profiles/:name - Delete profile config
 */
import type { FastifyPluginAsync } from 'fastify';

import { query } from '../db/connection';
import { validateApiKey } from '../middleware/api-key-auth';
import { jwtAuth } from '../middleware/jwt-auth';
import { logger } from '../utils/logger';

interface ProfileRecord {
  profile_name: string;
  protocol: string;
  data_points: unknown[] | string;
  metadata: Record<string, unknown> | string | null;
  [key: string]: unknown;
}

interface ProtocolQuerystring {
  protocol?: string;
}

interface ProfileNameParams {
  name: string;
}

interface ProfileBody {
  profile_name?: string;
  protocol?: string;
  data_points?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

type DataPoint = Record<string, unknown>;

class ProfileConfigModel {
  static async get(profileName: string, protocol = 'modbus'): Promise<ProfileRecord | null> {
    const result = await query<ProfileRecord>(
      'SELECT * FROM profile_configs WHERE profile_name = $1 AND protocol = $2',
      [profileName, protocol]
    );
    return result.rows[0] || null;
  }

  static async listByProtocol(protocol: string): Promise<ProfileRecord[]> {
    const result = await query<ProfileRecord>(
      'SELECT * FROM profile_configs WHERE protocol = $1 ORDER BY profile_name',
      [protocol]
    );
    return result.rows;
  }

  static async upsert(
    profileName: string,
    protocol: string,
    dataPoints: unknown[],
    metadata?: Record<string, unknown>
  ): Promise<ProfileRecord> {
    const result = await query<ProfileRecord>(
      `INSERT INTO profile_configs (profile_name, protocol, data_points, metadata)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (profile_name, protocol) DO UPDATE SET
         data_points = $3,
         metadata = $4,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [profileName, protocol, JSON.stringify(dataPoints), metadata ? JSON.stringify(metadata) : null]
    );
    return result.rows[0];
  }

  static async delete(profileName: string, protocol: string): Promise<void> {
    await query(
      'DELETE FROM profile_configs WHERE profile_name = $1 AND protocol = $2',
      [profileName, protocol]
    );
  }
}

function parseProfilePayload(profile: ProfileRecord): { dataPoints: unknown[]; metadata?: Record<string, unknown> } {
  const dataPoints = typeof profile.data_points === 'string'
    ? JSON.parse(profile.data_points) as unknown[]
    : profile.data_points;

  const metadata = profile.metadata
    ? (typeof profile.metadata === 'string'
        ? JSON.parse(profile.metadata) as Record<string, unknown>
        : profile.metadata)
    : undefined;

  return { dataPoints, metadata };
}

function toDataPointsFormat(profiles: ProfileRecord[]): Record<string, unknown> {
  const dataPointsFormat: Record<string, unknown> = {};

  for (const profile of profiles) {
    const { dataPoints, metadata } = parseProfilePayload(profile);
    dataPointsFormat[profile.profile_name] = {
      dataPoints,
      ...(metadata && { metadata }),
    };
  }

  return dataPointsFormat;
}

function validateDataPoints(protocol: string, dataPoints: DataPoint[]): string | null {
  if (protocol === 'modbus' && dataPoints.length > 0) {
    for (const dataPoint of dataPoints) {
      if (!dataPoint.name || dataPoint.address === undefined || !dataPoint.type || !dataPoint.dataType) {
        return 'Each Modbus data point must have: name, address, type, dataType';
      }
    }
  } else if (protocol === 'opcua' && dataPoints.length > 0) {
    for (const dataPoint of dataPoints) {
      const isSensorGroup = Boolean(dataPoint.folder && dataPoint.prefix && dataPoint.model && dataPoint.count);
      const isNode = Boolean(dataPoint.name && dataPoint.nodeId);

      if (!isSensorGroup && !isNode) {
        return 'Each OPC UA data point must be either a sensor group (folder, prefix, model, count, unit, config) or node (name, nodeId)';
      }

      if (isSensorGroup) {
        const prefix = typeof dataPoint.prefix === 'string' ? dataPoint.prefix : '';
        const model = typeof dataPoint.model === 'string' ? dataPoint.model : '';

        if (!prefix.includes('_') || !prefix.endsWith('_')) {
          return `Prefix "${prefix}" must follow format "MetricType_" (e.g., "Temperature_", "Pressure_", "Flow_"). This ensures proper metric extraction following OPC UA standards.`;
        }

        if (!/^[a-z_]+$/.test(model)) {
          return `Model "${model}" must be lowercase with underscores only (e.g., "temperature", "pressure", "flow_rate"). This is the semantic metric name used in data collection.`;
        }

        const expectedModel = prefix.replace(/_$/, '').toLowerCase();
        if (model !== expectedModel) {
          logger.warn('OPC UA sensor group prefix/model mismatch', {
            prefix,
            model,
            expected: expectedModel,
            message: 'Prefix should match model (e.g., "Temperature_" -> "temperature")',
          });
        }
      }
    }
  }

  return null;
}

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: ProtocolQuerystring }>('/sim/datapoints', { preHandler: [validateApiKey] }, async (req, reply) => {
    try {
      const protocol = req.query.protocol || 'modbus';
      const profiles = await ProfileConfigModel.listByProtocol(protocol);
      const dataPointsFormat = toDataPointsFormat(profiles);

      logger.debug('Internal profiles accessed', { protocol, count: profiles.length });
      return reply.send(dataPointsFormat);
    } catch (error: unknown) {
      logger.error('Error getting internal datapoints', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      return reply.status(500).send({
        error: 'Internal server error',
        requestId: req.id || 'unknown',
      });
    }
  });

  fastify.get<{ Querystring: ProtocolQuerystring }>('/datapoints', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const protocol = req.query.protocol || 'modbus';
      const profiles = await ProfileConfigModel.listByProtocol(protocol);
      const dataPointsFormat = toDataPointsFormat(profiles);

      return reply.send(dataPointsFormat);
    } catch (error: unknown) {
      logger.error('Error getting datapoints', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      return reply.status(500).send({
        error: 'Internal server error',
        requestId: req.id || 'unknown',
      });
    }
  });

  fastify.post<{ Body: ProfileBody }>('/', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { profile_name, protocol, data_points, metadata } = req.body;

      if (!profile_name || typeof profile_name !== 'string') {
        return reply.status(400).send({
          error: 'Invalid request',
          message: 'profile_name is required and must be a string',
        });
      }

      if (!protocol || typeof protocol !== 'string') {
        return reply.status(400).send({
          error: 'Invalid request',
          message: 'protocol is required and must be a string (e.g., "modbus")',
        });
      }

      if (!data_points || !Array.isArray(data_points)) {
        return reply.status(400).send({
          error: 'Invalid request',
          message: 'data_points is required and must be an array',
        });
      }

      const validationError = validateDataPoints(protocol, data_points);
      if (validationError) {
        return reply.status(400).send({
          error: 'Invalid data point',
          message: validationError,
        });
      }

      const profile = await ProfileConfigModel.upsert(profile_name, protocol, data_points, metadata);

      logger.info('Profile config updated', {
        profile: profile_name,
        protocol,
        dataPointsCount: data_points.length,
        userId: req.user?.id,
      });

      return reply.send({
        status: 'ok',
        message: `Profile '${profile_name}' configuration saved`,
        profile,
      });
    } catch (error: unknown) {
      logger.error('Error saving profile config', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      return reply.status(500).send({
        error: 'Internal server error',
        requestId: req.id || 'unknown',
      });
    }
  });

  fastify.put<{ Params: ProfileNameParams; Querystring: ProtocolQuerystring; Body: ProfileBody }>('/:name', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { name } = req.params;
      const protocol = req.query.protocol || req.body.protocol;

      if (!protocol) {
        return reply.status(400).send({
          error: 'Bad request',
          message: 'protocol is required (query param or body)',
        });
      }

      const { data_points, metadata } = req.body;

      if (!data_points || !Array.isArray(data_points)) {
        return reply.status(400).send({
          error: 'Invalid request',
          message: 'data_points is required and must be an array',
        });
      }

      const existing = await ProfileConfigModel.get(name, protocol);
      if (!existing) {
        return reply.status(404).send({
          error: 'Not found',
          message: `Profile '${name}' not found for protocol '${protocol}'`,
        });
      }

      const validationError = validateDataPoints(protocol, data_points);
      if (validationError) {
        return reply.status(400).send({
          error: 'Invalid data point',
          message: validationError,
        });
      }

      const profile = await ProfileConfigModel.upsert(name, protocol, data_points, metadata);

      logger.info('Profile config updated via PUT', {
        profile: name,
        protocol,
        dataPointsCount: data_points.length,
        userId: req.user?.id,
      });

      return reply.send({
        status: 'ok',
        message: `Profile '${name}' updated`,
        profile,
      });
    } catch (error: unknown) {
      logger.error('Error updating profile config', {
        error: error instanceof Error ? error.message : 'Unknown error',
        profile: req.params.name,
      });
      return reply.status(500).send({
        error: 'Internal server error',
        requestId: req.id || 'unknown',
      });
    }
  });

  fastify.get<{ Querystring: ProtocolQuerystring }>('/', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const protocol = req.query.protocol || 'modbus';
      const profiles = await ProfileConfigModel.listByProtocol(protocol);
      return reply.send(profiles);
    } catch (error: unknown) {
      logger.error('Error listing profiles', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      return reply.status(500).send({
        error: 'Internal server error',
        requestId: req.id || 'unknown',
      });
    }
  });

  fastify.get<{ Params: ProfileNameParams; Querystring: ProtocolQuerystring }>('/:name', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { name } = req.params;
      const protocol = req.query.protocol || 'modbus';
      const profile = await ProfileConfigModel.get(name, protocol);

      if (!profile) {
        return reply.status(404).send({
          error: 'Not found',
          message: `Profile '${name}' not found for protocol '${protocol}'`,
        });
      }

      return reply.send(profile);
    } catch (error: unknown) {
      logger.error('Error getting profile', {
        error: error instanceof Error ? error.message : 'Unknown error',
        profile: req.params.name,
      });
      return reply.status(500).send({
        error: 'Internal server error',
        requestId: req.id || 'unknown',
      });
    }
  });

  fastify.delete<{ Params: ProfileNameParams; Querystring: ProtocolQuerystring }>('/:name', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { name } = req.params;
      const protocol = req.query.protocol;

      if (!protocol) {
        return reply.status(400).send({
          error: 'Bad request',
          message: 'protocol query parameter is required',
        });
      }

      await ProfileConfigModel.delete(name, protocol);

      logger.info('Profile config deleted', {
        profile: name,
        protocol,
        userId: req.user?.id,
      });

      return reply.send({
        status: 'ok',
        message: `Profile '${name}' deleted`,
      });
    } catch (error: unknown) {
      logger.error('Error deleting profile', {
        error: error instanceof Error ? error.message : 'Unknown error',
        profile: req.params.name,
      });
      return reply.status(500).send({
        error: 'Internal server error',
        requestId: req.id || 'unknown',
      });
    }
  });
};

export default plugin;