/**
 * Authentication Middleware
 * Protects billing API endpoints
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export interface AuthRequest extends Request {
  customerId?: string;
  isAdmin?: boolean;
}

/**
 * Verify API key for customer instance requests
 * Expects: X-API-Key header
 */
export async function authenticateCustomer(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const apiKey = req.headers['x-api-key'] as string;

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key' });
  }

  try {
    // Extract customer ID from API key
    // Format: cust_<id>_<secret>
    const customerId = extractCustomerIdFromApiKey(apiKey);

    if (!customerId || !(await verifyApiKey(apiKey))) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // Attach customer ID to request
    req.customerId = customerId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

/**
 * Verify admin API key for management operations
 * Expects: Authorization: Bearer <admin_token>
 */
export function authenticateAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers['authorization'] as string;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = authHeader.substring(7);
  const adminToken = process.env.ADMIN_API_TOKEN;

  if (!adminToken) {
    console.error('❌ ADMIN_API_TOKEN not configured!');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  // Constant-time comparison to prevent timing attacks
  if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(adminToken))) {
    return res.status(401).json({ error: 'Invalid admin token' });
  }

  req.isAdmin = true;
  next();
}

/**
 * Extract customer ID from API key
 */
function extractCustomerIdFromApiKey(apiKey: string): string | null {
  // Format: cust_abc123_secret456
  const parts = apiKey.split('_');
  if (parts.length >= 3 && parts[0] === 'cust') {
    return `${parts[0]}_${parts[1]}`;
  }
  return null;
}

/**
 * Verify API key against database
 */
async function verifyApiKey(apiKey: string): Promise<boolean> {
  // Import here to avoid circular dependency
  const { CustomerModel } = await import('../db/customer-model');
  const customer = await CustomerModel.verifyApiKey(apiKey);
  return !!customer;
}

/**
 * Generate secure API key for customer
 */
export function generateApiKey(customerId: string): string {
  const secret = crypto.randomBytes(32).toString('hex');
  return `${customerId}_${secret}`;
}
