/**
 * License Validator Service
 * Validates JWT-based license keys from Global Billing API
 * Enforces feature flags and usage limits
 */

import jwt from 'jsonwebtoken';
import fs from 'fs';
import { SystemConfigModel } from '../db/system-config-model';
import logger from '../utils/logger';

export interface LicenseData {
  customerId: string;
  customerName: string;
  plan: 'trial' | 'starter' | 'professional' | 'enterprise';
  features: {
    // Core device management
    maxDevices: number;
    
    // Job execution capabilities
    canExecuteJobs: boolean;
    canScheduleJobs: boolean;
    
    // Remote access & control
    canRemoteAccess: boolean;
    canOtaUpdates: boolean;
    
    // Data management
    canExportData: boolean;
    
    // Advanced features
    hasAdvancedAlerts: boolean;
    hasCustomDashboards: boolean;
  };
  limits: {
    maxJobTemplates?: number;
    maxAlertRules?: number;
    maxUsers?: number;
  };
  trial: {
    isTrialMode: boolean;
    expiresAt?: string; // ISO date
  };
  subscription: {
    status: 'active' | 'past_due' | 'canceled' | 'trialing';
    currentPeriodEndsAt: string;
  };
  issuedAt: number;
  expiresAt: number; // License expiry (separate from subscription)
  
  // Standard JWT claims
  exp?: number; // JWT expiration timestamp (seconds since epoch)
  iat?: number; // JWT issued at timestamp
  nbf?: number; // JWT not before timestamp
}

type BooleanFeatureKey = {
  [K in keyof LicenseData['features']]: LicenseData['features'][K] extends boolean ? K : never;
}[keyof LicenseData['features']];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(laterDate: Date, earlierDate: Date): number {
  return Math.ceil((laterDate.getTime() - earlierDate.getTime()) / MS_PER_DAY);
}

export class LicenseValidator {
  private static instance: LicenseValidator;
  private licenseData: LicenseData | null = null;
  private licenseKey: string | null = null;
  
  // Public key for verifying JWT (Global Billing API signs with private key)
  // Priority:
  //   1. LICENSE_PUBLIC_KEY_PATH - Read from file (Kubernetes ConfigMap mount)
  //   2. LICENSE_PUBLIC_KEY - Read from env var (development/legacy)
  private static readonly PUBLIC_KEY = (() => {
    const keyPath = process.env.LICENSE_PUBLIC_KEY_PATH;
    if (keyPath) {
      try {
        const key = fs.readFileSync(keyPath, 'utf8');
        logger.info('License public key loaded from file', { keyPath });
        return key;
      } catch (error: any) {
        logger.error('Failed to read license public key from file', {
          keyPath,
          message: error?.message,
        });
        logger.warn('Falling back to LICENSE_PUBLIC_KEY environment variable');
      }
    }
    
    // Fallback: env var (convert \n literals to actual newlines)
    const envKey = (process.env.LICENSE_PUBLIC_KEY || '').replace(/\\n/g, '\n');
    if (envKey) {
      logger.info('License public key loaded from environment variable');
    }
    return envKey;
  })();

  private constructor() {}

  static getInstance(): LicenseValidator {
    if (!this.instance) {
      this.instance = new LicenseValidator();
    }
    return this.instance;
  }

  /**
   * Initialize license from environment variable.
   * Throws if IOTISTIC_LICENSE_KEY is missing or validation fails.
   * No fallback to unlicensed mode is permitted.
   */
  async init(): Promise<void> {
    const licenseKey = process.env.IOTISTIC_LICENSE_KEY;
    
    if (!licenseKey) {
      throw new Error('IOTISTIC_LICENSE_KEY environment variable is not set. Service cannot start without a valid license.');
    }

    this.licenseKey = licenseKey;
    this.licenseData = await this.validateLicense(licenseKey);

    // Cache license data in system_config for diagnostics (not for fallback use)
    await SystemConfigModel.set('license_data', this.licenseData);
    await SystemConfigModel.set('license_last_validated', new Date().toISOString());

    logger.info('License validated successfully', {
      customerId: this.licenseData.customerId,
      plan: this.licenseData.plan,
      maxDevices: this.licenseData.features.maxDevices,
      subscriptionStatus: this.licenseData.subscription.status,
    });

    if (this.licenseData.trial.isTrialMode) {
      const daysLeft = daysBetween(new Date(this.licenseData.trial.expiresAt!), new Date());
      logger.info('Trial mode active', { daysRemaining: Math.max(0, daysLeft) });
    }
  }

