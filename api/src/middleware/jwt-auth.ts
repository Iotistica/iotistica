/**
 * JWT Authentication Middleware
 * 
 * Provides JWT-based authentication for dashboard users
 * Supports two modes:
 * 1. Legacy: Local HS256 tokens (for backward compatibility)
 * 2. Auth0: RS256 tokens via JWKS validation (recommended)
 * 
 * Usage:
 *   router.get('/dashboard/devices', jwtAuth, async (req, res) => {
 *     // req.user contains authenticated user info
 *   });
 */

import { Request, Response, NextFunction } from 'express';
import jwt, { Secret } from 'jsonwebtoken';
import { query } from '../db/connection';
import axios from 'axios';

/**
 * Simple in-memory cache with TTL support (replaces node-cache)
 */
class SimpleCache<T> {
  private cache = new Map<string, { value: T; expiry: number }>();

  set(key: string, value: T, ttl?: number): void {
    const expiry = ttl ? Date.now() + ttl * 1000 : Date.now() + 3600 * 1000; // Default 1 hour
    this.cache.set(key, { value, expiry });
  }

  get(key: string): T | undefined {
    const item = this.cache.get(key);
    if (!item) return undefined;
    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      return undefined;
    }
    return item.value;
  }

  del(key: string): void {
    this.cache.delete(key);
  }

  flushAll(): void {
    this.cache.clear();
  }

  keys(): string[] {
    const allKeys = Array.from(this.cache.keys());
    // Filter out expired keys
    return allKeys.filter(key => {
      const item = this.cache.get(key);
      if (!item || Date.now() > item.expiry) {
        this.cache.delete(key);
        return false;
      }
      return true;
    });
  }
}

// JWT Configuration
// CRITICAL: JWT_SECRET must be set in environment - no fallback to prevent security bypass
const JWT_SECRET: Secret = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      'FATAL ERROR: JWT_SECRET environment variable is not set. '
      + 'This is required for authentication security. '
      + 'Set a strong random value: node -e "console.log(require(\"crypto\").randomBytes(32).toString(\"hex\"))"'
    );
  }
  return secret;
})();
const JWT_ACCESS_TOKEN_EXPIRY = (process.env.JWT_ACCESS_TOKEN_EXPIRY || '15m') as string;
const JWT_REFRESH_TOKEN_EXPIRY = (process.env.JWT_REFRESH_TOKEN_EXPIRY || '7d') as string;

// Auth0 Configuration
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || '';
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || '';
const AUTH0_ISSUER = process.env.AUTH0_ISSUER || `https://${AUTH0_DOMAIN}/`;
const AUTH0_ENABLED = process.env.AUTH0_ENABLED === 'true' && AUTH0_DOMAIN && AUTH0_AUDIENCE;

// JWKS cache (1-hour TTL)
const jwksCache = new SimpleCache<any>();

/**
 * Fetch Auth0 JWKS (JSON Web Key Set)
 * Caches for 1 hour to avoid repeated requests
 */
async function getAuth0JWKS(): Promise<any> {
  const cacheKey = 'auth0-jwks';
  const cached = jwksCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  try {
    const response = await axios.get(`${AUTH0_ISSUER}.well-known/jwks.json`, {
      timeout: 5000
    });

    if (!response.data?.keys) {
      throw new Error('Invalid JWKS response: missing keys array');
    }

    // Cache for 1 hour (3600 seconds)
    jwksCache.set(cacheKey, response.data, 3600);
    return response.data;
  } catch (error: any) {
    console.error('[Auth0-JWKS] Failed to fetch JWKS:', error.message);
    throw new Error(`Cannot fetch Auth0 JWKS: ${error.message}`);
  }
}

/**
 * Get Public Key from JWKS by Key ID (kid)
 */
function getPublicKeyFromJWKS(jwks: any, kid: string): string {
  const key = jwks.keys.find((k: any) => k.kid === kid);

  if (!key) {
    throw new Error(`Key ID ${kid} not found in Auth0 JWKS`);
  }

  // Convert JWK to PEM format
  const { createPublicKey } = require('crypto');
  const publicKey = createPublicKey({ key, format: 'jwk' });
  return publicKey.export({ format: 'pem', type: 'spki' });
}

