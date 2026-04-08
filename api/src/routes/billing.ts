/**
 * Billing Routes
 * Handle subscription upgrades and billing integration with Global Billing API
 */

import type { FastifyPluginAsync } from 'fastify';
import { BillingClient } from '../services/billing-client';
import { LicenseValidator } from '../services/auth/license-validator';
import { jwtAuth } from '../middleware/jwt-auth';
import logger from '../utils/logger';

type UpgradeBody = {
  plan?: string;
};

const allowedPlans = ['starter', 'professional', 'enterprise'] as const;
type BillingPlan = (typeof allowedPlans)[number];

function isBillingPlan(value: string): value is BillingPlan {
  return (allowedPlans as readonly string[]).includes(value);
}

type BillingSessionQuerystring = {
  session_id?: string;
};

const apiVersion = process.env.API_VERSION || 'v1';
const billingRouteBasePath = `/api/${apiVersion}`;

function getHeaderValue(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) {
    return header[0];
  }

  return header;
}

const plugin: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/billing/subscription
   * Get current subscription details
   * REQUIRES AUTHENTICATION
   */
  fastify.get('/subscription', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const billingClient = BillingClient.getInstance();

      if (!billingClient.isConfigured()) {
        return reply.status(503).send({
          error: 'Billing API not configured',
          message: 'Contact your administrator to configure BILLING_API_URL and CUSTOMER_ID',
        });
      }

      const license = LicenseValidator.getInstance();
      const licenseData = license.getLicense();

      // Get subscription from billing API
      const subscription = await billingClient.getSubscription();

      return reply.send({
        license: licenseData,
        subscription,
      });
    } catch (error: any) {
      logger.error('Error fetching subscription', { error: error.message, stack: error.stack });
      return reply.status(500).send({ error: error.message });
    }
  });

  /**
   * POST /api/billing/upgrade
   * Create Stripe checkout session for plan upgrade
   * REQUIRES AUTHENTICATION
   */
  fastify.post<{ Body: UpgradeBody }>('/upgrade', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { plan } = req.body;

      if (!plan || !isBillingPlan(plan)) {
        return reply.status(400).send({
          error: 'Invalid plan. Choose: starter, professional, enterprise'
        });
      }

      const billingClient = BillingClient.getInstance();

      if (!billingClient.isConfigured()) {
        return reply.status(503).send({
          error: 'Billing API not configured',
          message: 'Contact your administrator to configure BILLING_API_URL and CUSTOMER_ID',
        });
      }

      // Create checkout session
      const host = getHeaderValue(req.headers.host);
      const forwardedProto = getHeaderValue(req.headers['x-forwarded-proto']);
      const proto = forwardedProto?.split(',')[0]?.trim() || req.protocol || 'http';

      if (!host) {
        return reply.status(400).send({
          error: 'Invalid request host',
        });
      }

      const baseUrl = `${proto}://${host}`;
      const checkoutSession = await billingClient.createCheckoutSession(
        plan,
        `${baseUrl}${billingRouteBasePath}/success`,
        `${baseUrl}${billingRouteBasePath}/cancel`
      );

      return reply.send({
        checkout_url: checkoutSession.checkout_url,
        session_id: checkoutSession.session_id,
      });
    } catch (error: any) {
      logger.error('Error creating checkout session', { error: error.message, stack: error.stack });
      return reply.status(500).send({ error: error.message });
    }
  });

  /**
   * GET /api/billing/success
   * Redirect after successful payment
   */
  fastify.get<{ Querystring: BillingSessionQuerystring }>('/success', async (req, reply) => {
    const { session_id } = req.query;

    if (!session_id || typeof session_id !== 'string') {
      return reply.status(400).type('text/html').send(`
      <html>
        <head><title>Error</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: red;">Invalid Request</h1>
          <p>Missing or invalid session ID.</p>
          <a href="/" style="color: blue;">Return to Dashboard</a>
        </body>
      </html>
    `);
    }
    try {
      // Refresh license from billing API
      const billingClient = BillingClient.getInstance();
      await billingClient.refreshLicense();

      return reply.type('text/html').send(`
      <html>
        <head><title>Payment Successful</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: green;">Payment Successful!</h1>
          <p>Your subscription has been upgraded.</p>
          <p>New features are now available.</p>
          <a href="/" style="color: blue;">Return to Dashboard</a>
        </body>
      </html>
    `);
    } catch (error: any) {
      logger.error('Error refreshing license after success redirect', { error: error.message, stack: error.stack });
      return reply.status(500).type('text/html').send(`
      <html>
        <head><title>Error</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: red;">Error</h1>
          <p>Payment was successful, but failed to refresh license.</p>
          <p>${error.message}</p>
          <a href="/" style="color: blue;">Return to Dashboard</a>
        </body>
      </html>
    `);
    }
  });

  /**
   * GET /api/billing/cancel
   * Redirect after cancelled payment
   */
  fastify.get<{ Querystring: BillingSessionQuerystring }>('/cancel', async (req, reply) => {
    const { session_id } = req.query;

    if (!session_id || typeof session_id !== 'string') {
      return reply.status(400).type('text/html').send(`
      <html>
        <head><title>Error</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: red;">Invalid Request</h1>
          <p>Missing or invalid session ID.</p>
          <a href="/" style="color: blue;">Return to Dashboard</a>
        </body>
      </html>
    `);
    }
    return reply.type('text/html').send(`
    <html>
      <head><title>Payment Cancelled</title></head>
      <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h1 style="color: orange;">Payment Cancelled</h1>
        <p>You cancelled the payment process.</p>
        <p>Your subscription remains unchanged.</p>
        <a href="/api/billing/subscription" style="color: blue;">View Current Plan</a> |
        <a href="/" style="color: blue;">Return to Dashboard</a>
      </body>
    </html>
  `);
  });

  /**
   * POST /api/billing/refresh-license
   * Manually refresh license from billing API
   * REQUIRES AUTHENTICATION
   */
  fastify.post('/refresh-license', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const billingClient = BillingClient.getInstance();

      if (!billingClient.isConfigured()) {
        return reply.status(503).send({
          error: 'Billing API not configured',
        });
      }

      await billingClient.refreshLicense();
      const license = LicenseValidator.getInstance();
      const licenseData = license.getLicense();

      return reply.send({
        message: 'License refreshed successfully',
        license: licenseData,
      });
    } catch (error: any) {
      logger.error('Error refreshing license', { error: error.message, stack: error.stack });
      return reply.status(500).send({ error: error.message });
    }
  });
};

export default plugin;
