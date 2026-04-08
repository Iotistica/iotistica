/**
 * JWT Authentication Middleware
 * 
 * Provides JWT-based authentication for dashboard users
 * Supports two modes:
 * 1. Legacy: Local HS256 tokens (for backward compatibility)
 * 2. Auth0: RS256 tokens via JWKS validation (recommended)
 * 
 * Usage:
 *   router.get('/dashboard/agents', jwtAuth, async (req, res) => {
 *     // req.user contains authenticated user info
 *   });
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHash, createPublicKey } from 'crypto';
import { importJWK, jwtVerify, type JWK } from 'jose';
import { query } from '../db/connection';
import logger from '../utils/logger';
import { fetch } from 'undici';
import { decodeJwtHeader, signHs256Token, verifyHs256Token } from '../utils/hs256-jwt';

// JWT Configuration
// CRITICAL: JWT_SECRET must be set in environment - no fallback to prevent security bypass
const JWT_SECRET: string = (() => {
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
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID || '';
const AUTH0_ISSUER = process.env.AUTH0_ISSUER || `https://${AUTH0_DOMAIN}/`;
const AUTH0_ENABLED = process.env.AUTH0_ENABLED === 'true' && AUTH0_DOMAIN && AUTH0_AUDIENCE;

// JWKS cache TTL in seconds (default: 1 hour = 3600 seconds)
const JWKS_CACHE_TTL = parseInt(process.env.JWKS_CACHE_TTL || '3600', 10);
const RBAC_CACHE_TTL_SECONDS = parseInt(process.env.RBAC_CACHE_TTL_SECONDS || '300', 10);
const RBAC_STALE_CACHE_TTL_SECONDS = parseInt(process.env.RBAC_STALE_CACHE_TTL_SECONDS || '3600', 10);
const PROVISIONING_API_URL = process.env.PROVISIONING_API_URL || 'http://provisioning:3100';
const INTERNAL_AUTH_TOKEN = process.env.INTERNAL_AUTH_TOKEN || '';

interface RoleAndStatus {
  auth0_sub: string;
  customer_id: string;
  role: string;
  customer_status: 'active' | 'suspended' | 'provisioning';
  last_updated_at: string;
  role_assigned_at?: string;
}

interface RbacCacheEntry {
  data: RoleAndStatus;
  fetched_at: number;
  expires_at: number;
}

// Lazy-load Redis client
let redisClient: any = null;
async function getRedisClient() {
  if (!redisClient) {
    try {
      const module = await import('../redis/client');
      redisClient = module.redisClient;
    } catch (error) {
      logger.warn('Redis client not available for JWKS caching');
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
    logger.info('JWKS cache hit');
    return data;
  } catch (error: any) {
    logger.debug('JWKS cache read failed', { message: error.message });
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
    logger.info('JWKS cached in Redis', { ttl: JWKS_CACHE_TTL });
  } catch (error: any) {
    logger.debug('JWKS cache write failed', { message: error.message });
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
      logger.info('JWKS cache invalidated');
  } catch (error: any) {
      logger.debug('JWKS cache invalidation failed', { message: error.message });
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
    const response = await fetch(`${AUTH0_ISSUER}.well-known/jwks.json`, {
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      throw new Error(`JWKS fetch failed with status ${response.status}`);
    }

    const data = await response.json() as any;
    if (!data?.keys) {
      throw new Error('Invalid JWKS response: missing keys array');
    }

    // Store in Redis for future requests
    await storeJwksInCache(data);
    logger.info('JWKS fetched from Auth0 and cached');

    return data;
  } catch (error: any) {
    logger.error('Failed to fetch JWKS from Auth0', { message: error.message });
    throw new Error(`Cannot fetch Auth0 JWKS: ${error.message}`);
  }
}

/**
 * Get Public Key from JWKS by Key ID (kid)
 */
