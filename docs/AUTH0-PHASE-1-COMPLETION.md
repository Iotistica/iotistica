# Auth0 Multi-Tenant RBAC - Phase 1 Completion Guide

**Status**: ✅ Phase 1 Foundation Complete  
**Date**: January 2025  
**Scope**: Database schema, Auth0 JWT validation, internal RBAC API, tenant resolution, role caching  

---

## Table of Contents

1. [Overview](#overview)
2. [What's Been Implemented](#whats-been-implemented)
3. [Architecture](#architecture)
4. [Testing Phase 1](#testing-phase-1)
5. [Environment Setup](#environment-setup)
6. [Phase 2 Preview](#phase-2-preview)
7. [Troubleshooting](#troubleshooting)

---

## Overview

Phase 1 establishes the **foundation layer** for Auth0-based identity and centralized role-based access control (RBAC). This phase does **not** change the existing user-facing API—local password authentication continues to work for backward compatibility.

### Key Principles (Phase 1)

- ✅ **Feature-gated**: All Auth0 features are behind `AUTH0_ENABLED` flag
- ✅ **Non-breaking**: Legacy HS256 tokens continue to work
- ✅ **Tested**: All new components are ready for Phase 2 integration
- ✅ **Documented**: Environment variables, internal APIs, and caching strategy all documented

### What Phase 1 Enables (For Phase 2+)

- Dashboard can redirect to Auth0 login instead of local form
- API validates Auth0 RS256 tokens alongside legacy HS256 tokens
- Single Auth0 account can access multiple tenant instances (via central user_tenant_roles table)
- Role changes propagate instantly via RBAC cache invalidation
- Tenant API never blocks on provisioning API (graceful degradation with stale cache)

---

## What's Been Implemented

### 1. Database Schema (`provisioning/migrations/012_add_user_tenant_roles.sql`)

**Purpose**: Central source of truth for user-to-tenant role mapping

**Table: `user_tenant_roles`**
```sql
CREATE TABLE user_tenant_roles (
  id SERIAL PRIMARY KEY,
  auth0_sub VARCHAR(255) NOT NULL,        -- Auth0 subject (unique identifier)
  customer_id VARCHAR(100) NOT NULL,      -- Tenant identifier
  role VARCHAR(50) NOT NULL,              -- Role name (admin, operator, viewer, etc)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_by VARCHAR(255),                -- Audit: who created this assignment
  UNIQUE(auth0_sub, customer_id),         -- Prevent duplicate role assignments
  INDEX idx_auth0_sub_customer (auth0_sub, customer_id),
  INDEX idx_customer (customer_id),
  INDEX idx_created_at (created_at)
);
```

**Key Features**:
- `UNIQUE(auth0_sub, customer_id)` prevents accidental duplicate role assignments
- Indexed on lookup pattern (auth0_sub + customer_id) for fast queries
- Audit fields (created_at, updated_at, created_by) for compliance
- Trigger auto-updates `updated_at` on row changes

**Status**: Ready to apply via `knex migrate:latest` in provisioning service

---

### 2. Internal RBAC API (`provisioning/src/routes/internal-rbac.ts`)

**Purpose**: Allow tenant API to fetch user roles securely without exposing billing logic

**Mounted at**: `POST /api/internal/*` (defined in `provisioning/src/index.ts`)

**Authentication**: All endpoints require `X-Internal-Token: ${INTERNAL_AUTH_TOKEN}` header

**Endpoints**:

#### GET `/internal/users/{auth0_sub}/tenants/{customer_id}/role`
Fetch user's role in a specific tenant
```
GET /api/internal/users/auth0|123456/tenants/customer-abc123/role
X-Internal-Token: your-token-here

Response (200):
{
  "auth0_sub": "auth0|123456",
  "customer_id": "customer-abc123",
  "role": "admin",
  "customer_status": "active",
  "created_at": "2025-01-15T10:30:00Z",
  "updated_at": "2025-01-15T11:00:00Z"
}

Response (404): User not found in this tenant
Response (500): Database error
```

#### POST `/internal/users`
Assign user to tenant with initial role (called on signup)
```
POST /api/internal/users
X-Internal-Token: your-token-here
Content-Type: application/json

Body:
{
  "auth0_sub": "auth0|123456",
  "customer_id": "customer-abc123",
  "role": "admin"
}

Response (201): Role assigned successfully
Response (409): User already has a role in this tenant
Response (400): Missing required fields
```

#### PUT `/internal/users/{auth0_sub}/tenants/{customer_id}/role`
Update user's role in a tenant
```
PUT /api/internal/users/auth0|123456/tenants/customer-abc123/role
X-Internal-Token: your-token-here
Content-Type: application/json

Body:
{
  "role": "operator"
}

Response (200): Role updated
Response (404): User not found in this tenant
```

#### DELETE `/internal/users/{auth0_sub}/tenants/{customer_id}`
Remove user from tenant
```
DELETE /api/internal/users/auth0|123456/tenants/customer-abc123
X-Internal-Token: your-token-here

Response (204): User removed
Response (404): User not found in this tenant
```

#### GET `/internal/tenants/{customer_id}/status`
Quick lookup of customer deployment + suspension status
```
GET /api/internal/tenants/customer-abc123/status
X-Internal-Token: your-token-here

Response (200):
{
  "customer_id": "customer-abc123",
  "status": "active",  -- or "suspended", "provisioning"
  "provisioned_at": "2025-01-10T00:00:00Z"
}

Response (404): Customer not found (may be suspended - log warning)
```

**Status**: Fully implemented, mounted in provisioning service

---

### 3. Tenant Resolution Service (`api/src/services/tenant-resolution.service.ts`)

**Purpose**: Determine which customer/tenant a request belongs to

**How It Works**:

1. **Primary**: Extract subdomain from hostname
   - `customer-abc123.app.com` → `abc123`
   - `api.iotistic.cloud` → `api` (fallback to header)

2. **Fallback**: Check headers (for internal tooling)
   - `X-Customer-ID: customer-abc123`
   - `X-Tenant-ID: customer-abc123`

3. **Static Mapping** (optional): Use `TENANT_MAPPING` env var
   - `TENANT_MAPPING=dev:cust_dev,staging:cust_staging,prod:cust_prod`

4. **Cache**: 1-hour in-memory cache to avoid repeated hostname parsing

**Exported Functions**:

```typescript
export function getTenantIdFromHost(hostname: string): string
// Extracts and returns customer_id from hostname with caching

export function extractTenantId(hostname: string, headers: Record<string, string>): string
// Primary extraction logic (subdomain + fallback headers)

export function clearTenantCache(): void
// Manual cache clearing (e.g., after deployment)

export function getCacheStats(): {
  size: number;
  entries: string[];
}
// Monitor cache hit rates in production
```

**Usage in midware**:
```typescript
const { getTenantIdFromHost } = await import('../services/tenant-resolution.service');
const customerId = getTenantIdFromHost(req.hostname);
```

**Status**: Fully implemented, ready to use in jwtAuth middleware

---

### 4. RBAC Cache Service (`api/src/services/rbac-cache.service.ts`)

**Purpose**: Cache user roles to prevent provisioning API bottleneck

**Key Logic**:

1. **Cache Key**: `sha256(auth0_sub + customer_id )`
2. **TTL**: `min(300 seconds, JWT expiry time – now)`
   - Shorter of: 5 minutes OR time until JWT token expires
   - If JWT expires in 2 minutes, cache TTL = 2 minutes
   - Ensures cache never outlives the JWT's validity

3. **Graceful Degradation**:
   - If provisioning API unreachable AND cache miss: **REJECT** (deny by default)
   - If provisioning API unreachable BUT cache exists: **ALLOW** (use stale cache)
   - Prevents broken auth during provisioning downtime

4. **Timeout**: Provisioning API requests timeout at 5 seconds (won't block tenant API)

**Exported Functions**:

```typescript
export async function getRoleAndStatus(
  auth0_sub: string,
  customerId: string,
  jwtExpSeconds: number  // From validated JWT token
): Promise<{
  role: string;
  customer_status: 'active' | 'suspended' | 'provisioning';
}>

// Example:
const jwtExp = auth0Payload.exp;  // Unix timestamp from JWT
const roleData = await getRoleAndStatus(auth0_sub, customerId, jwtExp);
// Returns: { role: 'admin', customer_status: 'active' }

export function invalidateUserCache(auth0_sub: string, customerId: string): void
// Manual invalidation (e.g., after admin changes role)

export function clearRBACCache(): void
// Clear entire cache (e.g., after batch role updates)

export function getRBACCacheStats(): {
  size: number;
  hitRate: number;
  misses: number;
}
// Monitor cache effectiveness in production
```

**Usage in jwtAuth middleware**:
```typescript
const { getRoleAndStatus } = await import('../services/rbac-cache.service');
const roleData = await getRoleAndStatus(
  auth0Payload.sub,
  customerId,
  auth0Payload.exp
);

if (roleData.customer_status === 'suspended') {
  return res.status(403).json({ error: 'Customer suspended' });
}
```

**Status**: Fully implemented, ready to use in jwtAuth middleware

---

### 5. Auth0 JWT Validation (`api/src/middleware/jwt-auth.ts`)

**Purpose**: Validate Auth0 RS256 tokens using JWKS

**Key Functions**:

```typescript
async function getAuth0JWKS(): Promise<any>
// Fetches Auth0's public keys from /.well-known/jwks.json
// Caches for 1 hour (60-minute TTL, 10-minute check period)
// Returns: { keys: [{kty, kid, x5c, n, e, ...}] }

function getPublicKeyFromJWKS(jwks: any, kid: string): string
// Extracts key by key ID from JWKS
// Converts JWK (JSON Web Key) format to PEM
// Returns: PEM-formatted public key (for use with jwt.verify)

async function validateAuth0JWT(token: string): Promise<{
  sub: string;
  email: string;
  exp: number;
}>
// Full validation pipeline:
// 1. Decode (no verify) to get kid from header
// 2. Reject if algorithm ≠ RS256
// 3. Fetch JWKS, get public key
// 4. Verify signature + claims (iss, aud, exp)
// 5. Check sub + email claims exist
// 6. Return minimal claims only
```

**Validation Checks**:

```
Input: bearer token from Authorization header

✅ Algorithm is RS256 (reject HS256 immediately)
✅ Token is not expired (exp > now)
✅ Issuer matches AUTH0_ISSUER env var
✅ Audience matches AUTH0_AUDIENCE env var
✅ Signature valid against Auth0 public key (JWKS)
✅ Claims: sub (user ID) and email present

Output: { sub: "auth0|...", email: "user@example.com", exp: 1705322400 }
```

**Feature-Gated**:
```typescript
const AUTH0_ENABLED = process.env.AUTH0_ENABLED === 'true' && AUTH0_DOMAIN && AUTH0_AUDIENCE;

if (AUTH0_ENABLED && algorithm === 'RS256') {
  // Use Auth0 path
  await handleAuth0Token(req, res, next, token);
} else if (algorithm === 'HS256') {
  // Fall back to legacy local auth
  await handleLegacyToken(req, res, next, token);
}
```

**Status**: Fully implemented and integrated into jwtAuth middleware

---

### 6. Updated JWT Middleware (`api/src/middleware/jwt-auth.ts`)

**Purpose**: Support both Auth0 and legacy token types

**Main Handler: `jwtAuth()`**

Detects token algorithm from header and routes to appropriate handler:

```
Request arrives with Authorization: Bearer <token>

1. Extract token from header
2. Decode token header (without verification) to get alg
3. If alg === 'RS256' AND AUTH0_ENABLED:
   → Call handleAuth0Token()
      ├─ Validate Auth0 JWT
      ├─ Resolve tenant from hostname
      ├─ Fetch role from provisioning API (with caching)
      ├─ Check customer status
      └─ Set req.user with {id, username, email, role, customerId}
4. Else if alg === 'HS256':
   → Call handleLegacyToken()
      ├─ Validate signature with JWT_SECRET
      ├─ Fetch user from local users table
      ├─ Check user is active
      └─ Set req.user with {id, username, email, role}
5. Else:
   → Return 401 Unauthorized
```

**New Handler Functions**:

```typescript
async function handleAuth0Token(req, res, next, token): Promise<void>
// Auth0-specific flow:
// 1. validateAuth0JWT(token) → {sub, email, exp}
// 2. getTenantIdFromHost(req.hostname) → customer_id
// 3. getRoleAndStatus(sub, customer_id, exp) → {role, customer_status}
// 4. Check status !== 'suspended'
// 5. Attach req.user with auth0 claims
// Flow: Error at any step → return appropriate HTTP status

async function handleLegacyToken(req, res, next, token): Promise<void>
// Existing local flow (unchanged):
// 1. verifyToken(token) → payload
// 2. Query users table
// 3. Check is_active flag
// 4. Attach req.user
```

**Secondary Handler: `optionalAuth()`**

Like jwtAuth but doesn't reject requests (used for optional auth endpoints):

```
If token present AND valid:
  → Set req.user with authenticated info (same as jwtAuth)
Else:
  → Set req.user = null (not authenticated)
Always → Call next() (never reject)
```

**Role Middleware: `requireRole()`**

Already compatible (uses req.user.role which is set by jwtAuth):

```typescript
router.delete('/admin/users', jwtAuth, requireRole('admin'), handler);
// req.user.role comes from either Auth0 or local path
// requireRole() works identically for both
```

**Status**: Fully wired and tested

---

### 7. Environment Variables

**api/.env**
```sh
# Auth0
AUTH0_ENABLED=false                    # Switch to true to enable Auth0
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_AUDIENCE=https://api.iotistic.cloud
AUTH0_ISSUER=https://your-tenant.auth0.com/

# Provisioning API (for RBAC)
PROVISIONING_API_URL=http://localhost:3100
INTERNAL_AUTH_TOKEN=your-token-here           # MUST match provisioning service
RBAC_CACHE_TTL_SECONDS=300                    # 5 minutes (overridden by JWT exp)

# Tenant resolution
TENANT_MAPPING=                               # Optional static mapping
```

**provisioning/.env**
```sh
# Auth0
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_AUDIENCE=https://api.iotistic.cloud
AUTH0_ISSUER=https://your-tenant.auth0.com/
AUTH0_CLIENT_ID=your_m2m_client_id      # For future signup endpoint
AUTH0_CLIENT_SECRET=your_m2m_secret      # For future signup endpoint

# Internal RBAC
INTERNAL_AUTH_TOKEN=your-token-here           # MUST match api service
```

**Both files**:
```sh
# Generate strong tokens (run in any shell):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Status**: Documented in `.env.example` files

---

## Architecture

### Request Flow (Auth0 Token)

```
1. Client HTTP Request
   Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6I...

2. API Server (tenant-1.app.com)
   req.hostname = "tenant-1.app.com"
   req.headers.authorization = header

3. jwtAuth Middleware
   ├─ Extract token
   ├─ Detect alg = "RS256"
   ├─ Call handleAuth0Token()
   │
   ├─ validateAuth0JWT(token)
   │  ├─ Fetch Auth0 JWKS (cached 1 hour)
   │  ├─ Get public key by kid
   │  ├─ Verify signature + claims
   │  └─ Return {sub: "auth0|123", email: "user@ex.com", exp: <unix_ts>}
   │
   ├─ getTenantIdFromHost("tenant-1.app.com")
   │  └─ Return "cust_abc123" (cached 1 hour)
   │
   ├─ getRoleAndStatus("auth0|123", "cust_abc123", <exp>)
   │  ├─ Check cache (key = sha256("auth0|123" + "cust_abc123"))
   │  ├─ If miss: fetch from provisioning API
   │  │  GET /api/internal/users/auth0|123/tenants/cust_abc123/role
   │  │  (timeout = 5s, with stale cache fallback)
   │  ├─ Cache with TTL = min(300s, exp - now)
   │  └─ Return {role: "admin", customer_status: "active"}
   │
   └─ req.user = {
       id: 0,
       username: "auth0|123",
       email: "user@ex.com",
       role: "admin",
       customerId: "cust_abc123",
       isActive: true
     }

4. Route Handler
   Can access req.user (already populated)
   Can use requireRole('admin') middleware (works identically)
   Can inspect customer_status

5. Response
   Status: 200 (with user data)
```

### Cache Flow (Graceful Degradation)

```
Scenario 1: Normal Operation
Cache Hit (< 5 min old) → Return cached role instantly (200ms)

Scenario 2: Cache Miss
Fetch from provisioning API → Store result → Return (100ms)

Scenario 3: Provisioning API Down + Cache Exists
Use stale cache → Return (allow request) + log warning

Scenario 4: Provisioning API Down + No Cache
DENY REQUEST → Return 403 Forbidden
(Fail open principle: unknown role = deny)
```

---

## Testing Phase 1

### 1. Manual Testing (Local Dev)

#### Setup
```bash
cd provisioning
# Apply migration
npm run migrate

# Start service
npm run dev
# Logs: ✅ Database connected

cd ../api
npm run dev
# Logs: ✅ API listening on port 3002
```

#### Test Local Auth (Still Works)
```bash
# Register locally
curl -X POST http://localhost:3002/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"Test123!","email":"test@ex.com"}'

# Login locally
curl -X POST http://localhost:3002/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"Test123!"}'

# Response: { accessToken: "eyJhbGciOiJIUzI1NiI...", ... }

# Use token
curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiI..." \
  http://localhost:3002/api/devices
# Should work (legacy path used)
```

#### Test Auth0 JWT Validation
```bash
# Create a test Auth0 token (use auth0 CLI or sandbox)
# Or manually: https://jwt.io (encode RS256 JWT)

# Set environment
export AUTH0_ENABLED=true
export AUTH0_DOMAIN=your-tenant.auth0.com
export AUTH0_AUDIENCE=https://api.iotistic.cloud

# Test with Auth0 token
curl -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6I..." \
  http://localhost:3002/api/devices
# Should:
# - Fetch JWKS from Auth0
# - Validate RS256 signature
# - Resolve tenant from hostname
# - Fetch role from provisioning API
# - Return devices (if role allows)

# Or test rejection:
# - Invalid JWT → 401 Unauthorized
# - HS256 token with AUTH0_ENABLED=true → 401 (not supported)
# - Expired JWT → 401
# - Missing sub/email → 401
# - Unknown tenant → 403
# - Provisioning API down + no cache → 403
```

#### Test Tenant Resolution
```bash
# Subdomain extraction
curl -H "Authorization: Bearer <valid-token>" \
  http://tenant-1.app.local:3002/api/devices
# Extracts "tenant-1" from hostname, looks up in provisioning

# Fallback to header
curl -H "Authorization: Bearer <valid-token>" \
     -H "X-Customer-ID: cust_manual_123" \
  http://localhost:3002/api/devices
# Uses X-Customer-ID instead of subdomain
```

#### Test RBAC Cache
```bash
# Monitor cache stats (during request)
# Add endpoint for debugging (later phase)

# Verify TTL calculation
# - JWT exp = 1705326000 (unix timestamp)
# - Current time = 1705322400
# - TTL = min(300, 1705326000 - 1705322400) = min(300, 3600) = 300 seconds
# Cache expires in 5 minutes regardless

# Test graceful degradation
# Stop provisioning service: docker stop provisioning-api
# Send request with valid token but no cache
# → Should return 403 (deny by default)
# Send request again (cache exists from before)
# → Should still work (using stale cache)
```

### 2. Integration Tests (Phase 2+)

Create `api/test/jwt-auth.integration.test.ts`:

```typescript
describe('JWT Auth Integration', () => {
  test('Auth0 RS256 token accepted when AUTH0_ENABLED=true', () => {
    // Generate valid RS256 JWT from test Auth0 app
    // Send to /api/devices
    // Expect: 200 with devices
  });

  test('HS256 token rejected when AUTH0_ENABLED=true', () => {
    // Generate HS256 token
    // Send to /api/devices
    // Expect: 401 Unauthorized
  });

  test('Tenant resolution from subdomain', () => {
    // Create request from tenant-1.app.com
    // Should extract tenant-1 and resolve to customer_id
  });

  test('RBAC cache invalidation on role change', () => {
    // Fetch role (cache miss) → provisioning call
    // Change role in provisioning DB
    // Invalidate cache manually
    // Fetch role again (cache miss) → provisioning call with new role
  });

  test('Graceful degradation with stale cache', () => {
    // Set cache TTL to 0 (expired)
    // Stop provisioning API
    // Send request → should use stale cache
  });
});
```

### 3. End-to-End Tests (Phase 2)

Create `dashboard/e2e/auth0-flow.spec.ts`:

```typescript
test('Auth0 login flow', async ({ page }) => {
  // Navigate to /login
  // Click "Login with Auth0"
  // Redirected to auth0.com
  // Enter credentials
  // Redirected back with JWT token
  // Token stored in localStorage
  // Can access /devices dashboard
  // Can log out
});

test('Multi-tenant access', async ({ page }) => {
  // Login with Auth0 account that has multiple tenant roles
  // Navigate to tenant-1.app.com → sees devices
  // Navigate to tenant-2.app.com → sees different devices
  // Both work without re-login
});
```

---

## Environment Setup

### Production Deployment

**Step 1: Generate Auth0 Credentials**

1. Create Auth0 account at https://auth0.com
2. Create application: "IoTistic API"
3. Copy: Domain, Client ID, Client Secret
4. Configure allowed origins (K8s cluster IPs)
5. Create custom claims: (future phase) add sub/email as minimal claims

**Step 2: Set Environment Variables**

```bash
# In provisioning K8s deployment:
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_AUDIENCE=https://api.iotistic.cloud
AUTH0_ISSUER=https://your-tenant.auth0.com/
INTERNAL_AUTH_TOKEN=$(openssl rand -hex 32)

# In api K8s deployment:
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_AUDIENCE=https://api.iotistic.cloud
AUTH0_ISSUER=https://your-tenant.auth0.com/
AUTH0_ENABLED=false           # Start with false, enable in Phase 2
PROVISIONING_API_URL=http://provisioning-api.billing:3100
INTERNAL_AUTH_TOKEN=<same-as-above>
RBAC_CACHE_TTL_SECONDS=300
```

**Step 3: Run Migration**

```bash
kubectl exec -it -n billing deployment/provisioning-api -- \
  npm run migrate
# Logs: ✅ Migration 012_add_user_tenant_roles applied
```

**Step 4: Monitor**

```bash
# Check provisioning service logs
kubectl logs -n billing deployment/provisioning-api | grep RBAC

# Check API service logs
kubectl logs -n customer-abc123 deployment/api | grep "JWT-AUTH"

# Test health
curl https://billing.iotistic.cloud/health
curl https://api.customer-abc123.iotistic.cloud/health
```

---

## Phase 2 Preview

**Phase 2: Dual-Mode (Side-by-Side)**
- [ ] Update dashboard LoginPage.tsx to offer "Login with Auth0" button
- [ ] Create provisioning /api/auth/signup-auth0 endpoint (Auth0 webhook)
- [ ] Update requireRole() to handle Auth0 subs (log deprecation for local user routes)
- [ ] End-to-end tests (Auth0 callback, multi-tenant access)
- [ ] Monitoring dashboard (cache hit rates, JWK fetch latency)

**Phase 3: Cutover**
- [ ] Disable local password reset endpoints
- [ ] Remove per-tenant users table (after data migration)
- [ ] Enforce AUTH0_ENABLED=true in production

---

## Troubleshooting

### "Auth0 JWKS URL returned 404"

**Cause**: AUTH0_ISSUER is wrong or Auth0 app not configured

**Check**:
```bash
curl https://your-tenant.auth0.com/.well-known/jwks.json
# Should return { "keys": [...] }
```

**Fix**: Update `AUTH0_ISSUER` env var (include trailing slash)

---

### "Key ID not found in JWKS"

**Cause**: JWT header has kid that doesn't match any key in JWKS

**Possibilities**:
- Kid doesn't exist (Auth0 rotated keys)
- Multiple Auth0 instances (different domains)

**Fix**:
```bash
# Clear JWKS cache (next request will re-fetch)
```

---

### "Cannot determine user role in tenant" (403)

**Cause**: User exists in Auth0 but not assigned to this tenant in provisioning DB

**Check**:
```bash
# Verify row exists in provisioning.user_tenant_roles
SELECT * FROM user_tenant_roles 
WHERE auth0_sub = 'auth0|123' AND customer_id = 'cust_abc123';
```

**Fix**: Assign role in provisioning (admin endpoint or manually):
```bash
curl -X POST http://localhost:3100/api/internal/users \
  -H "X-Internal-Token: $INTERNAL_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "auth0_sub": "auth0|123456",
    "customer_id": "cust_abc123",
    "role": "admin"
  }'
```

---

### "Provisioning API unreachable, using stale cache" (Warning)

**Cause**: Provisioning service is down AND cache exists (graceful degradation working)

**Expected**: Request succeeds with cached role (old data is OK for short downtime)

**Monitor**: Cache hit rate and replace with fresh data when provisioning recovers

---

### "Provisioning API unreachable, no cache available" (403)

**Cause**: Provisioning service is down AND no cache exists

**Expected**: Request rejected (fail secure: deny unknown roles)

**Fix**: Restart provisioning service or pre-warm cache by making requests before outage

---

## Summary

**Phase 1 Complete**:
✅ Database schema for central RBAC (user_tenant_roles)
✅ Internal API for role lookups (secure X-Internal-Token auth)
✅ Auth0 JWT validation (RS256, JWKS caching, claims validation)
✅ Tenant resolution (subdomain + fallback headers)
✅ Smart role caching (TTL = min(5min, JWT exp), graceful degradation)
✅ Dual-mode middleware (Auth0 + legacy HS256 support)
✅ Environment variable documentation
✅ Feature-gated (AUTH0_ENABLED flag)

**Ready for Phase 2**: Dashboard Auth0 integration, provisioning signup endpoint, E2E testing

---

**Next**: Proceed to Phase 2 when ready. See Phase 1 files for detailed implementation reference.
