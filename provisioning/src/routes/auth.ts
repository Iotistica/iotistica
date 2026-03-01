/**
 * Authentication Routes (Provisioning Service)
 * Handles password reset token validation for customer instances
 * Also handles Auth0 SPA callback flow
 */

import express, { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import axios from 'axios';
import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import { CustomerModel } from '../db/customer-model';
import { logger } from '../utils/logger';

const router = express.Router();

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

    // Step 3: Generate JWT for dashboard/API
    // For Phase 2, create a minimal JWT with Auth0 user info
    // Phase 3 will add multi-tenant assignment and real role lookup
    
    const JWT_SECRET: Secret = process.env.JWT_SECRET || 'test-secret-key';
    
    // Generate access token with Auth0 user info
    // Note: userId is 0 as placeholder (Phase 3 will integrate with user database)
    const accessToken = jwt.sign(
      {
        userId: 0, // Placeholder: will be replaced in Phase 3 with real user ID
        username: auth0Sub,
        email: email,
        role: 'user', // Placeholder: will be set from RBAC in Phase 3
        auth0Sub: auth0Sub,
        type: 'access'
      },
      JWT_SECRET,
      {
        expiresIn: '15m',
        issuer: 'iotistic-api',
        audience: 'iotistic-dashboard'
      }
    );

    // Generate refresh token similarly
    const refreshToken = jwt.sign(
      {
        userId: 0,
        username: auth0Sub,
        email: email,
        role: 'user',
        auth0Sub: auth0Sub,
        type: 'refresh'
      },
      JWT_SECRET,
      {
        expiresIn: '7d',
        issuer: 'iotistic-api',
        audience: 'iotistic-dashboard'
      }
    );

    res.json({
      data: {
        accessToken,
        refreshToken,
        user: {
          id: 0, // Placeholder
          auth0Sub,
          email,
          name,
          role: 'user'
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

export default router;