/**
 * Validate Auth0 JWT token
 * 
 * Checks:
 * - Algorithm is RS256 (rejects HS256)
 * - Signature is valid (using JWKS)
 * - Issuer matches AUTH0_ISSUER
 * - Audience matches AUTH0_AUDIENCE
 * - Token not expired
 * 
 * @throws Error if validation fails
 */
export async function validateAuth0JWT(token: string): Promise<{
  sub: string;
  email: string;
  exp: number;
}> {
  if (!AUTH0_ENABLED) {
    throw new Error('Auth0 not enabled (AUTH0_ENABLED must be "true" and AUTH0_DOMAIN/AUTH0_AUDIENCE set)');
  }

  // Decode without verification first to get kid
  const decoded = jwt.decode(token, { complete: true });

  if (!decoded) {
    throw new Error('Invalid JWT format');
  }

  // Validate algorithm is RS256 (reject HS256)
  if (decoded.header?.alg !== 'RS256') {
    throw new Error(`Invalid algorithm: ${decoded.header?.alg} (must be RS256)`);
  }

  // Get Key ID
  const kid = decoded.header?.kid;
  if (!kid) {
    throw new Error('Missing Key ID (kid) in JWT header');
  }

  // Fetch JWKS and get public key
  const jwks = await getAuth0JWKS();
  const publicKey = getPublicKeyFromJWKS(jwks, kid);

  // Verify JWT signature and claims
  const payload = jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: AUTH0_ISSUER,
    audience: AUTH0_AUDIENCE
  }) as any;

  // Additional validation
  if (!payload.sub || !payload.email) {
    throw new Error('Missing required claims: sub or email');
  }

  const exp = Math.floor(Date.now() / 1000);
  if (payload.exp < exp) {
    throw new Error('Token has expired');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    exp: payload.exp
  };
}

// Extend Express Request to include user info
declare global {
  namespace Express {
    interface Request {
      user: {
        // Legacy fields (HS256 local authentication)
        id: number;
        username: string;
        email?: string;
        role: string;
        isActive: boolean;

        // Shared field (both local and Auth0)
        customerId?: string; // Multi-tenancy: customer ID for boundary enforcement
      } | null;
      id?: string; // Request ID for tracking and correlation
    }
  }
}

export interface JWTPayload {
  userId: number;
  username: string;
  email: string;
  role: string;
  auth0Sub?: string;
  customerId?: string;
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
 * Supports two authentication modes:
 * 1. Auth0 (RS256): Extract sub, resolve tenant, fetch role from provisioning
 * 2. Legacy (HS256): Fetch user from local users table
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
  
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'JWT token required. Send in Authorization: Bearer <token> header.'
      });
      return;
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    console.log('[JWT-AUTH] Token extracted, determining type...');
    
    // Detect token type by decoding header (without verification)
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token format'
      });
      return;
    }

    const algorithm = decoded.header?.alg;

    // Try Auth0 first if RS256 and enabled
    if (algorithm === 'RS256' && AUTH0_ENABLED) {
      console.log('[JWT-AUTH] Detected RS256 token, validating with Auth0 JWKS...');
      await handleAuth0Token(req, res, next, token);
      return;
    }

    // Fall back to legacy HS256 local auth
    if (algorithm === 'HS256') {
      console.log('[JWT-AUTH] Detected HS256 token, validating locally...');
      await handleLegacyToken(req, res, next, token);
      return;
    }

    // Unknown algorithm
    res.status(401).json({
      error: 'Unauthorized',
      message: `Unsupported token algorithm: ${algorithm}`
    });

  } catch (error: any) {
    console.error('[JWT-AUTH] Unexpected error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Authentication failed'
    });
  }
}

/**
 * Handle Auth0 RS256 tokens
 * 
 * Flow:
 * 1. Validate JWT signature with Auth0 JWKS
 * 2. Extract auth0_sub
 * 3. Resolve tenant from hostname
 * 4. Fetch role from provisioning RBAC API
 * 5. Check customer status
 * 6. Create synthetic req.user object
 */
