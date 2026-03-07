/**
 * Feature Guard Middleware
 * Enforces license-based feature flags and usage limits
 */

import { Request, Response, NextFunction } from 'express';
import { LicenseValidator } from '../services/license-validator';

// Type for boolean feature keys only
type BooleanFeatureKey = 'canExecuteJobs' | 'canScheduleJobs' | 'canRemoteAccess' | 'canOtaUpdates' | 'canExportData' | 'hasAdvancedAlerts' | 'hasCustomDashboards';

/**
 * Middleware to check if feature is enabled (boolean features only)
 */
export function requireFeature(feature: BooleanFeatureKey) {
  return (req: Request, res: Response, next: NextFunction) => {
    const license = LicenseValidator.getInstance();
    
    if (!license.hasFeature(feature)) {
      return res.status(403).json({
        error: 'Feature not available',
        message: `This feature requires a higher plan. Current plan: ${license.getLicense().plan}`,
        feature,
        upgradeUrl: process.env.BILLING_UPGRADE_URL || 'https://iotistic.ca/upgrade',
      });
    }
    
    next();
  };
}

/**
 * Middleware to check device limit
 */
export async function checkDeviceLimit(req: Request, res: Response, next: NextFunction) {
  const license = LicenseValidator.getInstance();
  const maxDevices = license.getLicense().features.maxDevices;
  
  // Count current devices
  const { DeviceModel } = await import('../db/models');
  const devices = await DeviceModel.list({ isActive: true });
  
  if (devices.length >= maxDevices) {
    return res.status(403).json({
      error: 'Device limit reached',
      message: `Maximum devices (${maxDevices}) reached. Upgrade your plan to add more devices.`,
      currentDevices: devices.length,
      maxDevices,
      upgradeUrl: process.env.BILLING_UPGRADE_URL || 'https://iotistic.ca/upgrade',
    });
  }
  
  next();
}

/**
 * Middleware to check subscription status
 */
export function requireActiveSubscription(req: Request, res: Response, next: NextFunction) {
  const license = LicenseValidator.getInstance();
  
  if (!license.isSubscriptionActive()) {
    return res.status(402).json({ // 402 Payment Required
      error: 'Subscription inactive',
      message: 'Your subscription is not active. Please update your payment method.',
      status: license.getLicense().subscription.status,
      billingUrl: process.env.BILLING_PORTAL_URL || 'https://iotistic.ca/billing',
    });
  }
  
  next();
}
