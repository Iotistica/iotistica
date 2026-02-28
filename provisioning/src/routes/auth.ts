/**
 * Authentication Routes (Provisioning Service)
 * Handles password reset token validation for customer instances
 */

import express, { Request, Response } from 'express';
import bcrypt from 'bcrypt';
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

export default router;
