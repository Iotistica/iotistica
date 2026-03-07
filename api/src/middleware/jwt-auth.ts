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

import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt, { Secret } from 'jsonwebtoken';
import { query } from '../db/connection';
import axios from 'axios';

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

// JWKS cache TTL in seconds (default: 1 hour = 3600 seconds)
const JWKS_CACHE_TTL = parseInt(process.env.JWKS_CACHE_TTL || '3600', 10);

// Lazy-load Redis client
let redisClient: any = null;
async function getRedisClient() {
  if (!redisClient) {
    try {
      const module = await import('../redis/client');
      redisClient = module.redisClient;
    } catch (error) {
      console.warn('[JWT-AUTH] Redis client not available for JWKS caching');
      return null;
    }
  }
  return redisClient;
}

/**
 * Get JWKS from Redis cache
 */
async function getJwksFromCache(): Promise<any | null> {
  try {
    const redis = await getRedisClient();
    if (!redis || !redis.isReady()) {
      return null;
    }

    const cacheKey = 'auth:jwks:auth0';
    const cached = await redis.getClient().get(cacheKey);

    if (!cached) {
      return null;
    }

    const data = JSON.parse(cached);
    console.log('[JWT-AUTH] JWKS cache hit');
    return data;
  } catch (error: any) {
    console.debug('[JWT-AUTH] JWKS cache read failed:', error.message);
    return null;
  }
}

/**
 * Store JWKS in Redis cache
 */
async function storeJwksInCache(jwks: any): Promise<void> {
  try {
    const redis = await getRedisClient();
    if (!redis || !redis.isReady()) {
      return;
    }

    const cacheKey = 'auth:jwks:auth0';
    await redis.getClient().setex(cacheKey, JWKS_CACHE_TTL, JSON.stringify(jwks));
    console.log('[JWT-AUTH] JWKS cached in Redis', { ttl: JWKS_CACHE_TTL });
  } catch (error: any) {
    console.debug('[JWT-AUTH] JWKS cache write failed:', error.message);
  }
}

/**
 * Invalidate JWKS cache (call when Auth0 keys rotate)
 */
export async function invalidateJwksCache(): Promise<void> {
  try {
    const redis = await getRedisClient();
    if (!redis || !redis.isReady()) {
      return;
    }
    await redis.getClient().del('auth:jwks:auth0');
    console.log('[JWT-AUTH] JWKS cache invalidated');
  } catch (error: any) {
    console.debug('[JWT-AUTH] JWKS cache invalidation failed:', error.message);
  }
}

/**
 * Fetch Auth0 JWKS (JSON Web Key Set)
 * Caches in Redis to avoid repeated requests and share across all pods
 */
async function getAuth0JWKS(): Promise<any> {
  // Try Redis cache first
  const cached = await getJwksFromCache();
  if (cached) {
    return cached;
  }

  // Cache miss - fetch from Auth0
  try {
    const response = await axios.get(`${AUTH0_ISSUER}.well-known/jwks.json`, {
      timeout: 5000
    });

    if (!response.data?.keys) {
      throw new Error('Invalid JWKS response: missing keys array');
    }

    // Store in Redis for future requests
    await storeJwksInCache(response.data);
    console.log('[JWT-AUTH] JWKS fetched from Auth0 and cached');

    return response.data;
  } catch (error: any) {
    console.error('[JWT-AUTH] Failed to fetch JWKS:', error.message);
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

      // Private middleware state – populated by jwtValidate, consumed by downstream middleware
      _auth0Payload?: { sub: string; email: string; exp: number };
      _legacyPayload?: JWTPayload;
      _roleData?: { role: string; customer_status: string };
      _dbUser?: { id: number; username: string; email: string; role: string; is_active: boolean };
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
 * Step 1: JWT Validation Middleware
 *
 * Validates the JWT token from the Authorization header.
 * Handles both Auth0 RS256 and legacy HS256 tokens.
 * Attaches minimal user info to req.user (no DB calls, no tenant resolution).
 *
 * For Auth0 tokens:  req.user = { sub, email, exp }
 * For legacy tokens: req.user = { userId, username, email, type, auth0Sub?, customerId?, role? }
 *
 * Returns 401 if token is missing or invalid.
 */
export async function jwtValidate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
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

    // Decode header without verification to detect algorithm
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token format'
      });
      return;
    }

    const algorithm = decoded.header?.alg;

    // Auth0 RS256 path
    if (algorithm === 'RS256' && AUTH0_ENABLED) {
      console.log('[JWT-AUTH] Detected RS256 token, validating with Auth0 JWKS...');
      let auth0Payload: { sub: string; email: string; exp: number };
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

      // Attach minimal Auth0 user info - mark as auth0 type via username placeholder
      req.user = {
        id: 0,
        username: auth0Payload.sub,
        email: auth0Payload.email,
        role: '',       // filled by rbacLookup
        isActive: false // filled by customerStatusCheck
      };
      // Store auth0-specific claims for downstream middleware
      req._auth0Payload = auth0Payload;
      next();
      return;
    }

    // Legacy HS256 path
    if (algorithm === 'HS256') {
      console.log('[JWT-AUTH] Detected HS256 token, validating locally...');
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

      if (payload.type !== 'access') {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid token type. Use access token for API requests.'
        });
        return;
      }

      // Store the full legacy payload for downstream middleware
      req._legacyPayload = payload;

      req.user = {
        id: payload.userId,
        username: payload.username,
        email: payload.email,
        role: payload.role || '',
        isActive: false, // filled by customerStatusCheck
        customerId: payload.customerId
      };
      next();
      return;
    }

    // Unknown algorithm
    res.status(401).json({
      error: 'Unauthorized',
      message: `Unsupported token algorithm: ${algorithm}`
    });

  } catch (error: any) {
    console.error('[JWT-AUTH] jwtValidate unexpected error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Authentication failed'
    });
  }
}

