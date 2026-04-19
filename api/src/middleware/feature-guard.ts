/**
 * Feature Guard Middleware
 * Enforces license-based feature flags and usage limits
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { LicenseValidator } from '../services/auth/license-validator';

// Type for boolean feature keys only
type BooleanFeatureKey = 'canExecuteJobs' | 'canScheduleJobs' | 'canRemoteAccess' | 'canOtaUpdates' | 'canExportData' | 'hasAdvancedAlerts' | 'hasCustomDashboards';

/**
 * Middleware to check if feature is enabled (boolean features only)
 */
export function requireFeature(feature: BooleanFeatureKey) {
  return async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const license = LicenseValidator.getInstance();
    if (!license.hasFeature(feature)) {
      return reply.status(403).send({
        error: 'Feature not available',
        message: `This feature requires a higher plan. Current plan: ${license.getLicense().plan}`,
        feature,
        upgradeUrl: process.env.BILLING_UPGRADE_URL || 'https://iotistica.com/upgrade',
      });
    }
  };
}

/**
 * Middleware to check device limit
 */
export async function checkAgentLimit(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const license = LicenseValidator.getInstance();
  const maxDevices = license.getLicense().features.maxDevices;

  const { AgentModel: AgentModel } = await import('../services/agent/agents');
  const agents = await AgentModel.list({ isActive: true });

  if (agents.length >= maxDevices) {
    return reply.status(403).send({
      error: 'Device limit reached',
      message: `Maximum agents (${maxDevices}) reached. Upgrade your plan to add more agents.`,
      currentDevices: agents.length,
      maxDevices,
      upgradeUrl: process.env.BILLING_UPGRADE_URL || 'https://iotistica.com/upgrade',
    });
  }
}

/**
 * Middleware to check subscription status
 */
export function requireActiveSubscription(_request: FastifyRequest, reply: FastifyReply): void {
  const license = LicenseValidator.getInstance();
  if (!license.isSubscriptionActive()) {
    reply.status(402).send({
      error: 'Subscription inactive',
      message: 'Your subscription is not active. Please update your payment method.',
      status: license.getLicense().subscription.status,
      billingUrl: process.env.BILLING_PORTAL_URL || 'https://iotistica.com/billing',
    });
  }
}

/**
 * Middleware to check subscription with grace period and read-only mode support.
 *
 * Modes:
 * - 'strict':    Block all requests if subscription expired (after grace period)
 * - 'read-only': Allow GET requests even after grace period, block writes
 * - 'graceful':  Allow all requests with warning headers during grace period
 */
export function requireValidSubscription(mode: 'strict' | 'read-only' | 'graceful' = 'strict') {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const license = LicenseValidator.getInstance();
    const state = license.getSubscriptionState();

    if (state === 'active' || state === 'trial_active') return;

    if (state === 'trial_grace') {
      const daysRemaining = license.getGracePeriodDaysRemaining();
      reply.header('X-Subscription-Warning', `Trial expired. ${daysRemaining} days remaining in grace period.`);
      reply.header('X-Subscription-State', state);
      reply.header('X-Grace-Days-Remaining', String(daysRemaining || 0));
      return; // graceful, strict, and read-only all proceed during grace period
    }

    if (state === 'expired') {
      const licenseData = license.getLicense();

      if (mode === 'read-only' && request.method === 'GET') {
        reply.header('X-Subscription-Status', 'read-only');
        reply.header('X-Subscription-State', state);
        reply.header('X-Subscription-Message', 'Read-only mode: Trial expired. Upgrade to restore full access.');
        return;
      }

      return reply.status(402).send({
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
  };
}