  /**
   * Validate license JWT
   */
  public async validateLicense(licenseKey: string): Promise<LicenseData> {
    try {
      // Validate that we have a proper public key
      if (!LicenseValidator.PUBLIC_KEY || LicenseValidator.PUBLIC_KEY.length < 100) {
        throw new Error('LICENSE_PUBLIC_KEY is not configured or invalid. Please set a valid RSA public key.');
      }

      // Ensure the key has proper PEM format
      if (!LicenseValidator.PUBLIC_KEY.includes('-----BEGIN PUBLIC KEY-----')) {
        throw new Error('LICENSE_PUBLIC_KEY must be in PEM format (-----BEGIN PUBLIC KEY-----)');
      }

      const decoded = jwt.verify(licenseKey, LicenseValidator.PUBLIC_KEY, {
        algorithms: ['RS256'], // Asymmetric signing
      }) as LicenseData;

      // SECURITY: Explicit expiry check (defense-in-depth)
      // Check standard JWT 'exp' field first (do not rely solely on JWT library)
      const now = Math.floor(Date.now() / 1000);
      if (decoded.exp && now > decoded.exp) {
        const daysExpired = Math.floor((now - decoded.exp) / 86400);
        throw new Error(`License expired ${daysExpired} days ago (JWT exp: ${decoded.exp})`);
      }

      // Check custom expiresAt field (legacy/additional check)
      if (decoded.expiresAt && decoded.expiresAt < Date.now() / 1000) {
        throw new Error('License has expired');
      }

      // Check subscription status
      if (decoded.subscription.status === 'canceled') {
        throw new Error('Subscription has been canceled');
      }

      return decoded;
    } catch (error: any) {
      throw new Error(`License validation failed: ${error.message}`);
    }
  }

  /**
   * Get default unlicensed mode (very limited)
   */
  private getDefaultUnlicensedMode(): LicenseData {
    const unlicensedTrialDays = 7;
    const expiresAtDate = new Date(Date.now() + unlicensedTrialDays * MS_PER_DAY);
    const expiresAtIso = expiresAtDate.toISOString();

    return {
      customerId: 'unlicensed',
      customerName: 'Unlicensed Mode',
      plan: 'trial',
      features: {
        // Very limited for unlicensed mode
        maxDevices: 2,
        canExecuteJobs: true,
        canScheduleJobs: false,
        canRemoteAccess: true,
        canOtaUpdates: false,
        canExportData: false,
        hasAdvancedAlerts: false,
        hasCustomDashboards: false,
      },
      limits: {
        maxJobTemplates: 5,
        maxAlertRules: 5,
        maxUsers: 1,
      },
      trial: {
        isTrialMode: true,
        expiresAt: expiresAtIso,
      },
      subscription: {
        status: 'trialing',
        currentPeriodEndsAt: expiresAtIso,
      },
      issuedAt: Date.now() / 1000,
      expiresAt: Math.floor(expiresAtDate.getTime() / 1000),
    };
  }

  /**
   * Get current license data.
   * Throws if init() has not been called or has not completed successfully.
   */
  getLicense(): LicenseData {
    if (!this.licenseData) {
      throw new Error('License not initialized. Call init() first.');
    }
    return this.licenseData;
  }

  /**
   * Check if feature is enabled
   */
  hasFeature(feature: BooleanFeatureKey): boolean {
    return this.getLicense().features[feature] === true;
  }

  /**
   * Dynamic feature flag check for forward compatibility when new boolean flags are added.
   */
  hasFeatureFlag(feature: string): boolean {
    const featureValue = (this.getLicense().features as Record<string, unknown>)[feature];
    return featureValue === true;
  }

  /**
   * Get feature limit
   */
  getLimit(limit: keyof LicenseData['limits']): number | undefined {
    return this.getLicense().limits[limit];
  }

  /**
   * Check if license is in trial mode
   */
  isTrialMode(): boolean {
    return this.getLicense().trial.isTrialMode;
  }

  /**
   * Check if subscription is active
   */
  isSubscriptionActive(): boolean {
    const status = this.getLicense().subscription.status;
    return status === 'active' || status === 'trialing';
  }

  /**
   * Get days until trial expires (returns null if not in trial)
   */
  getTrialDaysRemaining(): number | null {
    const license = this.getLicense();
    if (!license.trial.isTrialMode || !license.trial.expiresAt) {
      return null;
    }

    const daysLeft = daysBetween(new Date(license.trial.expiresAt), new Date());

    return Math.max(0, daysLeft);
  }
}