async function getPublicKeyFromJWKS(jwks: any, kid: string) {
  const key = jwks.keys.find((k: any) => k.kid === kid);

  if (!key) {
    throw new Error(`Key ID ${kid} not found in Auth0 JWKS`);
  }

  return importJWK(key as JWK, 'RS256');
}

function getRbacCacheKey(auth0Sub: string, customerId: string): string {
  return `auth:rbac:${createHash('sha256').update(`${auth0Sub}:${customerId}`).digest('hex')}`;
}

async function getRbacCacheEntry(
  auth0Sub: string,
  customerId: string,
): Promise<RbacCacheEntry | null> {
  try {
    const redis = await getRedisClient();
    if (!redis || !redis.isReady()) {
      return null;
    }

    const cached = await redis.getClient().get(getRbacCacheKey(auth0Sub, customerId));
    if (!cached) {
      return null;
    }

    return JSON.parse(cached) as RbacCacheEntry;
  } catch (error: any) {
    logger.debug('RBAC cache read failed', {
      auth0Sub,
      customerId,
      message: error.message,
    });
    return null;
  }
}

async function setRbacCacheEntry(
  auth0Sub: string,
  customerId: string,
  entry: RbacCacheEntry,
  ttlSeconds: number,
): Promise<void> {
  try {
    const redis = await getRedisClient();
    if (!redis || !redis.isReady()) {
      return;
    }

    const redisTtlSeconds = Math.max(ttlSeconds, RBAC_STALE_CACHE_TTL_SECONDS);
    await redis.getClient().setex(
      getRbacCacheKey(auth0Sub, customerId),
      redisTtlSeconds,
      JSON.stringify(entry),
    );
  } catch (error: any) {
    logger.debug('RBAC cache write failed', {
      auth0Sub,
      customerId,
      message: error.message,
    });
  }
}

async function fetchRoleAndStatusFromProvisioning(
  auth0Sub: string,
  customerId: string,
): Promise<RoleAndStatus> {
  if (!INTERNAL_AUTH_TOKEN) {
    throw new Error('INTERNAL_AUTH_TOKEN not configured (required for provisioning API calls)');
  }

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(
      `${PROVISIONING_API_URL}/api/internal/users/${auth0Sub}/tenants/${customerId}/role`,
      {
        headers: {
          'X-Internal-Token': INTERNAL_AUTH_TOKEN,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      },
    );
  } catch (error: any) {
    throw new Error(`Provisioning API unreachable: ${error.message}`);
  }

  if (response.status === 404) {
    throw new Error(`User ${auth0Sub} not found in customer ${customerId} (provisioning returned 404)`);
  }

  if (response.status === 401) {
    throw new Error('Invalid INTERNAL_AUTH_TOKEN (provisioning rejected request)');
  }

  if (!response.ok) {
    throw new Error(`Provisioning API returned ${response.status}`);
  }

  const data = await response.json() as any;
  if (!data?.success || !data?.data) {
    throw new Error(`Invalid response from provisioning API: ${JSON.stringify(data)}`);
  }

  return data.data as RoleAndStatus;
}

