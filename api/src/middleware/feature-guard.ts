/**
 * Feature Guard Middleware
 * Enforces license-based feature flags and usage limits
 */

import { Request, Response, NextFunction } from 'express';
import { LicenseValidator } from '../services/auth/license-validator';

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
        upgradeUrl: process.env.BILLING_UPGRADE_URL || 'https://iotistica.com/upgrade',
      });
    }
    
    next();
  };
}

/**
 * Middleware to check device limit
 */
export async function checkAgentLimit(req: Request, res: Response, next: NextFunction) {
  const license = LicenseValidator.getInstance();
  const maxDevices = license.getLicense().features.maxDevices;
  
  // Count current agents
  const { AgentModel: AgentModel } = await import('../db/models');
  const agents = await AgentModel.list({ isActive: true });
  
  if (agents.length >= maxDevices) {
    return res.status(403).json({
      error: 'Device limit reached',
      message: `Maximum agents (${maxDevices}) reached. Upgrade your plan to add more agents.`,
      currentDevices: agents.length,
      maxDevices,
      upgradeUrl: process.env.BILLING_UPGRADE_URL || 'https://iotistica.com/upgrade',
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
      billingUrl: process.env.BILLING_PORTAL_URL || 'https://iotistica.com/billing',
    });
  }
  
  next();
}

/**
 * Middleware to check subscription with grace period and read-only mode support
 * 
 * Modes:
 * - 'strict': Block all requests if subscription expired (after grace period)
 * - 'read-only': Allow GET requests even after grace period, block writes
 * - 'graceful': Allow all requests with warning headers during grace period
 */
export function requireValidSubscription(mode: 'strict' | 'read-only' | 'graceful' = 'strict') {
  return (req: Request, res: Response, next: NextFunction) => {
    const license = LicenseValidator.getInstance();
    const state = license.getSubscriptionState();
    
    // Full access for active and trial_active
    if (state === 'active' || state === 'trial_active') {
      return next();
    }
    
    // Grace period with warnings
    if (state === 'trial_grace') {
      const daysRemaining = license.getGracePeriodDaysRemaining();
      
      // Add warning headers
      res.setHeader('X-Subscription-Warning', 
        `Trial expired. ${daysRemaining} days remaining in grace period.`);
      res.setHeader('X-Subscription-State', state);
      res.setHeader('X-Grace-Days-Remaining', String(daysRemaining || 0));
      
      if (mode === 'graceful') {
        return next(); // Allow with warning
      }
      
      // For strict and read-only, continue to check if still within grace
      return next();
    }
    
    // Expired: Handle based on mode
    if (state === 'expired') {
      const licenseData = license.getLicense();
      
      // Read-only mode: Allow GET requests
      if (mode === 'read-only' && req.method === 'GET') {
        res.setHeader('X-Subscription-Status', 'read-only');
        res.setHeader('X-Subscription-State', state);
        res.setHeader('X-Subscription-Message', 
          'Read-only mode: Trial expired. Upgrade to restore full access.');
        return next();
      }
      
      // Block all write operations and non-GET in read-only mode
      return res.status(402).json({
        error: 'Subscription expired',
        message: mode === 'read-only' 
          ? 'Your trial has expired. Write operations are disabled. Upgrade to continue.'
          : 'Your trial has expired. Upgrade to continue using the platform.',
        state,
        plan: licenseData.plan,
        trialExpiresAt: licenseData.trial.expiresAt,
        upgradeUrl: process.env.BILLING_UPGRADE_URL || 'https://iotistica.com/upgrade',
        billingUrl: process.env.BILLING_PORTAL_URL || 'https://iotistica.com/billing',
      });
    }
    
    next();
  };
}
