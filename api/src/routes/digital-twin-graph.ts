/**
 * Digital Twin Graph API Routes
 * 
 * RESTful endpoints for managing Digital Twin spatial graph:
 * - IFC file upload and parsing
 * - Neo4j graph queries
 * - Device-to-space mapping
 * - Graph visualization data
 */

import express, { Request, Response, Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { IFCParserService } from '../services/ifc-parser.service';
import { neo4jService } from '../services/neo4j.service';
import { query } from '../db/connection';
import { logger } from '../utils/logger';
import { jwtAuth } from '../middleware/jwt-auth';

const router: Router = express.Router();
// All routes require authentication
router.use(jwtAuth);

// Detect Kubernetes environment
const isKubernetes = !!process.env.KUBERNETES_SERVICE_HOST;

// Use /tmp in Kubernetes (always writable), local uploads/ otherwise
const uploadDir = isKubernetes ? '/tmp/ifc' : 'uploads/ifc';

// Configure multer for IFC file uploads
const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max
  },
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.ifc')) {
      cb(null, true);
    } else {
      cb(new Error('Only .ifc files are allowed'));
    }
  },
});

/**
 * POST /api/digital-twin/graph/upload-ifc
 * Upload and parse IFC file, load into Neo4j
 */
router.post('/upload-ifc', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    logger.info('Uploading IFC file', { filename: req.file.originalname });

    // Initialize IFC parser
    const parser = new IFCParserService();
    await parser.init();

    // Parse IFC file
    const hierarchy = await parser.parseIFCFile(req.file.path);

    logger.info('IFC Parsing Results', {
      project: hierarchy.project?.name || 'none',
      site: hierarchy.site?.name || 'none',
      building: hierarchy.building?.name || 'none',
      floors: hierarchy.floors.length,
      spaces: hierarchy.spaces.length,
      edgeDevices: hierarchy.edgeDevices.length,
      sensors: hierarchy.sensors.length,
      relationships: hierarchy.relationships.length
    });
    
    logger.debug('IFC Hierarchy Details', {
      floors: hierarchy.floors.map(f => ({ name: f.name, id: f.expressId })),
      spaces: hierarchy.spaces.map(s => ({ name: s.name, id: s.expressId })),
      edgeDevices: hierarchy.edgeDevices.map(d => ({ name: d.name, id: d.expressId })),
      sensors: hierarchy.sensors.map(s => ({ name: s.name, id: s.expressId })),
      relationships: hierarchy.relationships.map(r => ({ type: r.type, from: r.from, to: r.to }))
    });

    // Load into Neo4j
    await neo4jService.loadIFCHierarchy(hierarchy);

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      message: 'IFC file processed successfully',
      stats: {
        floors: hierarchy.floors.length,
        spaces: hierarchy.spaces.length,
        edgeDevices: hierarchy.edgeDevices.length,
        sensors: hierarchy.sensors.length,
        relationships: hierarchy.relationships.length,
      },
    });
  } catch (error: any) {
    logger.error('Failed to upload IFC', { error: error.message });
    
    // Clean up file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({
      error: 'Failed to process IFC file',
      message: error.message,
    });
  }
});

/**
 * GET /api/digital-twin/graph
 * Get full graph visualization data from Neo4j
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const graphData = await neo4jService.getGraphVisualizationData();
    
    logger.info('Graph Data Being Returned', {
      nodes: graphData.nodes.length,
      relationships: graphData.relationships.length
    });
    
    logger.debug('Graph Relationships', {
      relationships: graphData.relationships.map(rel => ({
        type: rel.type,
        from: rel.from,
        to: rel.to
      }))
    });
    
    res.json({
      success: true,
      data: graphData,
    });
  } catch (error: any) {
    logger.error('Failed to get graph data', { error: error.message });
    res.status(500).json({
      error: 'Failed to retrieve graph data',
      message: error.message,
    });
  }
});

/**
 * POST /api/digital-twin/graph/map-device
 * Map an edge device to a space
 * 
 * Body: { deviceUuid: string, spaceExpressId: number }
 */
router.post('/map-device', async (req: Request, res: Response) => {
  try {
    const { deviceUuid, spaceExpressId } = req.body;

    if (!deviceUuid || !spaceExpressId) {
      return res.status(400).json({
        error: 'Missing required fields: deviceUuid, spaceExpressId',
      });
    }

    // Get device name from PostgreSQL
    let deviceName: string | null = null;
    try {
      const deviceResult = await query('SELECT device_name FROM devices WHERE uuid = $1', [deviceUuid]);
      if (deviceResult.rows.length > 0) {
        deviceName = deviceResult.rows[0].device_name;
      }
    } catch (dbError) {
      logger.warn('Could not fetch device name', { deviceUuid, error: dbError });
    }

    await neo4jService.mapDeviceToSpace(deviceUuid, spaceExpressId, deviceName);

    res.json({
      success: true,
      message: `Device ${deviceName || deviceUuid} mapped to space ${spaceExpressId}`,
    });
  } catch (error: any) {
    logger.error('Failed to map device', { error: error.message });
    res.status(500).json({
      error: 'Failed to map device to space',
      message: error.message,
    });
  }
});

/**
 * DELETE /api/digital-twin/graph/map-device/:deviceUuid
 * Remove device mapping from space
 */
router.delete('/map-device/:deviceUuid', async (req: Request, res: Response) => {
  try {
    const { deviceUuid } = req.params;

    await neo4jService.unmapDeviceFromSpace(deviceUuid);

    res.json({
      success: true,
      message: `Device ${deviceUuid} unmapped from space`,
    });
  } catch (error: any) {
    logger.error('Failed to unmap device', { error: error.message });
    res.status(500).json({
      error: 'Failed to unmap device',
      message: error.message,
    });
  }
});

/**
 * DELETE /api/digital-twin/graph/node/:nodeId
 * Delete an unmapped EdgeDevice node
 */
router.delete('/node/:nodeId', async (req: Request, res: Response) => {
  try {
    const { nodeId } = req.params;
    const { uuid } = req.query;

    if (!uuid || typeof uuid !== 'string') {
      return res.status(400).json({
        error: 'Missing required query parameter: uuid',
      });
    }

    const result = await neo4jService.deleteUnmappedDevice(uuid);

    if (!result.deleted) {
      return res.status(400).json({
        success: false,
        message: result.reason || 'Failed to delete device',
      });
    }

    res.json({
      success: true,
      message: `Device ${uuid} deleted successfully`,
    });
  } catch (error: any) {
    logger.error('Failed to delete node', { error: error.message });
    res.status(500).json({
      error: 'Failed to delete node',
      message: error.message,
    });
  }
});

/**
 * GET /api/digital-twin/graph/device-mappings
 * Get all device-to-space mappings
 */
router.get('/device-mappings', async (req: Request, res: Response) => {
  try {
    const mappings = await neo4jService.getDeviceMappings();

    res.json({
      success: true,
      data: mappings,
    });
  } catch (error: any) {
    logger.error('Failed to get device mappings', { error: error.message });
    res.status(500).json({
      error: 'Failed to retrieve device mappings',
      message: error.message,
    });
  }
});

export default router;