async function getRoleAndStatus(
  auth0Sub: string,
  customerId: string,
  jwtExpSeconds?: number,
): Promise<RoleAndStatus> {
  const now = Date.now() / 1000;

  let ttlSeconds = RBAC_CACHE_TTL_SECONDS;
  if (jwtExpSeconds && jwtExpSeconds > now) {
    ttlSeconds = Math.min(ttlSeconds, Math.floor(jwtExpSeconds - now));
  }

  const cached = await getRbacCacheEntry(auth0Sub, customerId);
  if (cached && cached.expires_at > now) {
    logger.debug('RBAC cache hit', {
      auth0Sub,
      customerId,
      expiresInSeconds: Math.round(cached.expires_at - now),
    });
    return cached.data;
  }

  if (cached) {
    logger.debug('RBAC cache expired, refreshing', { auth0Sub, customerId });
  } else {
    logger.debug('RBAC cache miss, fetching from provisioning', { auth0Sub, customerId });
  }

  try {
    const data = await fetchRoleAndStatusFromProvisioning(auth0Sub, customerId);
    await setRbacCacheEntry(auth0Sub, customerId, {
      data,
      fetched_at: now,
      expires_at: now + ttlSeconds,
    }, ttlSeconds);

    logger.info('RBAC fetched from provisioning and cached', {
      auth0Sub,
      customerId,
      cacheTtlSeconds: ttlSeconds,
      staleTtlSeconds: Math.max(ttlSeconds, RBAC_STALE_CACHE_TTL_SECONDS),
    });
    return data;
  } catch (error: any) {
    logger.warn('RBAC fetch failed', {
      auth0Sub,
      customerId,
      error: error.message,
    });

    if (cached) {
      logger.warn('Using stale RBAC cache due to provisioning error', {
        auth0Sub,
        customerId,
        expiredSecondsAgo: Math.round(now - cached.expires_at),
      });
      return cached.data;
    }

    throw new Error(
      `Cannot determine role for ${auth0Sub} in ${customerId}: provisioning unreachable and no cached role available. Deny by default.`
    );
  }
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
  const decoded = decodeJwtHeader(token);

  if (!decoded) {
    throw new Error('Invalid JWT format');
  }

  // Validate algorithm is RS256 (reject HS256)
  if (decoded.alg !== 'RS256') {
    throw new Error(`Invalid algorithm: ${String(decoded.alg)} (must be RS256)`);
  }

  // Get Key ID
  const kid = typeof decoded.kid === 'string' ? decoded.kid : undefined;
  if (!kid) {
    throw new Error('Missing Key ID (kid) in JWT header');
  }

  // Fetch JWKS and get public key
  const jwks = await getAuth0JWKS();
  const publicKey = await getPublicKeyFromJWKS(jwks, kid);

  // Verify JWT signature and claims
  const audienceCandidates = [AUTH0_AUDIENCE, AUTH0_CLIENT_ID].filter(Boolean);
  const audience = audienceCandidates.length > 1
    ? (audienceCandidates as [string, ...string[]])
    : audienceCandidates[0];

  const { payload } = await jwtVerify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: AUTH0_ISSUER,
    audience
  });

  // Additional validation — email is not guaranteed in access JWTs (only in id_token)
  if (!payload.sub) {
    throw new Error('Missing required claim: sub');
  }

  if (payload.email !== undefined && typeof payload.email !== 'string') {
    throw new Error('Invalid email claim type');
  }

  if (typeof payload.exp !== 'number') {
    throw new Error('Missing exp claim');
  }

  const exp = Math.floor(Date.now() / 1000);
  if (payload.exp < exp) {
    throw new Error('Token has expired');
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : '',
    exp: payload.exp
  };
}

/**
 * Validate Auth0 opaque/JWE access token via /userinfo endpoint.
 * Used as fallback when token is not a decodable JWT.
 */
