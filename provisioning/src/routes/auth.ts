/**
 * Authentication Routes (Provisioning Service)
 * Handles password reset token validation for customer instances
 * Also handles Auth0 SPA callback flow
 */

import express, { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import axios from 'axios';
import jwt, { Secret } from 'jsonwebtoken';
import crypto from 'crypto';
import { CustomerModel } from '../db/customer-model';
import { query } from '../db/connection';
import { logger } from '../utils/logger';
import { deploymentQueue } from '../services/deployment-queue';
import { StripeService } from '../services/stripe-service';

const router = express.Router();
const SIGNUP_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * POST /api/auth/validate-reset-token
 * Validate password reset token (called by customer API instances)
 * 
 * This endpoint is called by customer API instances to validate
 * the reset token before allowing password change.
 */
router.post('/validate-reset-token', async (req: Request, res: Response) => {
  try {
    const { token, customerId } = req.body;

    if (!token || !customerId) {
      return res.status(400).json({
        valid: false,
        error: 'Missing token or customerId',
      });
    }

    // Get customer
    const customer = await CustomerModel.getById(customerId);
    if (!customer) {
      return res.status(404).json({
        valid: false,
        error: 'Customer not found',
      });
    }

    // Check if token exists and hasn't been used
    if (!customer.admin_reset_token_hash) {
      return res.json({
        valid: false,
        error: 'No password reset token found',
      });
    }

    if (customer.admin_reset_token_used) {
      return res.json({
        valid: false,
        error: 'Reset token already used',
      });
    }

    // Check if token expired
    const now = new Date();
    const expiresAt = new Date(customer.admin_reset_token_expires_at!);
    if (now > expiresAt) {
      return res.json({
        valid: false,
        error: 'Reset token expired',
        expiredAt: expiresAt.toISOString(),
      });
    }

    // Verify token hash
    const isValid = await bcrypt.compare(token, customer.admin_reset_token_hash);
    if (!isValid) {
      logger.warn('Invalid password reset token attempt', {
        customerId,
        email: customer.email,
      });

      return res.json({
        valid: false,
        error: 'Invalid reset token',
      });
    }

    // Token is valid
    res.json({
      valid: true,
      email: customer.email,
      expiresAt: expiresAt.toISOString(),
    });

  } catch (error: any) {
    logger.error('Error validating reset token', { error: error.message });
    res.status(500).json({
      valid: false,
      error: 'Failed to validate token',
    });
  }
});

/**
 * POST /api/auth/mark-token-used
 * Mark reset token as used (called by customer API after successful password reset)
 */
router.post('/mark-token-used', async (req: Request, res: Response) => {
  try {
    const { customerId } = req.body;

    if (!customerId) {
      return res.status(400).json({
        error: 'Missing customerId',
      });
    }

    // Mark token as used
    await CustomerModel.markAdminPasswordResetTokenUsed(customerId);

    logger.info('Password reset token marked as used', { customerId });

    res.json({
      success: true,
      message: 'Token marked as used',
    });

  } catch (error: any) {
    logger.error('Error marking token as used', { error: error.message });
    res.status(500).json({
      error: 'Failed to mark token as used',
    });
  }
});

/**
 * POST /api/auth/callback-auth0
 * Handle Auth0 SPA callback (code exchange)
 * 
 * Called by dashboard after Auth0 redirects back with authorization code
 * 1. Exchange code for tokens with Auth0 backend
 * 2. Validate tokens and extract user info
 * 3. Assign user to tenant (or create trial if new)
 * 4. Return JWT for tenant API to use
 * 
 * Body:
 * {
 *   "code": "authorization_code_from_auth0",
 *   "redirectUri": "http://localhost:5173/auth/callback"
 * }
 */
router.post('/callback-auth0', async (req: Request, res: Response) => {
  try {
    const { code, redirectUri } = req.body;

    if (!code || !redirectUri) {
      return res.status(400).json({
        error: 'Missing code or redirectUri',
      });
    }

    // Environment check
    const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
    const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID;
    const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET;

    if (!AUTH0_DOMAIN || !AUTH0_CLIENT_ID || !AUTH0_CLIENT_SECRET) {
      logger.error('Auth0 not configured', {
        hasDomain: !!AUTH0_DOMAIN,
        hasClientId: !!AUTH0_CLIENT_ID,
        hasClientSecret: !!AUTH0_CLIENT_SECRET,
      });
      return res.status(500).json({
        error: 'Auth0 not configured on server',
      });
    }

    // Step 1: Exchange code for tokens with Auth0
    logger.info('[Auth0] Exchanging code for tokens');

    let tokenResponse;
    try {
      tokenResponse = await axios.post(
        `https://${AUTH0_DOMAIN}/oauth/token`,
        {
          client_id: AUTH0_CLIENT_ID,
          client_secret: AUTH0_CLIENT_SECRET,
          audience: process.env.AUTH0_AUDIENCE,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );
    } catch (error: any) {
      logger.error('[Auth0] Code exchange failed', {
        error: error.response?.data || error.message,
      });
      return res.status(401).json({
        error: 'Failed to exchange Auth0 code',
        details: error.response?.data?.error_description || error.message,
      });
    }

    const { access_token, id_token } = tokenResponse.data;

    // Step 2: Parse ID token to get user info
    // Note: We should validate the ID token signature, but for now we trust Auth0 since we got it via backend channel
    let userInfo;
    try {
      const parts = id_token.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid JWT format');
      }
      userInfo = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    } catch (error: any) {
      logger.error('[Auth0] Failed to parse ID token', { error: error.message });
      return res.status(401).json({
        error: 'Failed to parse user info from Auth0',
      });
    }

    const auth0Sub = userInfo.sub;
    const email = userInfo.email;
    const name = userInfo.name || email;

    logger.info('[Auth0] User authenticated', { auth0Sub, email });

    // Step 3: Resolve tenant + role from centralized RBAC table (Phase 3)
    let membershipResult = await query(
      `SELECT 
         utr.id,
         utr.auth0_sub,
         utr.customer_id,
         utr.role,
         utr.created_at,
         utr.updated_at,
         c.deployment_status,
         c.is_active
       FROM user_tenant_roles utr
       JOIN customers c ON c.customer_id = utr.customer_id
       WHERE utr.auth0_sub = $1
       ORDER BY
         CASE
           WHEN c.is_active = true AND c.deployment_status = 'ready' THEN 0
           WHEN c.is_active = true THEN 1
           ELSE 2
         END,
         utr.updated_at DESC
       LIMIT 1`,
      [auth0Sub]
    );

    // Auto-link first login by matching customer email when no membership exists yet
    if (membershipResult.rows.length === 0) {
      const autoLink = await query(
        `INSERT INTO user_tenant_roles (auth0_sub, customer_id, role, created_by)
         SELECT $1, c.customer_id, 'admin', 'auth0_auto_link'
         FROM customers c
         WHERE LOWER(c.email) = LOWER($2)
         ON CONFLICT (auth0_sub, customer_id) DO NOTHING
         RETURNING id, auth0_sub, customer_id, role, created_at, updated_at`,
        [auth0Sub, email]
      );

      if (autoLink.rows.length > 0) {
        membershipResult = await query(
          `SELECT 
             utr.id,
             utr.auth0_sub,
             utr.customer_id,
             utr.role,
             utr.created_at,
             utr.updated_at,
             c.deployment_status,
             c.is_active
           FROM user_tenant_roles utr
           JOIN customers c ON c.customer_id = utr.customer_id
           WHERE utr.id = $1
           LIMIT 1`,
          [autoLink.rows[0].id]
        );
      }
    }

    if (membershipResult.rows.length === 0) {
      return res.status(403).json({
        error: 'needs_signup',
        message: 'Please complete your account setup',
        auth0User: {
          sub: auth0Sub,
          email: email,
          name: name
        }
      });
    }

    const membership = membershipResult.rows[0];

    if (!membership.is_active) {
      return res.status(403).json({
        error: 'Customer suspended',
        message: `Customer ${membership.customer_id} is suspended`,
      });
    }

    const JWT_SECRET: Secret = process.env.JWT_SECRET || 'test-secret-key';
    const accessExpiry = process.env.JWT_ACCESS_TOKEN_EXPIRY || '15m';
    const refreshExpiry = process.env.JWT_REFRESH_TOKEN_EXPIRY || '7d';

    // Step 4: Generate JWT with real user/tenant claims
    const accessToken = jwt.sign(
      {
        userId: membership.id,
        username: auth0Sub,
        email,
        role: membership.role,
        auth0Sub,
        customerId: membership.customer_id,
        type: 'access'
      },
      JWT_SECRET,
      {
        expiresIn: accessExpiry as any,
        issuer: 'iotistic-api',
        audience: 'iotistic-dashboard'
      }
    );

    const refreshToken = jwt.sign(
      {
        userId: membership.id,
        username: auth0Sub,
        email,
        role: membership.role,
        auth0Sub,
        customerId: membership.customer_id,
        type: 'refresh'
      },
      JWT_SECRET,
      {
        expiresIn: refreshExpiry as any,
        issuer: 'iotistic-api',
        audience: 'iotistic-dashboard'
      }
    );

    res.json({
      data: {
        accessToken,
        refreshToken,
        user: {
          id: membership.id,
          auth0Sub,
          customerId: membership.customer_id,
          email,
          name,
          role: membership.role
        },
      },
    });

  } catch (error: any) {
    logger.error('[Auth0] Callback handler error', { error: error.message });
    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

/**
 * POST /api/auth/start-signup
 * Generate signed Auth0 authorization URL for customer signup flow
 */
router.post('/start-signup', async (req: Request, res: Response) => {
  try {
    const { email, company, plan } = req.body || {};

    if (!email || !company) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'email and company are required',
      });
    }

    const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
    const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID;
    const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
    const SIGNUP_CALLBACK_URL = process.env.AUTH0_SIGNUP_CALLBACK_URL || `${BASE_URL}/api/auth/signup-callback`;
    const STATE_SECRET = process.env.AUTH0_STATE_SECRET || process.env.AUTH0_CLIENT_SECRET;

    if (!AUTH0_DOMAIN || !AUTH0_CLIENT_ID || !STATE_SECRET) {
      logger.error('[Start Signup] Auth0 or state signing secret not configured');
      return res.status(500).json({
        error: 'Auth0 not configured',
      });
    }

    const normalizedPlan = typeof plan === 'string' && plan.length > 0 ? plan : 'starter';
    const statePayload = {
      email,
      company,
      plan: normalizedPlan,
      timestamp: new Date().toISOString(),
      nonce: crypto.randomBytes(16).toString('hex'),
    };

    const payloadB64 = Buffer.from(JSON.stringify(statePayload)).toString('base64url');
    const signatureB64 = crypto
      .createHmac('sha256', STATE_SECRET)
      .update(payloadB64)
      .digest('base64url');
    const signedState = `${payloadB64}.${signatureB64}`;

    const auth0Url = `https://${AUTH0_DOMAIN}/authorize?` +
      `response_type=code&` +
      `client_id=${encodeURIComponent(AUTH0_CLIENT_ID)}&` +
      `redirect_uri=${encodeURIComponent(SIGNUP_CALLBACK_URL)}&` +
      `scope=${encodeURIComponent('openid profile email')}&` +
      `screen_hint=signup&` +
      `login_hint=${encodeURIComponent(email)}&` +
      `state=${encodeURIComponent(signedState)}`;

    return res.json({
      auth0Url,
    });
  } catch (error: any) {
    logger.error('[Start Signup] Failed to generate Auth0 URL', { error: error.message });
    return res.status(500).json({
      error: 'Failed to start signup flow',
    });
  }
});

/**
 * GET /api/auth/signup-callback
 * Handles Auth0 redirect for new customer signups
 * Receives code and state (signup data) from Auth0, creates customer, queues deployment
 */
router.get('/signup-callback', async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;
    const WEBSITE_URL = process.env.WEBSITE_URL || 'http://localhost:3000';
    const SIGNUP_PAGE_URL = `${WEBSITE_URL.replace(/\/$/, '')}/signup.html`;

    if (!code || !state) {
      return res.status(400).send(`
        <html><head><title>Signup Error</title></head><body>
          <h1>Signup Error</h1>
          <p>Missing authorization code or state parameter.</p>
          <a href="${WEBSITE_URL}">Back to Home</a>
        </body></html>
      `);
    }

    // Validate and decode signed signup state payload
    let signupData;
    try {
      const STATE_SECRET = process.env.AUTH0_STATE_SECRET || process.env.AUTH0_CLIENT_SECRET;
      if (!STATE_SECRET) {
        throw new Error('State signing secret not configured');
      }

      const stateValue = decodeURIComponent(String(state));
      const stateParts = stateValue.split('.');
      if (stateParts.length !== 2) {
        throw new Error('Malformed state payload');
      }

      const payloadB64 = stateParts[0];
      const providedSigB64 = stateParts[1];
      const expectedSigB64 = crypto
        .createHmac('sha256', STATE_SECRET)
        .update(payloadB64)
        .digest('base64url');

      const providedSig = Buffer.from(providedSigB64, 'base64url');
      const expectedSig = Buffer.from(expectedSigB64, 'base64url');
      if (providedSig.length !== expectedSig.length || !crypto.timingSafeEqual(providedSig, expectedSig)) {
        throw new Error('Invalid state signature');
      }

      signupData = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

      const timestamp = Date.parse(signupData.timestamp || '');
      if (!timestamp || Number.isNaN(timestamp) || (Date.now() - timestamp) > SIGNUP_STATE_TTL_MS) {
        throw new Error('Expired or invalid signup state');
      }
    } catch (e) {
      return res.status(400).send(`
        <html><head><title>Signup Error</title></head><body>
          <h1>Signup Error</h1>
          <p>Invalid or expired signup state.</p>
          <a href="${WEBSITE_URL}">Back to Home</a>
        </body></html>
      `);
    }

    const { email, company, plan } = signupData;

    if (!email || !company) {
      return res.status(400).send(`
        <html><head><title>Signup Error</title></head><body>
          <h1>Signup Error</h1>
          <p>Missing email or company name.</p>
          <a href="${WEBSITE_URL}">Back to Home</a>
        </body></html>
      `);
    }

    // Exchange Auth0 code for tokens
    const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
    const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID;
    const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET;
    const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
    const SIGNUP_CALLBACK_URL = process.env.AUTH0_SIGNUP_CALLBACK_URL || `${BASE_URL}/api/auth/signup-callback`;

    if (!AUTH0_DOMAIN || !AUTH0_CLIENT_ID || !AUTH0_CLIENT_SECRET) {
      logger.error('[Signup Callback] Auth0 not configured');
      return res.status(500).send(`
        <html><head><title>Configuration Error</title></head><body>
          <h1>Configuration Error</h1>
          <p>Auth0 is not properly configured.</p>
          <a href="${WEBSITE_URL}">Back to Home</a>
        </body></html>
      `);
    }

    let tokenResponse;
    try {
      tokenResponse = await axios.post(
        `https://${AUTH0_DOMAIN}/oauth/token`,
        {
          client_id: AUTH0_CLIENT_ID,
          client_secret: AUTH0_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: SIGNUP_CALLBACK_URL,
        },
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (error: any) {
      logger.error('[Signup Callback] Token exchange failed', { error: error.response?.data || error.message });
      const WEBSITE_URL = process.env.WEBSITE_URL || 'http://localhost:3000';
      return res.status(401).send(`
        <html><head><title>Authentication Error</title></head><body>
          <h1>Authentication Error</h1>
          <p>Failed to verify your authentication.</p>
          <a href="${WEBSITE_URL}">Back to Home</a>
        </body></html>
      `);
    }

    const accessToken = tokenResponse.data.access_token;

    // Get user info from Auth0
    let userInfo;
    try {
      const userInfoResponse = await axios.get(
        `https://${AUTH0_DOMAIN}/userinfo`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      userInfo = userInfoResponse.data;
    } catch (error: any) {
      logger.error('[Signup Callback] Failed to get user info', { error: error.message });
      const WEBSITE_URL = process.env.WEBSITE_URL || 'http://localhost:3000';
      return res.status(401).send(`
        <html><head><title>Authentication Error</title></head><body>
          <h1>Authentication Error</h1>
          <p>Failed to retrieve user information.</p>
          <a href="${WEBSITE_URL}">Back to Home</a>
        </body></html>
      `);
    }

    const auth0Sub = userInfo.sub;
    const userName = userInfo.name || email;

    logger.info('[Signup Callback] Creating customer', { auth0Sub, email, company });

    // Check if user already has a tenant
    const existingMembership = await query(
      `SELECT customer_id FROM user_tenant_roles WHERE auth0_sub = $1 LIMIT 1`,
      [auth0Sub]
    );

    if (existingMembership.rows.length > 0) {
      const params = new URLSearchParams({
        error: 'account_exists',
        message: 'This account is already registered.',
      });
      return res.redirect(302, `${SIGNUP_PAGE_URL}?${params.toString()}`);
    }

    // Check if email already used
    const existingCustomer = await query(
      `SELECT customer_id FROM customers WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );

    if (existingCustomer.rows.length > 0) {
      const params = new URLSearchParams({
        error: 'email_registered',
        message: 'This email address is already associated with an account.',
      });
      return res.redirect(302, `${SIGNUP_PAGE_URL}?${params.toString()}`);
    }

    // Generate customer ID (hash of email for uniqueness)
    const cryptoModule = await import('crypto');
    const customerId = 'customer-' + cryptoModule.createHash('sha256').update(email).digest('hex').substring(0, 12);

    // Create customer record
    const customerInsertResult = await query(
      `INSERT INTO customers (
        customer_id, email, company_name, full_name, 
        deployment_status, is_active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING customer_id`,
      [customerId, email, company, userName, 'pending', true]
    );

    if (customerInsertResult.rows.length === 0) {
      throw new Error('Failed to create customer record');
    }

    logger.info('[Signup Callback] Customer created', { customerId });

    // Create user-tenant role assignment (admin)
    await query(
      `INSERT INTO user_tenant_roles (auth0_sub, customer_id, role, created_by, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [auth0Sub, customerId, 'admin', 'self_signup']
    );

    logger.info('[Signup Callback] Admin role assigned', { customerId, auth0Sub });

    // Handle trial vs paid plans
    if (plan === 'trial') {
      // Free trial - create subscription directly without payment
      logger.info('[Signup Callback] Creating trial subscription', { customerId });

      try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

        // Create or get Stripe customer
        const customers = await stripe.customers.list({ email, limit: 1 });
        let stripeCustomerId: string;

        if (customers.data.length > 0) {
          stripeCustomerId = customers.data[0].id;
          logger.info('[Signup Callback] Found existing Stripe customer', { stripeCustomerId });
        } else {
          const stripeCustomer = await stripe.customers.create({
            email,
            name: company || userName,
            metadata: {
              customer_id: customerId,
              company_name: company,
            },
          });
          stripeCustomerId = stripeCustomer.id;
          logger.info('[Signup Callback] Created Stripe customer', { stripeCustomerId });
        }

        // Link Stripe customer to our customer record
        await query(
          `UPDATE customers SET stripe_customer_id = $1, updated_at = CURRENT_TIMESTAMP WHERE customer_id = $2 RETURNING *`,
          [stripeCustomerId, customerId]
        );

        // Create trial subscription (14 days, no payment required, auto-cancel if not upgraded)
        const trialEndTimestamp = Math.floor(Date.now() / 1000) + (14 * 24 * 60 * 60); // 14 days from now
        const subscription = await stripe.subscriptions.create({
          customer: stripeCustomerId,
          items: [{ price: process.env.STRIPE_PRICE_STARTER }], // Use starter price for trial
          trial_end: trialEndTimestamp,
          cancel_at_period_end: true, // Auto-cancel if no payment method added
          metadata: {
            customer_id: customerId,
            plan: 'trial',
            is_trial: 'true',
          },
        });

        logger.info('[Signup Callback] Trial subscription created', {
          customerId,
          subscriptionId: subscription.id,
          trialEnd: new Date(subscription.trial_end! * 1000).toISOString(),
        });

        // Webhook will fire customer.subscription.created and trigger K8s deployment
        // Redirect to success page
        const WEBSITE_URL = process.env.WEBSITE_URL || 'http://localhost:3000';
        return res.send(`
          <html>
            <head>
              <title>Trial Started</title>
              <meta http-equiv="refresh" content="3;url=${WEBSITE_URL}/success.html">
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial; background: #0a0e27; color: #e4e8f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                .container { text-align: center; max-width: 500px; padding: 2rem; }
                h1 { color: #3b82f6; margin-bottom: 1rem; }
                p { color: #9ca3af; line-height: 1.6; }
              </style>
            </head>
            <body>
              <div class="container">
                <h1>✅ Trial Started!</h1>
                <p>Your 14-day free trial has been activated. Your platform is being set up and will be ready in 5-10 minutes.</p>
                <p>Redirecting to confirmation page...</p>
              </div>
            </body>
          </html>
        `);
      } catch (trialError: any) {
        logger.error('[Signup Callback] Failed to create trial subscription', {
          customerId,
          error: trialError.message,
        });

        const WEBSITE_URL = process.env.WEBSITE_URL || 'http://localhost:3000';
        return res.status(500).send(`
          <html><head><title>Trial Setup Error</title></head><body>
            <h1>Trial Setup Error</h1>
            <p>We couldn't set up your trial subscription. Please try again or contact support.</p>
            <p>Error: ${trialError.message}</p>
            <a href="${WEBSITE_URL}">Back to Home</a>
          </body></html>
        `);
      }
    }

    // Paid plans - create Stripe checkout session
    try {
      logger.info('[Signup Callback] Creating Stripe checkout session', { customerId, plan });

      const WEBSITE_URL = process.env.WEBSITE_URL || 'http://localhost:3000';
      const session = await StripeService.createCheckoutSession({
        customerId,
        plan: (plan || 'starter') as 'starter' | 'professional' | 'enterprise',
        successUrl: `${WEBSITE_URL}/success.html`, // After payment, redirect to website
        cancelUrl: WEBSITE_URL, // If user cancels, go back to website
      });

      logger.info('[Signup Callback] Stripe checkout created', {
        customerId,
        sessionId: session.id,
      });

      // Redirect to Stripe checkout
      // The Stripe webhook will handle payment and trigger K8s deployment
      return res.redirect(session.url || '');
    } catch (stripeError: any) {
      logger.error('[Signup Callback] Failed to create Stripe checkout', {
        customerId,
        error: stripeError.message,
      });

      const WEBSITE_URL = process.env.WEBSITE_URL || 'http://localhost:3000';
      // Show error page
      return res.status(500).send(`
        <html>
          <head>
            <title>Billing Error</title>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial;
                background: #0a0e27;
                color: #e4e8f0;
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
              }
              .container {
                text-align: center;
                padding: 2rem;
              }
              h1 { color: #ef4444; margin-bottom: 1rem; }
              p { color: #9ba3b4; line-height: 1.6; }
              a {
                display: inline-block;
                margin-top: 1.5rem;
                padding: 1rem 2rem;
                background: #3b82f6;
                color: white;
                text-decoration: none;
                border-radius: 8px;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>⚠️ Billing Setup Error</h1>
              <p>We encountered an error setting up your billing account.</p>
              <p>Please contact support or try again.</p>
              <a href="${WEBSITE_URL}">Back to Home</a>
            </div>
          </body>
        </html>
      `);
    }

  } catch (error: any) {
    logger.error('[Signup Callback] Error', { error: error.message });
    const WEBSITE_URL = process.env.WEBSITE_URL || 'http://localhost:3000';
    return res.status(500).send(`
      <html><head><title>Signup Error</title></head><body>
        <h1>Signup Error</h1>
        <p>An unexpected error occurred during signup.</p>
        <a href="${WEBSITE_URL}">Back to Home</a>
      </body></html>
    `);
  }
});

/** * POST /api/auth/token
 * Exchange Auth0 authorization code for access token
 * Called by website signup flow (SPA callback handler)
 * 
 * This endpoint is needed because the website is a static SPA
 * and cannot safely exchange auth codes directly with Auth0
 * (would expose client secret to browser)
 * 
 * Body:
 * {
 *   "code": "authorization_code_from_auth0"
 * }
 */
router.post('/token', async (req: Request, res: Response) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({
        error: 'Missing authorization code',
      });
    }

    // Environment check
    const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
    const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID;
    const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET;

    if (!AUTH0_DOMAIN || !AUTH0_CLIENT_ID || !AUTH0_CLIENT_SECRET) {
      logger.error('[Token] Auth0 not configured');
      return res.status(500).json({
        error: 'Auth0 not configured on server',
      });
    }

    // Exchange authorization code for tokens
    logger.info('[Token] Exchanging authorization code');

    let tokenResponse;
    try {
      tokenResponse = await axios.post(
        `https://${AUTH0_DOMAIN}/oauth/token`,
        {
          client_id: AUTH0_CLIENT_ID,
          client_secret: AUTH0_CLIENT_SECRET,
          audience: process.env.AUTH0_AUDIENCE,
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: process.env.AUTH0_REDIRECT_URI || `${process.env.WEBSITE_URL || 'http://localhost:3000'}/auth-callback.html`,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );
    } catch (error: any) {
      logger.error('[Token] Code exchange failed', {
        error: error.response?.data || error.message,
        code: code.substring(0, 10) + '***',
      });
      return res.status(401).json({
        error: 'Failed to exchange authorization code',
        details: error.response?.data?.error_description || error.message,
      });
    }

    const { access_token, id_token } = tokenResponse.data;

    logger.info('[Token] Code exchanged successfully');

    // Return the access token to client
    res.json({
      access_token,
      id_token,
      token_type: 'Bearer',
    });

  } catch (error: any) {
    logger.error('[Token] Error', { error: error.message });
    res.status(500).json({
      error: 'Failed to exchange token',
    });
  }
});

/** * POST /api/customers/complete-signup
 * Complete registration after Auth0 authentication
 * Called when new user has no tenant assignment
 */
router.post('/complete-signup', async (req: Request, res: Response) => {
  try {
    const { auth0AccessToken, companyName, planId } = req.body;

    if (!auth0AccessToken || !companyName) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'auth0AccessToken and companyName are required',
      });
    }

    // Verify Auth0 token and get user info
    const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
    let userInfo;
    try {
      const userInfoResponse = await axios.get(
        `https://${AUTH0_DOMAIN}/userinfo`,
        {
          headers: {
            Authorization: `Bearer ${auth0AccessToken}`,
          },
          timeout: 10000,
        }
      );
      userInfo = userInfoResponse.data;
    } catch (error: any) {
      logger.error('[Signup] Failed to verify Auth0 token', {
        error: error.response?.data || error.message,
      });
      return res.status(401).json({
        error: 'Invalid Auth0 token',
        message: 'Could not verify authentication',
      });
    }

    const auth0Sub = userInfo.sub;
    const email = userInfo.email;
    const name = userInfo.name || email;

    logger.info('[Signup] New customer signup', { auth0Sub, email, companyName });

    // Check if user already has a tenant
    const existingMembership = await query(
      `SELECT customer_id FROM user_tenant_roles WHERE auth0_sub = $1 LIMIT 1`,
      [auth0Sub]
    );

    if (existingMembership.rows.length > 0) {
      return res.status(409).json({
        error: 'User already has account',
        message: 'This user is already assigned to a tenant',
      });
    }

    // Check if email already used (prevent duplicate accounts)
    const existingCustomer = await query(
      `SELECT customer_id FROM customers WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );

    if (existingCustomer.rows.length > 0) {
      return res.status(409).json({
        error: 'Email already registered',
        message: 'An account with this email already exists. Please contact support if you need access.',
      });
    }

    // Generate unique customer_id
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(auth0Sub + Date.now()).digest('hex');
    const customerId = `customer-${hash.substring(0, 12)}`;

    // Create customer record
    await query(
      `INSERT INTO customers (
        customer_id,
        email,
        company_name,
        full_name,
        deployment_status,
        is_active
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [customerId, email, companyName, name, 'pending', true]
    );

    logger.info('[Signup] Customer created', { customerId, email });

    // Create user-tenant role assignment (admin)
    await query(
      `INSERT INTO user_tenant_roles (
        auth0_sub,
        customer_id,
        role,
        created_by
      ) VALUES ($1, $2, $3, $4)`,
      [auth0Sub, customerId, 'admin', 'self_signup']
    );

    logger.info('[Signup] User-tenant role created', { auth0Sub, customerId });

    // Queue K8s deployment (GitOps)
    try {
      await deploymentQueue.addDeploymentJob({
        customerId,
        email,
        companyName,
        plan: planId || 'starter', // Default to starter plan
        priority: 3, // High priority for new signups
        metadata: {
          source: 'self_signup',
          auth0Sub,
        },
      });
      logger.info('[Signup] K8s deployment queued', { customerId });
    } catch (queueError: any) {
      logger.error('[Signup] Failed to queue deployment', {
        customerId,
        error: queueError.message,
      });
      // Continue anyway - deployment can be retried later
    }

    // Generate JWT tokens (same as callback-auth0)
    const JWT_SECRET: Secret = process.env.JWT_SECRET || 'test-secret-key';
    const accessExpiry = process.env.JWT_ACCESS_TOKEN_EXPIRY || '15m';
    const refreshExpiry = process.env.JWT_REFRESH_TOKEN_EXPIRY || '7d';

    const accessToken = jwt.sign(
      {
        type: 'access',
        userId: null, // No user ID yet in customer instance
        username: auth0Sub,
        email: email,
        name: name,
        role: 'admin',
        customerId: customerId,
        auth0Sub: auth0Sub,
      },
      JWT_SECRET,
      {
        expiresIn: accessExpiry as any,
        issuer: 'iotistic-api',
        audience: 'iotistic-dashboard'
      }
    );

    const refreshToken = jwt.sign(
      {
        type: 'refresh',
        userId: null,
        username: auth0Sub,
        email: email,
        customerId: customerId,
        auth0Sub: auth0Sub,
      },
      JWT_SECRET,
      {
        expiresIn: refreshExpiry as any,
        issuer: 'iotistic-api',
        audience: 'iotistic-dashboard'
      }
    );

    logger.info('[Signup] Signup complete', { customerId, email });

    res.json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        email,
        name,
        role: 'admin',
        customerId,
      },
    });

  } catch (error: any) {
    logger.error('[Signup] Error during signup', { error: error.message });
    res.status(500).json({
      error: 'Signup failed',
      message: 'An error occurred during account creation',
    });
  }
});

export default router;