/**
 * Step 2: Tenant Resolution Middleware
 *
 * Reads hostname from req.hostname or X-Tenant-ID header and resolves the
 * tenant (customerId). Requires jwtValidate to have run first.
 *
 * For federated HS256 tokens (auth0Sub + customerId in payload) the tenant is
 * taken directly from the token and hostname resolution is skipped.
 *
 * Returns 400 if the tenant cannot be determined.
 */
export async function tenantResolve(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'jwtValidate middleware must run before tenantResolve'
      });
      return;
    }

    const legacyPayload: JWTPayload | undefined = req._legacyPayload;

    // Federated token: trust the customerId embedded in the payload
    if (legacyPayload && legacyPayload.auth0Sub && legacyPayload.customerId) {
      console.log('[JWT-AUTH] Using tenant from federated token:', legacyPayload.customerId);
      req.user.customerId = legacyPayload.customerId;
      next();
      return;
    }

    // Pure legacy local tokens don't require tenant resolution
    if (legacyPayload && !legacyPayload.auth0Sub) {
      next();
      return;
    }

    // Auth0 token: resolve tenant from hostname
    let customerId: string;
    try {
      const { getTenantIdFromHost } = await import('../services/tenant-resolution.service');
      customerId = getTenantIdFromHost(req.hostname);
      console.log('[JWT-AUTH] Tenant resolved from hostname:', customerId);
    } catch (error: any) {
      // Fallback for development: X-Tenant-ID header or DEVELOPMENT_TENANT_ID env var
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

    req.user.customerId = customerId;
    next();

  } catch (error: any) {
    console.error('[JWT-AUTH] tenantResolve unexpected error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Authentication failed'
    });
  }
}

/**
 * Step 3: RBAC Lookup Middleware
 *
 * Fetches the user's role from the database or RBAC cache.
 * Requires jwtValidate (and tenantResolve for Auth0 users) to have run first.
 *
 * - Auth0 tokens: uses getRoleAndStatus from rbac-cache.service
 * - Legacy local tokens: fetches role from the users table
 * - Federated tokens: role is already in the token payload – lookup is skipped
 *
 * Returns 403 if the role cannot be determined.
 */
export async function rbacLookup(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'jwtValidate middleware must run before rbacLookup'
      });
      return;
    }

    const auth0Payload: { sub: string; email: string; exp: number } | undefined =
      req._auth0Payload;
    const legacyPayload: JWTPayload | undefined = req._legacyPayload;

    // Federated token: role is embedded in the payload – skip lookup
    if (legacyPayload && legacyPayload.auth0Sub && legacyPayload.customerId) {
      req.user.role = legacyPayload.role;
      next();
      return;
    }

    // Auth0 token: fetch role via RBAC cache service
    if (auth0Payload) {
      const customerId = req.user.customerId;
      if (!customerId) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Tenant not resolved. tenantResolve middleware must run before rbacLookup'
        });
        return;
      }

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

      req.user.role = roleData.role;
      // Store roleData for customerStatusCheck
      req._roleData = roleData;
      next();
      return;
    }

    // Legacy local token: fetch role (and active status) from users table
    if (legacyPayload) {
      const result = await query(
        `SELECT id, username, email, role, is_active, last_login_at
         FROM users
         WHERE id = $1`,
        [legacyPayload.userId]
      );

      if (result.rows.length === 0) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'User not found'
        });
        return;
      }

      const dbUser = result.rows[0];
      req.user.role = dbUser.role;
      // Store dbUser for customerStatusCheck
      req._dbUser = dbUser;
      next();
      return;
    }

    res.status(403).json({
      error: 'Forbidden',
      message: 'Cannot determine user role'
    });

  } catch (error: any) {
    console.error('[JWT-AUTH] rbacLookup unexpected error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Authentication failed'
    });
  }
}