async function validateAuth0OpaqueToken(token: string): Promise<{
  sub: string;
  email: string;
  exp: number;
}> {
  if (!AUTH0_ENABLED) {
    throw new Error('Auth0 not enabled (AUTH0_ENABLED must be "true" and AUTH0_DOMAIN/AUTH0_AUDIENCE set)');
  }

  const userInfoUrl = `https://${AUTH0_DOMAIN}/userinfo`;

  let data: any;
  try {
    const response = await fetch(userInfoUrl, {
      headers: {
        Authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      let errBody: any = {};
      try { errBody = await response.json(); } catch { /* ignore */ }
      throw new Error(errBody.error || `HTTP ${response.status}`);
    }
    data = await response.json();
  } catch (error: any) {
    throw new Error(`Opaque token validation failed: ${error.message}`);
  }

  if (!data || !data.sub) {
    throw new Error('Opaque token missing required claim: sub');
  }

  const now = Math.floor(Date.now() / 1000);
  return {
    sub: data.sub,
    email: data.email,
    exp: now + 300
  };
}

// Type augmentations are in src/types/fastify.d.ts

export interface JWTPayload {
  userId: number;
  username: string;
  email: string;
  role: string;
  auth0Sub?: string;
  customerId?: string;
  type: 'access' | 'refresh';
  aud?: string | string[];
  exp?: number;
  iat?: number;
  iss?: string;
  nbf?: number;
  sub?: string;
  [key: string]: unknown;
}

/**
 * Generate JWT access token (short-lived)
 */
export function generateAccessToken(user: {
  id: number;
  username: string;
  email: string;
  role: string;
  auth0Sub?: string;
  customerId?: string;
}): string {
  const payload: JWTPayload = {
    userId: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    auth0Sub: user.auth0Sub,
    customerId: user.customerId,
    type: 'access'
  };

  return signHs256Token(payload, JWT_SECRET, {
    expiresIn: JWT_ACCESS_TOKEN_EXPIRY,
    issuer: 'iotistic-api',
    audience: 'iotistic-dashboard',
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
  auth0Sub?: string;
  customerId?: string;
}): string {
  const payload: JWTPayload = {
    userId: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    auth0Sub: user.auth0Sub,
    customerId: user.customerId,
    type: 'refresh'
  };

  return signHs256Token(payload, JWT_SECRET, {
    expiresIn: JWT_REFRESH_TOKEN_EXPIRY,
    issuer: 'iotistic-api',
    audience: 'iotistic-dashboard',
  });
}

/**
 * Verify and decode JWT token
 */
export function verifyToken(token: string): JWTPayload {
  try {
    return verifyHs256Token<JWTPayload>(token, JWT_SECRET, {
      issuer: 'iotistic-api',
      audience: 'iotistic-dashboard',
    });
  } catch (error: any) {
    throw new Error(`Invalid token: ${error.message}`);
  }
}

/**
 * Step 1: JWT Validation preHandler
 *
 * Validates the JWT token from the Authorization header.
 * Handles both Auth0 RS256 and legacy HS256 tokens.
 * Attaches minimal user info to request.user (no DB calls, no tenant resolution).
 *
 * Returns 401 if token is missing or invalid.
 */
export async function jwtValidate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'JWT token required. Send in Authorization: Bearer <token> header.'
      });
    }

    const token = authHeader.substring(7);

    let decoded: Record<string, unknown> | null = null;
    try {
      decoded = decodeJwtHeader(token);
    } catch {
      decoded = null;
    }
    if (!decoded) {
      if (AUTH0_ENABLED) {
        logger.info('Token is not decodable JWT; trying Auth0 /userinfo fallback');
        let auth0Payload: { sub: string; email: string; exp: number };
        try {
          auth0Payload = await validateAuth0OpaqueToken(token);
          logger.info('Opaque Auth0 token validated successfully', { sub: auth0Payload.sub });
        } catch (error: any) {
          logger.warn('Opaque token fallback failed', { message: error.message });
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Invalid token format',
            details: error.message
          });
        }

        request.user = { id: 0, username: auth0Payload.sub, email: auth0Payload.email, role: '', isActive: false };
        request._auth0Payload = auth0Payload;
        return;
      }

      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid token format' });
    }

    const algorithm = decoded.alg;

    if (algorithm === 'RS256' && AUTH0_ENABLED) {
      logger.info('Detected RS256 token, validating with Auth0 JWKS...');
      let auth0Payload: { sub: string; email: string; exp: number };
      try {
        auth0Payload = await validateAuth0JWT(token);
        logger.info('Auth0 token validated successfully', { sub: auth0Payload.sub });
      } catch (error: any) {
        logger.warn('Auth0 token validation failed', { message: error.message });
        return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid Auth0 token', details: error.message });
      }

      request.user = { id: 0, username: auth0Payload.sub, email: auth0Payload.email, role: '', isActive: false };
      request._auth0Payload = auth0Payload;
      return;
    }

    if (algorithm === 'HS256') {
      logger.info('Detected HS256 token, validating locally...');
      let payload: JWTPayload;
      try {
        payload = verifyToken(token);
      } catch (error: any) {
        logger.warn('Legacy token verification failed', { message: error.message });
        return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token', details: error.message });
      }

      if (payload.type !== 'access') {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid token type. Use access token for API requests.' });
      }

      request._legacyPayload = payload;
      request.user = { id: payload.userId, username: payload.username, email: payload.email, role: payload.role || '', isActive: false, customerId: payload.customerId };
      return;
    }

    return reply.status(401).send({ error: 'Unauthorized', message: `Unsupported token algorithm: ${algorithm}` });

  } catch (error: any) {
    logger.error('jwtValidate encountered unexpected error', { error });
    return reply.status(500).send({ error: 'Internal Server Error', message: 'Authentication failed' });
  }
}

