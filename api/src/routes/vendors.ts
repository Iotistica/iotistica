/**
 * Vendor Configuration Management Routes
 * 
 * Replaces static dataPoints.json file with dynamic database-backed vendor configs.
 * Allows adding/updating protocol vendor configurations via API.
 * 
 * Routes:
 * - GET    /api/v1/vendors?protocol=modbus - List all vendors for protocol
 * - GET    /api/v1/vendors/:name?protocol=modbus - Get specific vendor config
 * - POST   /api/v1/vendors - Create/update vendor config
 * - DELETE /api/v1/vendors/:name - Delete vendor config
 */

import express from 'express';
import { query } from '../db/connection.js';
import { logger } from '../utils/logger.js';

// Vendor Config Model (inline for simplicity)
class VendorConfigModel {
  static async get(vendorName: string, protocol: string = 'modbus') {
    const result = await query(
      'SELECT * FROM vendor_configs WHERE vendor_name = $1 AND protocol = $2',
      [vendorName, protocol]
    );
    return result.rows[0] || null;
  }

  static async listByProtocol(protocol: string) {
    const result = await query(
      'SELECT * FROM vendor_configs WHERE protocol = $1 ORDER BY vendor_name',
      [protocol]
    );
    return result.rows;
  }

  static async upsert(vendorName: string, protocol: string, dataPoints: any[], metadata?: any) {
    const result = await query(
      `INSERT INTO vendor_configs (vendor_name, protocol, data_points, metadata)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (vendor_name) DO UPDATE SET
         protocol = $2,
         data_points = $3,
         metadata = $4,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [vendorName, protocol, JSON.stringify(dataPoints), metadata ? JSON.stringify(metadata) : null]
    );
    return result.rows[0];
  }

  static async delete(vendorName: string) {
    await query('DELETE FROM vendor_configs WHERE vendor_name = $1', [vendorName]);
  }
}

const router = express.Router();

/**
 * Get all vendors in dataPoints.json format (for simulators)
 * GET /api/v1/vendors/datapoints?protocol=modbus
 * 
 * Returns format compatible with modbus-simulator:
 * {
 *   "Generic": { "dataPoints": [...] },
 *   "COMAP": { "dataPoints": [...] }
 * }
 */
router.get('/datapoints', async (req, res) => {
  try {
    const protocol = (req.query.protocol as string) || 'modbus';
    const vendors = await VendorConfigModel.listByProtocol(protocol);

    // Transform to dataPoints.json format
    const dataPointsFormat: Record<string, any> = {};
    for (const vendor of vendors) {
      dataPointsFormat[vendor.vendor_name] = {
        dataPoints: vendor.data_points,
        ...(vendor.metadata && { metadata: vendor.metadata })
      };
    }

    res.json(dataPointsFormat);
  } catch (error: any) {
    logger.error('Error getting datapoints', { error: error.message });
    res.status(500).json({
      error: 'Failed to get datapoints',
      message: error.message
    });
  }
});

/**
 * List all vendor configurations for a protocol
 * GET /api/v1/vendors?protocol=modbus
 */
router.get('/', async (req, res) => {
  try {
    const protocol = (req.query.protocol as string) || 'modbus';
    const vendors = await VendorConfigModel.listByProtocol(protocol);

    res.json({
      vendors,
      count: vendors.length
    });
  } catch (error: any) {
    logger.error('Error listing vendors', { error: error.message });
    res.status(500).json({
      error: 'Failed to list vendors',
      message: error.message
    });
  }
});

/**
 * Get specific vendor configuration
 * GET /api/v1/vendors/:name?protocol=modbus
 */
router.get('/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const protocol = (req.query.protocol as string) || 'modbus';

    const vendor = await VendorConfigModel.get(name, protocol);

    if (!vendor) {
      return res.status(404).json({
        error: 'Not found',
        message: `Vendor '${name}' not found for protocol '${protocol}'`
      });
    }

    res.json(vendor);
  } catch (error: any) {
    logger.error('Error getting vendor', { error: error.message, vendor: req.params.name });
    res.status(500).json({
      error: 'Failed to get vendor',
      message: error.message
    });
  }
});

/**
 * Create or update vendor configuration
 * POST /api/v1/vendors
 * 
 * Body:
 * {
 *   "vendor_name": "COMAP",
 *   "protocol": "modbus",
 *   "data_points": [
 *     { "name": "engine_rpm", "address": 100, "type": "holding", "dataType": "uint16" },
 *     ...
 *   ],
 *   "metadata": {
 *     "description": "COMAP Generator Controller",
 *     "vendorUrl": "https://www.comap-control.com/"
 *   }
 * }
 */
router.post('/', async (req, res) => {
  try {
    const { vendor_name, protocol, data_points, metadata } = req.body;

    // Validation
    if (!vendor_name || typeof vendor_name !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'vendor_name is required and must be a string'
      });
    }

    if (!protocol || typeof protocol !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'protocol is required and must be a string (e.g., "modbus")'
      });
    }

    if (!data_points || !Array.isArray(data_points)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'data_points is required and must be an array'
      });
    }

    // Basic data point validation
    for (const dp of data_points) {
      if (!dp.name || !dp.address || !dp.type || !dp.dataType) {
        return res.status(400).json({
          error: 'Invalid data point',
          message: 'Each data point must have: name, address, type, dataType'
        });
      }
    }

    const vendor = await VendorConfigModel.upsert(
      vendor_name,
      protocol,
      data_points,
      metadata
    );

    logger.info('Vendor config updated', { vendor: vendor_name, protocol, dataPointsCount: data_points.length });

    res.json({
      status: 'ok',
      message: `Vendor '${vendor_name}' configuration saved`,
      vendor
    });
  } catch (error: any) {
    logger.error('Error saving vendor config', { error: error.message });
    res.status(500).json({
      error: 'Failed to save vendor config',
      message: error.message
    });
  }
});

/**
 * Delete vendor configuration
 * DELETE /api/v1/vendors/:name
 */
router.delete('/:name', async (req, res) => {
  try {
    const { name } = req.params;

    await VendorConfigModel.delete(name);

    logger.info('Vendor config deleted', { vendor: name });

    res.json({
      status: 'ok',
      message: `Vendor '${name}' deleted`
    });
  } catch (error: any) {
    logger.error('Error deleting vendor', { error: error.message, vendor: req.params.name });
    res.status(500).json({
      error: 'Failed to delete vendor',
      message: error.message
    });
  }
});

export default router;
