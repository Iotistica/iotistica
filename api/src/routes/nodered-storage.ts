/**
 * Node-RED Storage Routes
 * HTTP endpoints for Node-RED storage plugin to access flows, credentials, settings, sessions, and library
 * Single instance storage (no device isolation)
 * Protected by JWT authentication (with API key fallback for migration)
 */

import express from 'express';
import { NodeRedStorageService } from '../services/nodered-storage.service';
import { jwtAuth } from '../middleware/jwt-auth';
import { query } from '../db/connection';
import logger from '../utils/logger';

export const router = express.Router();

/**
 * GET /api/v1/nr/agents
 * Internal-network endpoint (no auth) used by the Node-RED plugin server to
 * populate the agent picker dropdown inside pipeline-in / virtual-device nodes.
 * Returns a minimal device list — never exposes credentials or secrets.
 */
router.get('/nr/agents', async (req, res) => {
  try {
    const result = await query<{ uuid: string; device_name: string; is_online: boolean; device_type: string }>(
      `SELECT uuid, device_name, is_online, device_type
       FROM agents
       ORDER BY device_name ASC
       LIMIT 500`
    );
    res.json({ agents: result.rows.map(r => ({ ...r, name: r.device_name })) });
  } catch (error: any) {
    logger.error('GET /nr/agents failed:', error);
    res.status(500).json({ error: 'Failed to list agents', message: error.message });
  }
});

/**
 * GET /api/v1/nr/endpoints?agentUuid=<uuid>
 * Internal-network endpoint (no auth) used by the Node-RED plugin server to
 * populate the endpoint device list inside the device-filter node editor.
 * Returns only uuid, name, and protocol — never exposes credentials or secrets.
 */
router.get('/nr/endpoints', async (req, res) => {
  const agentUuid = (req.query['agentUuid'] as string | undefined)?.trim();
  if (!agentUuid) {
    return res.status(400).json({ error: 'agentUuid query param is required' });
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
    res.json({ endpoints: result.rows });
  } catch (error: any) {
    logger.error('GET /nr/endpoints failed:', error);
    res.status(500).json({ error: 'Failed to list endpoints', message: error.message });
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
//     res.status(401).json({
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
router.get('/nr/storage/flows', async (req, res) => {
  try {
    const data = await NodeRedStorageService.getFlows();
    res.json(data);
  } catch (error: any) {
    logger.error('Error getting flows:', error);
    res.status(500).json({
      error: 'Failed to get flows',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/nr/storage/flows
 * Save Node-RED flows
 */
router.post('/nr/storage/flows', async (req, res) => {
  try {
    const flows = req.body;
    
    if (!Array.isArray(flows)) {
      return res.status(400).json({
        error: 'Invalid flows format',
        message: 'Flows must be an array'
      });
    }
    
    await NodeRedStorageService.saveFlows(flows);
    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error saving flows:', error);
    res.status(500).json({
      error: 'Failed to save flows',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/nr/storage/credentials
 * Get Node-RED credentials
 */
router.get('/nr/storage/credentials', async (req, res) => {
  try {
    const data = await NodeRedStorageService.getCredentials();
    res.json(data);
  } catch (error: any) {
    logger.error('Error getting credentials:', error);
    res.status(500).json({
      error: 'Failed to get credentials',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/nr/storage/credentials
 * Save Node-RED credentials
 */
router.post('/nr/storage/credentials', async (req, res) => {
  try {
    const credentials = req.body;
    
    if (typeof credentials !== 'object') {
      return res.status(400).json({
        error: 'Invalid credentials format',
        message: 'Credentials must be an object'
      });
    }
    
    await NodeRedStorageService.saveCredentials(credentials);
    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error saving credentials:', error);
    res.status(500).json({
      error: 'Failed to save credentials',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/nr/storage/settings
 * Get Node-RED settings
 */
router.get('/nr/storage/settings', async (req, res) => {
  try {
    const data = await NodeRedStorageService.getSettings();
    res.json(data);
  } catch (error: any) {
    logger.error('Error getting settings:', error);
    res.status(500).json({
      error: 'Failed to get settings',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/nr/storage/settings
 * Save Node-RED settings
 */
router.post('/nr/storage/settings', async (req, res) => {
  try {
    const settings = req.body;
    
    if (typeof settings !== 'object') {
      return res.status(400).json({
        error: 'Invalid settings format',
        message: 'Settings must be an object'
      });
    }
    
    await NodeRedStorageService.saveSettings(settings);
    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error saving settings:', error);
    res.status(500).json({
      error: 'Failed to save settings',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/nr/storage/sessions
 * Get Node-RED sessions
 */
router.get('/nr/storage/sessions', async (req, res) => {
  try {
    const data = await NodeRedStorageService.getSessions();
    res.json(data);
  } catch (error: any) {
    logger.error('Error getting sessions:', error);
    res.status(500).json({
      error: 'Failed to get sessions',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/nr/storage/sessions
 * Save Node-RED sessions
 */
router.post('/nr/storage/sessions', async (req, res) => {
  try {
    const sessions = req.body;
    
    if (typeof sessions !== 'object') {
      return res.status(400).json({
        error: 'Invalid sessions format',
        message: 'Sessions must be an object'
      });
    }
    
    await NodeRedStorageService.saveSessions(sessions);
    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error saving sessions:', error);
    res.status(500).json({
      error: 'Failed to save sessions',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/nr/storage/library/:type?name=xxx
 * Get Node-RED library entry
 */
router.get('/nr/storage/library/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { name } = req.query;
    
    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        error: 'Missing name parameter',
        message: 'Library entry name is required'
      });
    }
    
    const entry = await NodeRedStorageService.getLibraryEntry(type, name);
    
    if (!entry) {
      return res.status(404).json({
        error: 'Library entry not found',
        message: `Library entry ${type}/${name} not found`
      });
    }
    
    // Return appropriate content type
    if (typeof entry.body === 'string') {
      res.setHeader('Content-Type', 'text/plain');
      res.send(entry.body);
    } else {
      res.json(entry.body);
    }
  } catch (error: any) {
    logger.error('Error getting library entry:', error);
    res.status(500).json({
      error: 'Failed to get library entry',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/nr/storage/library/:type
 * Save Node-RED library entry
 */
router.post('/nr/storage/library/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { name, meta, body } = req.body;
    
    if (!name) {
      return res.status(400).json({
        error: 'Missing name',
        message: 'Library entry name is required'
      });
    }
    
    if (!body) {
      return res.status(400).json({
        error: 'Missing body',
        message: 'Library entry body is required'
      });
    }
    
    await NodeRedStorageService.saveLibraryEntry(type, name, meta || {}, body);
    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error saving library entry:', error);
    res.status(500).json({
      error: 'Failed to save library entry',
      message: error.message
    });
  }
});