async function handleAuth0Token(
  req: Request,
  res: Response,
  next: NextFunction,
  token: string
): Promise<void> {
  try {
    // Step 1: Validate Auth0 JWT
    let auth0Payload: any;
    try {
      auth0Payload = await validateAuth0JWT(token);
      console.log('[JWT-AUTH] Auth0 token validated for user:', auth0Payload.sub);
    } catch (error: any) {
      console.warn('[JWT-AUTH] Auth0 validation failed:', error.message);
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid Auth0 token',
        details: error.message
      });
      return;
    }

    // Step 2: Resolve tenant from hostname (or fallback for dev)
    let customerId: string;
    try {
      const { getTenantIdFromHost } = await import('../services/tenant-resolution.service');
      customerId = getTenantIdFromHost(req.hostname);
      console.log('[JWT-AUTH] Tenant resolved from hostname:', customerId);
    } catch (error: any) {
      // Fallback for development: check X-Tenant-ID header or env var
      const headerTenantId = req.headers['x-tenant-id'] as string | undefined;
      const envTenantId = process.env.DEVELOPMENT_TENANT_ID;
      
      if (req.hostname === 'localhost' && (headerTenantId || envTenantId)) {
        customerId = headerTenantId || envTenantId || 'customer-local';
        console.log('[JWT-AUTH] Using dev fallback tenant:', customerId);
      } else {
        console.warn('[JWT-AUTH] Tenant resolution failed:', error.message);
        res.status(400).json({
          error: 'Bad Request',
          message: 'Cannot determine tenant from hostname. For localhost dev, set X-Tenant-ID header or DEVELOPMENT_TENANT_ID env var',
          details: error.message
        });
        return;
      }
    }

    // Step 3: Fetch role from provisioning
    let roleData: any;
    try {
      const { getRoleAndStatus } = await import('../services/rbac-cache.service');
      roleData = await getRoleAndStatus(auth0Payload.sub, customerId, auth0Payload.exp);
      console.log('[JWT-AUTH] Role fetched:', roleData.role, 'Status:', roleData.customer_status);
    } catch (error: any) {
      console.warn('[JWT-AUTH] Role fetch failed:', error.message);
      res.status(403).json({
        error: 'Forbidden',
        message: 'Cannot determine user role in tenant',
        details: error.message
      });
      return;
    }

    // Step 4: Check customer status
    if (roleData.customer_status === 'suspended') {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Customer account is suspended'
      });
      return;
    }

    // Step 5: Create synthetic user object
    // (Auth0 tokens don't have username/id, so we use auth0_sub as identifier)
    req.user = {
      id: 0,  // Placeholder (Auth0 users don't have local id)
      username: auth0Payload.sub,  // Use sub as username
      email: auth0Payload.email,
      role: roleData.role,
      isActive: roleData.customer_status === 'active',
      customerId: customerId
    };

    console.log('[JWT-AUTH] Auth0 user authenticated:', auth0Payload.sub);
    next();

  } catch (error: any) {
    console.error('[JWT-AUTH] Auth0 token handling error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Authentication failed'
    });
  }
}

/**
 * Handle legacy HS256 local tokens
 * 
 * Flow (backward compatible):
 * 1. Validate signature with JWT_SECRET
 * 2. Look up user from local users table
 * 3. Check user is active
 * 4. Populate req.user
 */
