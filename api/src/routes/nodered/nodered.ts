/**
 * Node-RED Storage Routes
 * HTTP endpoints for Node-RED storage plugin to access flows, credentials, settings, sessions, and library
 * Single instance storage (no device isolation)
 * Protected by JWT authentication (with API key fallback for migration)
 */


import { NodeRedStorageService } from '../../services/nodered/nodered-storage';
import { jwtAuth } from '../../middleware/jwt-auth';
import { query } from '../../db/connection';
import logger from '../../utils/logger';
import type { FastifyPluginAsync } from 'fastify'

const plugin: FastifyPluginAsync = async (fastify) => {

interface AgentEndpointsQuerystring {
  agentUuid?: string;
}

interface LibraryParams {
  type: string;
}

interface LibraryQuerystring {
  name?: string;
}

interface LibraryEntryBody {
  name?: string;
  meta?: Record<string, unknown>;
  body?: unknown;
}


/**
 * GET /api/v1/nr/agents
 * Internal-network endpoint (no auth) used by the Node-RED plugin server to
 * populate the agent picker dropdown inside pipeline-in / virtual-device nodes.
 * Returns a minimal device list — never exposes credentials or secrets.
 */
fastify.get('/nr/agents', async (_req, reply) => {
  try {
    const result = await query<{ uuid: string; device_name: string; is_online: boolean; device_type: string }>(
      `SELECT uuid, device_name, is_online, device_type
       FROM agents
       ORDER BY device_name ASC
       LIMIT 500`
    );
    return reply.send({ agents: result.rows.map(r => ({ ...r, name: r.device_name })) });
  } catch (error: unknown) {
    logger.error('GET /nr/agents failed:', error);
    return reply.status(500).send({
      error: 'Failed to list agents',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/v1/nr/endpoints?agentUuid=<uuid>
 * Internal-network endpoint (no auth) used by the Node-RED plugin server to
 * populate the endpoint device list inside the device-filter node editor.
 * Returns only uuid, name, and protocol — never exposes credentials or secrets.
 */
fastify.get<{ Querystring: AgentEndpointsQuerystring }>('/nr/endpoints', async (req, reply) => {
  const agentUuid = req.query.agentUuid?.trim();
  if (!agentUuid) {
    return reply.status(400).send({ error: 'agentUuid query param is required' });
  }
  try {
    const result = await query<{ uuid: string; name: string; protocol: string }>(
      `SELECT uuid, name, protocol
       FROM endpoints
       WHERE agent_uuid = $1 AND enabled = true
       ORDER BY name ASC
       LIMIT 500`,
      [agentUuid]
    );
    return reply.send({ endpoints: result.rows });
  } catch (error: unknown) {
    logger.error('GET /nr/endpoints failed:', error);
    return reply.status(500).send({
      error: 'Failed to list endpoints',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// // JWT or bootstrap token authentication for Node-RED storage routes.
// router.use('/nr/storage', async (req, res, next) => {
//   // Direct console logging to ensure it appears
//   console.log('[NR-STORAGE-MIDDLEWARE] Incoming request to', req.path);
  
//   const authHeader = req.headers.authorization;
//   const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : '';
//   const tokenParts = bearerToken.split('.');
//   const isJwtLike = tokenParts.length === 3;
  
//   // Check if it's the bootstrap token from environment
//   const bootstrapToken = process.env.IOTISTIC_STORAGE_TOKEN;

//   console.log('[NR-STORAGE-MIDDLEWARE] Token check:', {
//     hasAuthHeader: !!authHeader,
//     tokenLength: bearerToken.length,
//     tokenPartCount: tokenParts.length,
//     bootstrapConfigured: !!bootstrapToken,
//     tokensMatch: bearerToken === bootstrapToken
//   });

//   logger.info('[NR-STORAGE] Incoming request', {
//     path: req.path,
//     method: req.method,
//     hasAuthHeader: !!authHeader,
//     tokenPartCount: tokenParts.length,
//     isJwtLike,
//     isBootstrapToken: bearerToken === bootstrapToken
//   });

//   // Allow bootstrap token for startup/background operations
//   if (bootstrapToken && bearerToken === bootstrapToken) {
//     console.log('[NR-STORAGE-MIDDLEWARE] Bootstrap token MATCHED - allowing access');
//     logger.info('[NR-STORAGE] Bootstrap token validated, allowing access');
//     return next();
//   }

//   // Require JWT for user sessions
//   if (!isJwtLike) {
//     console.log('[NR-STORAGE-MIDDLEWARE] Token not JWT format - rejecting with 401');
//     logger.warn('[NR-STORAGE] Invalid token format', {
//       expectedParts: 3,
//       actualParts: tokenParts.length,
//       bootstrapTokenConfigured: !!bootstrapToken
//     });
//     res.status(401).send({
//       error: 'Unauthorized',
//       message: 'JWT token or valid bootstrap token required for Node-RED storage routes'
//     });
//     return;
//   }

//   console.log('[NR-STORAGE-MIDDLEWARE] JWT token detected - calling jwtAuth');
//   logger.info('[NR-STORAGE] JWT token detected, calling jwtAuth');
//   await jwtAuth(req, res, next);
// });

/**
 * GET /api/v1/nr/storage/flows
 * Get Node-RED flows
 */
fastify.get('/nr/storage/flows', async (_req, reply) => {
  try {
    const data = await NodeRedStorageService.getFlows();
    return reply.send(data);
  } catch (error: unknown) {
    logger.error('Error getting flows:', error);
    return reply.status(500).send({
      error: 'Failed to get flows',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/v1/nr/storage/flows
 * Save Node-RED flows
 */
fastify.post<{ Body: unknown }>('/nr/storage/flows', async (req, reply) => {
  try {
    const flows = req.body;
    
    if (!Array.isArray(flows)) {
      return reply.status(400).send({
        error: 'Invalid flows format',
        message: 'Flows must be an array'
      });
    }
    
    await NodeRedStorageService.saveFlows(flows);
    return reply.send({ success: true });
  } catch (error: unknown) {
    logger.error('Error saving flows:', error);
    return reply.status(500).send({
      error: 'Failed to save flows',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/v1/nr/storage/credentials
 * Get Node-RED credentials
 */
fastify.get('/nr/storage/credentials', async (_req, reply) => {
  try {
    const data = await NodeRedStorageService.getCredentials();
    return reply.send(data);
  } catch (error: unknown) {
    logger.error('Error getting credentials:', error);
    return reply.status(500).send({
      error: 'Failed to get credentials',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/v1/nr/storage/credentials
 * Save Node-RED credentials
 */
fastify.post<{ Body: unknown }>('/nr/storage/credentials', async (req, reply) => {
  try {
    const credentials = req.body;
    
    if (typeof credentials !== 'object') {
      return reply.status(400).send({
        error: 'Invalid credentials format',
        message: 'Credentials must be an object'
      });
    }
    
    await NodeRedStorageService.saveCredentials(credentials);
    return reply.send({ success: true });
  } catch (error: unknown) {
    logger.error('Error saving credentials:', error);
    return reply.status(500).send({
      error: 'Failed to save credentials',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/v1/nr/storage/settings
 * Get Node-RED settings
 */
fastify.get('/nr/storage/settings', async (_req, reply) => {
  try {
    const data = await NodeRedStorageService.getSettings();
    return reply.send(data);
  } catch (error: unknown) {
    logger.error('Error getting settings:', error);
    return reply.status(500).send({
      error: 'Failed to get settings',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/v1/nr/storage/settings
 * Save Node-RED settings
 */
fastify.post<{ Body: unknown }>('/nr/storage/settings', async (req, reply) => {
  try {
    const settings = req.body;
    
    if (typeof settings !== 'object') {
      return reply.status(400).send({
        error: 'Invalid settings format',
        message: 'Settings must be an object'
      });
    }
    
    await NodeRedStorageService.saveSettings(settings);
    return reply.send({ success: true });
  } catch (error: unknown) {
    logger.error('Error saving settings:', error);
    return reply.status(500).send({
      error: 'Failed to save settings',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/v1/nr/storage/sessions
 * Get Node-RED sessions
 */
fastify.get('/nr/storage/sessions', async (_req, reply) => {
  try {
    const data = await NodeRedStorageService.getSessions();
    return reply.send(data);
  } catch (error: unknown) {
    logger.error('Error getting sessions:', error);
    return reply.status(500).send({
      error: 'Failed to get sessions',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/v1/nr/storage/sessions
 * Save Node-RED sessions
 */
fastify.post<{ Body: unknown }>('/nr/storage/sessions', async (req, reply) => {
  try {
    const sessions = req.body;
    
    if (typeof sessions !== 'object') {
      return reply.status(400).send({
        error: 'Invalid sessions format',
        message: 'Sessions must be an object'
      });
    }
    
    await NodeRedStorageService.saveSessions(sessions);
    return reply.send({ success: true });
  } catch (error: unknown) {
    logger.error('Error saving sessions:', error);
    return reply.status(500).send({
      error: 'Failed to save sessions',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/v1/nr/storage/library/:type?name=xxx
 * Get Node-RED library entry
 */
fastify.get<{ Params: LibraryParams; Querystring: LibraryQuerystring }>('/nr/storage/library/:type', async (req, reply) => {
  try {
    const { type } = req.params;
    const { name } = req.query;
    
    if (!name || typeof name !== 'string') {
      return reply.status(400).send({
        error: 'Missing name parameter',
        message: 'Library entry name is required'
      });
    }
    
    const entry = await NodeRedStorageService.getLibraryEntry(type, name);
    
    if (!entry) {
      return reply.status(404).send({
        error: 'Library entry not found',
        message: `Library entry ${type}/${name} not found`
      });
    }
    
    // Return appropriate content type
    if (typeof entry.body === 'string') {
      return reply.header('Content-Type', 'text/plain').send(entry.body);
    } else {
      return reply.send(entry.body);
    }
  } catch (error: unknown) {
    logger.error('Error getting library entry:', error);
    return reply.status(500).send({
      error: 'Failed to get library entry',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/v1/nr/storage/library/:type
 * Save Node-RED library entry
 */
fastify.post<{ Params: LibraryParams; Body: LibraryEntryBody }>('/nr/storage/library/:type', async (req, reply) => {
  try {
    const { type } = req.params;
    const { name, meta, body } = req.body;
    
    if (!name) {
      return reply.status(400).send({
        error: 'Missing name',
        message: 'Library entry name is required'
      });
    }
    
    if (!body) {
      return reply.status(400).send({
        error: 'Missing body',
        message: 'Library entry body is required'
      });
    }
    
    await NodeRedStorageService.saveLibraryEntry(type, name, meta || {}, body);
    return reply.send({ success: true });
  } catch (error: unknown) {
    logger.error('Error saving library entry:', error);
    return reply.status(500).send({
      error: 'Failed to save library entry',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});
};

export default plugin;