/**
 * Step 2: Tenant Resolution preHandler
 */
export async function tenantResolve(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'jwtValidate must run before tenantResolve' });
    }

    const legacyPayload: JWTPayload | undefined = request._legacyPayload;

    if (legacyPayload && legacyPayload.auth0Sub && legacyPayload.customerId) {
      logger.info('Using tenant from federated token', { customerId: legacyPayload.customerId });
      request.user.customerId = legacyPayload.customerId;
      return;
    }

    if (legacyPayload && !legacyPayload.auth0Sub) {
      return;
    }

    let customerId: string;
    try {
      const { getTenantIdFromHost } = await import('../services/auth/tenant-resolution.service');
      customerId = getTenantIdFromHost(request.hostname);
      logger.info('Tenant resolved from hostname', { customerId });
    } catch (error: any) {
      const headerTenantId = request.headers['x-tenant-id'] as string | undefined;
      const envTenantId = process.env.DEVELOPMENT_TENANT_ID;

      if (headerTenantId || envTenantId) {
        customerId = headerTenantId || envTenantId || 'customer-local';
        logger.info('Using development fallback tenant', { customerId, hostname: request.hostname });
      } else {
        logger.warn('Tenant resolution failed', { message: error.message });
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Cannot determine tenant from hostname. Set X-Tenant-ID header or DEVELOPMENT_TENANT_ID env var',
          details: error.message
        });
      }
    }

    request.user.customerId = customerId;

  } catch (error: any) {
    logger.error('tenantResolve encountered unexpected error', { error });
    return reply.status(500).send({ error: 'Internal Server Error', message: 'Authentication failed' });
  }
}

/**
 * Step 3: RBAC Lookup preHandler
 */
export async function rbacLookup(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'jwtValidate must run before rbacLookup' });
    }

    const auth0Payload = request._auth0Payload;
    const legacyPayload = request._legacyPayload;

    if (legacyPayload && legacyPayload.auth0Sub && legacyPayload.customerId) {
      request.user.role = legacyPayload.role;
      return;
    }

    if (auth0Payload) {
      const customerId = request.user.customerId;
      if (!customerId) {
        return reply.status(400).send({ error: 'Bad Request', message: 'Tenant not resolved. tenantResolve must run before rbacLookup' });
      }

      let roleData: any;
      try {
        roleData = await getRoleAndStatus(auth0Payload.sub, customerId, auth0Payload.exp);
      } catch (error: any) {
        if (process.env.NODE_ENV !== 'production' && process.env.DEVELOPMENT_TENANT_ID) {
          roleData = { role: 'admin', customer_status: 'active' };
        } else {
          return reply.status(403).send({ error: 'Forbidden', message: 'Cannot determine user role in tenant', details: error.message });
        }
      }

      request.user.role = roleData.role;
      request._roleData = roleData;
      return;
    }

    if (legacyPayload) {
      const result = await query(
        `SELECT id, username, email, role, is_active, last_login_at FROM users WHERE id = $1`,
        [legacyPayload.userId]
      );

      if (result.rows.length === 0) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'User not found' });
      }

      const dbUser = result.rows[0];
      request.user.role = dbUser.role;
      request._dbUser = dbUser;
      return;
    }

    return reply.status(403).send({ error: 'Forbidden', message: 'Cannot determine user role' });

  } catch (error: any) {
    logger.error('rbacLookup encountered unexpected error', { error });
    return reply.status(500).send({ error: 'Internal Server Error', message: 'Authentication failed' });
  }
}