async function handleLegacyToken(
  req: Request,
  res: Response,
  next: NextFunction,
  token: string
): Promise<void> {
  try {
    // Validate token
    let payload: JWTPayload;
    try {
      payload = verifyToken(token);
      console.log('[JWT-AUTH] Legacy token verified for user:', payload.username);
      console.log('[JWT-AUTH] Token payload claims:', {
        type: payload.type,
        username: payload.username,
        auth0Sub: payload.auth0Sub,
        customerId: payload.customerId,
        userId: payload.userId,
        role: payload.role
      });
    } catch (error: any) {
      console.warn('[JWT-AUTH] Legacy token verification failed:', error.message);
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

    // Phase 3: Federated Auth0 token issued by provisioning (HS256 shared secret)
    if (payload.auth0Sub && payload.customerId) {
      // For federated tokens, use the customerId already in the token payload
      // Try to validate against hostname if possible, but allow localhost in dev
      let resolvedTenantId: string = payload.customerId;  // Trust the token claim
      
      try {
        const { getTenantIdFromHost } = await import('../services/tenant-resolution.service');
        resolvedTenantId = getTenantIdFromHost(req.hostname);
        // Validate that token tenant matches hostname tenant
        if (payload.customerId !== resolvedTenantId) {
          res.status(403).json({
            error: 'Forbidden',
            message: 'Token tenant does not match request tenant context'
          });
          return;
        }
      } catch (error: any) {
        // On localhost or if hostname resolution fails, trust the token's customerId
        if (req.hostname === 'localhost') {
          console.log('[JWT-AUTH] Using tenant from federated token (dev mode):', payload.customerId);
          // Continue with the token's customerId
        } else {
          console.warn('[JWT-AUTH] Tenant validation failed:', error.message);
          res.status(400).json({
            error: 'Bad Request',
            message: 'Cannot determine tenant from hostname',
            details: error.message
          });
          return;
        }
      }

      req.user = {
        id: payload.userId,
        username: payload.username || payload.auth0Sub,
        email: payload.email,
        role: payload.role,
        isActive: true,
        customerId: payload.customerId
      };

      console.log('[JWT-AUTH] Federated HS256 token authenticated:', payload.auth0Sub);
      next();
      return;
    }

    // Fetch user from database
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

    console.log('[JWT-AUTH] Legacy user authenticated:', user.username);
    next();

  } catch (error: any) {
    console.error('[JWT-AUTH] Legacy token handling error:', error);
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
 * Optional Authentication Middleware
 * 
 * Supports both Auth0 and legacy tokens.
 * Sets req.user if valid token present, otherwise req.user = null
 * Always proceeds to next handler (never rejects)
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    // No token provided
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      next();
      return;
    }

    const token = authHeader.substring(7);

    // Decode header to detect algorithm
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded) {
      req.user = null;
      next();
      return;
    }

    const algorithm = decoded.header?.alg;

    try {
      // Try Auth0 RS256
      if (algorithm === 'RS256' && AUTH0_ENABLED) {
        const auth0Payload = await validateAuth0JWT(token);
        
        let customerId: string;
        try {
          const { getTenantIdFromHost } = await import('../services/tenant-resolution.service');
          customerId = getTenantIdFromHost(req.hostname);
        } catch (error: any) {
          // Fallback for development: check X-Tenant-ID header or env var
          const headerTenantId = req.headers['x-tenant-id'] as string | undefined;
          const envTenantId = process.env.DEVELOPMENT_TENANT_ID;
          
          if (req.hostname === 'localhost' && (headerTenantId || envTenantId)) {
            customerId = headerTenantId || envTenantId || 'customer-local';
          } else {
            req.user = null;
            next();
            return;
          }
        }
        
        const { getRoleAndStatus } = await import('../services/rbac-cache.service');
        const roleData = await getRoleAndStatus(auth0Payload.sub, customerId, auth0Payload.exp);

        if (roleData.customer_status === 'suspended') {
          req.user = null;
          next();
          return;
        }

        req.user = {
          id: 0,
          username: auth0Payload.sub,
          email: auth0Payload.email,
          role: roleData.role,
          isActive: roleData.customer_status === 'active',
          customerId: customerId
        };
        next();
        return;
      }

      // Try legacy HS256
      if (algorithm === 'HS256') {
        const payload = verifyToken(token);

        if (payload.type !== 'access') {
          req.user = null;
          next();
          return;
        }

        if (payload.auth0Sub && payload.customerId) {
          req.user = {
            id: payload.userId,
            username: payload.username || payload.auth0Sub,
            email: payload.email,
            role: payload.role,
            isActive: true,
            customerId: payload.customerId
          };
          next();
          return;
        }

        const result = await query(
          `SELECT id, username, email, role, is_active
           FROM users
           WHERE id = $1`,
          [payload.userId]
        );

        if (result.rows.length === 0 || !result.rows[0].is_active) {
          req.user = null;
          next();
          return;
        }

        const user = result.rows[0];
        req.user = {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
          isActive: user.is_active
        };
        next();
        return;
      }
    } catch (error: any) {
      // Token is invalid, continue without auth
      console.debug('[OPTIONAL-AUTH] Token invalid, continuing unauthenticated:', error.message);
      req.user = null;
      next();
      return;
    }

    req.user = null;
    next();

  } catch (error: any) {
    console.warn('[OPTIONAL-AUTH] Unexpected error:', error);
    req.user = null;
    next();
  }
}

export default jwtAuth;