/**
 * Step 4: Customer Status Check Middleware
 *
 * Verifies that the authenticated user/customer is active (not suspended).
 * Requires rbacLookup to have run first.
 *
 * - Auth0: checks customer_status from roleData
 * - Legacy local: checks is_active from dbUser
 * - Federated: assumed active (already validated by provisioning)
 *
 * Attaches req.user.isActive and returns 403 if inactive/suspended.
 */
export async function customerStatusCheck(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'jwtValidate middleware must run before customerStatusCheck'
      });
      return;
    }

    const auth0Payload: { sub: string; email: string; exp: number } | undefined =
      req._auth0Payload;
    const legacyPayload: JWTPayload | undefined = req._legacyPayload;
    const roleData: any = req._roleData;
    const dbUser: any = req._dbUser;

    // Federated token: always active
    if (legacyPayload && legacyPayload.auth0Sub && legacyPayload.customerId) {
      req.user.isActive = true;
      console.log('[JWT-AUTH] Federated HS256 token authenticated:', legacyPayload.auth0Sub);
      next();
      return;
    }

    // Auth0 token: check customer_status from roleData
    if (auth0Payload && roleData) {
      if (roleData.customer_status === 'suspended') {
        res.status(403).json({
          error: 'Forbidden',
          message: 'Customer account is suspended'
        });
        return;
      }

      req.user.isActive = roleData.customer_status === 'active';
      console.log('[JWT-AUTH] Auth0 user authenticated:', auth0Payload.sub);
      next();
      return;
    }

    // Legacy local token: check is_active from dbUser
    if (dbUser) {
      if (!dbUser.is_active) {
        res.status(403).json({
          error: 'Forbidden',
          message: 'User account is inactive. Contact administrator.'
        });
        return;
      }

      req.user.id = dbUser.id;
      req.user.username = dbUser.username;
      req.user.email = dbUser.email;
      req.user.role = dbUser.role;
      req.user.isActive = dbUser.is_active;

      console.log('[JWT-AUTH] Legacy user authenticated:', dbUser.username);
      next();
      return;
    }

    // Fallback: should not reach here in normal usage
    res.status(403).json({
      error: 'Forbidden',
      message: 'Cannot verify user status'
    });

  } catch (error: any) {
    console.error('[JWT-AUTH] customerStatusCheck unexpected error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Authentication failed'
    });
  }
}

/**
 * Compose multiple middleware functions into a single middleware.
 * Executes middleware in sequence, stopping if a middleware sends a response
 * (i.e. does not call its `next` callback).
 */
export function composeMiddleware(...middlewares: RequestHandler[]): RequestHandler {
  return (req, res, next) => {
    let currentIndex = 0;
    const executeNext = () => {
      if (currentIndex >= middlewares.length) return next();
      middlewares[currentIndex++](req, res, executeNext);
    };
    executeNext();
  };
}

/**
 * Composed Authentication Middleware
 *
 * Chains jwtValidate → tenantResolve → rbacLookup → customerStatusCheck in sequence.
 * Equivalent to the previous monolithic jwtAuth implementation.
 */
export const requireAuth = composeMiddleware(
  jwtValidate,
  tenantResolve,
  rbacLookup,
  customerStatusCheck
);

/**
 * JWT Authentication Middleware
 *
 * Alias for requireAuth. Kept for backward compatibility.
 *
 * Supports two authentication modes:
 * 1. Auth0 (RS256): Extract sub, resolve tenant, fetch role from provisioning
 * 2. Legacy (HS256): Fetch user from local users table
 *
 * Expects: Authorization: Bearer <token> header
 * Sets: req.user with authenticated user information
 */
export const jwtAuth = requireAuth;

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
 *
 * Reuses jwtValidate → tenantResolve → rbacLookup → customerStatusCheck via
 * composeMiddleware. Any error response that those steps would send is
 * intercepted: instead of being sent to the client, req.user is set to null
 * and the request continues normally.
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // No token provided - continue without auth
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      next();
      return;
    }

    // Intercept any error responses the auth chain attempts to send.
    // Instead of sending an error response, set req.user = null and continue.
    const originalJson = res.json.bind(res);
    let intercepted = false;

    res.json = function (body: any) {
      if (!intercepted && !res.headersSent && res.statusCode >= 400) {
        intercepted = true;
        res.json = originalJson;
        res.statusCode = 200;
        console.debug('[OPTIONAL-AUTH] Token invalid, continuing unauthenticated');
        req.user = null;
        next();
        return res;
      }
      return originalJson(body);
    } as any;

    composeMiddleware(
      jwtValidate,
      tenantResolve,
      rbacLookup,
      customerStatusCheck
    )(req, res, () => {
      res.json = originalJson;
      next();
    });

  } catch (error: any) {
    console.debug('[OPTIONAL-AUTH] Error during optional authentication:', error.message);
    req.user = null;
    next();
  }
}

export default jwtAuth;
