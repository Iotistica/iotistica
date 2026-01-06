/**
 * Device UUID Immutability Middleware
 * 
 * Quick check to prevent re-registration attempts for already-registered devices.
 * Fails fast before hitting the provisioning service layer.
 * 
 * Usage:
 *   router.post('/device/register', checkUuidImmutability, async (req, res) => { ... })
 */

import { Request, Response, NextFunction } from 'express';
import { DeviceModel } from '../db/models';
import logger from '../utils/logger';

/**
 * Middleware to check if device UUID is already registered
 * Prevents re-provisioning with same UUID
 * 
 * Quick fail-fast check before service layer processing
 */
export async function checkUuidImmutability(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { uuid } = req.body;

    // Skip if no UUID provided (will be caught by service validation)
    if (!uuid) {
      return next();
    }

    // Check if device exists and is already registered
    const existingDevice = await DeviceModel.getByUuid(uuid);

    if (existingDevice && existingDevice.provisioning_state === 'registered') {
      logger.warn(`Re-provisioning attempt for registered device: ${uuid.substring(0, 8)}...`);
      
      res.status(409).json({
        error: 'Device already registered',
        message: 'Device already registered with this UUID. Factory reset to re-provision.',
        details: {
          uuid,
          provisioning_state: existingDevice.provisioning_state,
          provisioned_at: existingDevice.provisioned_at
        }
      });
      return;
    }

    // UUID is either new or not yet registered, proceed
    next();
  } catch (error: any) {
    logger.error('Error checking UUID immutability:', error);
    // Don't fail the request on middleware error - let service layer handle it
    // This is just a fast-path optimization
    next();
  }
}

/**
 * Optional middleware for optional UUID immutability check
 * Doesn't fail if check errors - continues to service layer
 */
export async function optionalUuidImmutabilityCheck(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { uuid } = req.body;
    if (!uuid) return next();

    const existingDevice = await DeviceModel.getByUuid(uuid);
    if (existingDevice?.provisioning_state === 'registered') {
      res.status(409).json({
        error: 'Device already registered',
        message: 'Device already registered with this UUID. Factory reset to re-provision.'
      });
      return;
    }

    next();
  } catch (error) {
    // Soft fail - proceed to service layer
    next();
  }
}
