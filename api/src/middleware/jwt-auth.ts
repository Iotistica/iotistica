/**
 * JWT Authentication Middleware
 * 
 * Provides JWT-based authentication for dashboard users
 * Supports both access tokens (short-lived) and refresh tokens (long-lived)
 * 
 * Usage:
 *   router.get('/dashboard/devices', jwtAuth, async (req, res) => {
 *     // req.user contains authenticated user info
 *   });
 */

import { Request, Response, NextFunction } from 'express';
import jwt, { Secret } from 'jsonwebtoken';
import { query } from '../db/connection';

// JWT Configuration
const JWT_SECRET: Secret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_ACCESS_TOKEN_EXPIRY = (process.env.JWT_ACCESS_TOKEN_EXPIRY || '15m') as string;
const JWT_REFRESH_TOKEN_EXPIRY = (process.env.JWT_REFRESH_TOKEN_EXPIRY || '7d') as string;

// Extend Express Request to include user info
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: number;
        username: string;
        email: string;
        role: string;
        isActive: boolean;
      };
    }
  }
}

export interface JWTPayload {
  userId: number;
  username: string;
  email: string;
  role: string;
  type: 'access' | 'refresh';
}

/**
 * Generate JWT access token (short-lived)
 */
export function generateAccessToken(user: {
  id: number;
  username: string;
  email: string;
  role: string;
}): string {
  const payload: JWTPayload = {
    userId: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    type: 'access'
  };

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_ACCESS_TOKEN_EXPIRY as any,
    issuer: 'iotistic-api',
    audience: 'iotistic-dashboard'
  });
}

/**
 * Generate JWT refresh token (long-lived)
 */
export function generateRefreshToken(user: {
  id: number;
  username: string;
  email: string;
  role: string;
}): string {
  const payload: JWTPayload = {
    userId: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    type: 'refresh'
  };

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_REFRESH_TOKEN_EXPIRY as any,
    issuer: 'iotistic-api',
    audience: 'iotistic-dashboard'
  });
}

/**
 * Verify and decode JWT token
 */
export function verifyToken(token: string): JWTPayload {
  try {
    return jwt.verify(token, JWT_SECRET, {
      issuer: 'iotistic-api',
      audience: 'iotistic-dashboard'
    }) as JWTPayload;
  } catch (error: any) {
    throw new Error(`Invalid token: ${error.message}`);
  }
}

/**
 * JWT Authentication Middleware
 * 
 * Expects: Authorization: Bearer <token> header
 * Sets: req.user with authenticated user information
 */
export async function jwtAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const startTime = Date.now();
  console.log('[JWT-AUTH] *** MIDDLEWARE CALLED ***', {
    method: req.method,
    path: req.path,
    fullUrl: req.originalUrl,
    hasAuthHeader: !!req.headers.authorization
  });
  
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('[JWT-AUTH] No valid auth header, rejecting');
      res.status(401).json({
        error: 'Unauthorized',
        message: 'JWT token required. Send in Authorization: Bearer <token> header.'
      });
      return;
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    console.log('[JWT-AUTH] Token extracted, verifying...');
    
    // Verify token
    let payload: JWTPayload;
    try {
      payload = verifyToken(token);
      console.log('[JWT-AUTH] Token verified successfully for user:', payload.username);
    } catch (error: any) {
      console.log('[JWT-AUTH] Token verification failed:', error.message);
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or expired token',
        details: error.message
      });
      return;
    }

    // Ensure it's an access token
    if (payload.type !== 'access') {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token type. Use access token for API requests.'
      });
      return;
    }

    // Fetch user from database to ensure they still exist and are active
    const result = await query(
      `SELECT id, username, email, role, is_active, last_login_at
       FROM users
       WHERE id = $1`,
      [payload.userId]
    );

    if (result.rows.length === 0) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User not found'
      });
      return;
    }

    const user = result.rows[0];

    // Check if user is active
    if (!user.is_active) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'User account is inactive. Contact administrator.'
      });
      return;
    }

    // Attach user info to request
    req.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      isActive: user.is_active
    };

    // Proceed to route handler
    next();

  } catch (error: any) {
    console.error('JWT authentication error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Authentication failed'
    });
  }
}

/**
 * Role-based authorization middleware
 * Use after jwtAuth middleware
 * 
 * Example:
 *   router.delete('/users/:id', jwtAuth, requireRole('admin'), handler)
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'jwtAuth middleware must be applied before requireRole'
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: 'Forbidden',
        message: `Insufficient permissions. Required role: ${allowedRoles.join(' or ')}`
      });
      return;
    }

    next();
  };
}

/**
 * Optional authentication middleware
 * Attaches user if token is valid, but doesn't reject if missing
 * Useful for endpoints that behave differently for authenticated users
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // No token provided - continue without user
    next();
    return;
  }

  try {
    const token = authHeader.substring(7);
    const payload = verifyToken(token);

    if (payload.type === 'access') {
      const result = await query(
        'SELECT id, username, email, role, is_active FROM users WHERE id = $1',
        [payload.userId]
      );

      if (result.rows.length > 0 && result.rows[0].is_active) {
        req.user = {
          id: result.rows[0].id,
          username: result.rows[0].username,
          email: result.rows[0].email,
          role: result.rows[0].role,
          isActive: result.rows[0].is_active
        };
      }
    }
  } catch (error) {
    // Invalid token - just continue without user
    console.warn('Optional auth failed:', error);
  }

  next();
}

export default jwtAuth;