/**
 * Step 4: Customer Status Check preHandler
 */
export async function customerStatusCheck(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'jwtValidate must run before customerStatusCheck' });
    }

    const auth0Payload = request._auth0Payload;
    const legacyPayload = request._legacyPayload;
    const roleData: any = request._roleData;
    const dbUser: any = request._dbUser;

    if (legacyPayload && legacyPayload.auth0Sub && legacyPayload.customerId) {
      request.user.isActive = true;
      return;
    }

    if (auth0Payload && roleData) {
      if (roleData.customer_status === 'suspended') {
        return reply.status(403).send({ error: 'Forbidden', message: 'Customer account is suspended' });
      }
      request.user.isActive = roleData.customer_status === 'active';
      return;
    }

    if (dbUser) {
      if (!dbUser.is_active) {
        return reply.status(403).send({ error: 'Forbidden', message: 'User account is inactive. Contact administrator.' });
      }
      request.user.id = dbUser.id;
      request.user.username = dbUser.username;
      request.user.email = dbUser.email;
      request.user.role = dbUser.role;
      request.user.isActive = dbUser.is_active;
      return;
    }

    return reply.status(403).send({ error: 'Forbidden', message: 'Cannot verify user status' });

  } catch (error: any) {
    logger.error('customerStatusCheck encountered unexpected error', { error });
    return reply.status(500).send({ error: 'Internal Server Error', message: 'Authentication failed' });
  }
}

/**
 * Run the full auth chain: validate → resolve tenant → rbac → status check.
 * Stops as soon as any step sends a response (reply.sent === true).
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await jwtValidate(request, reply);
  if (reply.sent) return;
  await tenantResolve(request, reply);
  if (reply.sent) return;
  await rbacLookup(request, reply);
  if (reply.sent) return;
  await customerStatusCheck(request, reply);
}

/** Alias kept for backward compatibility. */
export const jwtAuth = requireAuth;

/**
 * Role-based authorization preHandler factory.
 * Must be used after jwtAuth.
 *
 * Example:
 *   fastify.get('/admin', { preHandler: [jwtAuth, requireRole('admin')] }, handler)
 */
export function requireRole(...allowedRoles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      return reply.status(500).send({ error: 'Internal Server Error', message: 'jwtAuth must run before requireRole' });
    }

    if (!allowedRoles.includes(request.user.role)) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: `Insufficient permissions. Required role: ${allowedRoles.join(' or ')}`
      });
    }
  };
}

/**
 * Optional Authentication preHandler.
 *
 * Sets request.user if a valid token is provided; otherwise sets user to null.
 * Never rejects the request.
 */
export async function optionalAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.headers.authorization?.startsWith('Bearer ')) {
    request.user = null;
    return;
  }

  try {
    let errorSent = false;
    const mockReply = new Proxy(_reply, {
      get(target, prop) {
        if (prop === 'send') return () => { errorSent = true; return target; };
        if (prop === 'status') return () => mockReply;
        if (prop === 'code') return () => mockReply;
        return (target as any)[prop];
      }
    }) as FastifyReply;

    await jwtValidate(request, mockReply);
    if (errorSent) { request.user = null; return; }

    await tenantResolve(request, mockReply);
    if (errorSent) { request.user = null; return; }

    await rbacLookup(request, mockReply);
    if (errorSent) { request.user = null; return; }

    await customerStatusCheck(request, mockReply);
    if (errorSent) { request.user = null; }

  } catch {
    request.user = null;
  }
}

export default jwtAuth;
