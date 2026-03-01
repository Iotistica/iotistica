# Auth0 Multi-Tenant RBAC - Phase 2 Implementation Guide

**Status**: ✅ Phase 2 Dashboard Auth0 Integration Complete  
**Date**: March 1, 2026  
**Scope**: Dashboard Auth0 login UI, callback handler, backend code exchange  

---

## What's Been Implemented (Phase 2)

### 1. Dashboard Auth0 Configuration (`dashboard/src/config/auth0.ts`)

**Purpose**: Centralized Auth0 client configuration and OAuth flow helpers

**Exported Functions**:

```typescript
// Configuration object (from environment variables)
auth0Config = {
  domain: string,           // Auth0 tenant domain
  clientId: string,         // SPA client ID
  audience: string,         // API identifier
  callbackUrl: string,      // Redirect URI after login
  enabled: boolean,         // Feature flag (VITE_AUTH0_ENABLED)
  showSocialLogin: boolean  // Show Google/social buttons
}

// Generate Auth0 login URL (redirect user to auth0.com)
getAuth0LoginUrl(): string

// Exchange authorization code for tokens (backend, secure)
exchangeAuth0Code(code: string, apiUrl: string): Promise<{
  accessToken: string,
  refreshToken: string,
  user: { email, name, ... }
}>

// Parse Auth0 query parameters from callback URL
getAuth0CodeFromUrl(): string | null
getAuth0ErrorFromUrl(): { error, description } | null

// Decode JWT ID token (extracts user claims without verification)
parseAuth0IdToken(idToken: string): { sub, email, name }
```

**Configuration Priority**:
1. Environment variables: `VITE_AUTH0_*`
2. Dashboard `.env.local` file
3. From `import.meta.env` (build-time)

**Enable Auth0**:
```bash
# .env.local
VITE_AUTH0_ENABLED=true
VITE_AUTH0_DOMAIN=your-tenant.auth0.com
VITE_AUTH0_CLIENT_ID=your_spa_client_id_here
VITE_AUTH0_AUDIENCE=https://api.iotistic.cloud
VITE_AUTH0_CALLBACK_URL=http://localhost:5173/auth/callback
VITE_AUTH0_SHOW_SOCIAL_LOGIN=true
```

**Status**: ✅ Ready for testing

---

### 2. Updated LoginPage (`dashboard/src/pages/LoginPage.tsx`)

**What's New**:

- **Auth0 button**: "Login with Auth0" button (when `auth0Config.enabled === true`)
- **Social login**: Optional Google/social login button (when `showSocialLogin === true`)
- **Divider**: Visual separator between Auth0 and email/password (similar to Google/GitHub signup pages)
- **Dual-mode**: Both Auth0 and legacy email/password authentication work simultaneously
- **Responsive**: Buttons stack on mobile, inline on desktop

**User Flow**:

```
User visits /login

If Auth0 enabled:
  ✅ Show "Login with Auth0" button (blue, primary)
  ✅ Show "Login with Google" button (if showSocialLogin=true)
  ✅ Show "Or continue with email" divider
  ✅ Show email/password form

User clicks "Login with Auth0":
  → handleAuth0Login() called
  → Redirects to getAuth0LoginUrl()
  → User taken to auth0.com
  → User logs in / signs up
  → Auth0 redirects back to VITE_AUTH0_CALLBACK_URL (/auth/callback)
  → CallbackPage handles exchange

User enters email/password:
  → handleSubmit() called (legacy path, unchanged)
  → POST /api/v1/auth/login
  → Receives JWT, stores in localStorage
  → Logged in
```

**Code Location**: [dashboard/src/pages/LoginPage.tsx](../dashboard/src/pages/LoginPage.tsx)

**Status**: ✅ Integrated in main app

---

### 3. Auth0 Callback Page (`dashboard/src/pages/CallbackPage.tsx`)

**Purpose**: Handle Auth0 redirect back to dashboard with authorization code

**Flow**:

```
1. User redirected from auth0.com to /auth/callback?code=...&state=...

2. CallbackPage mounts
   ├─ Check for errors in URL (error=..., error_description=...)
   ├─ If error: Display error, show "Return to login" button
   └─ If no error: Continue

3. Get authorization code from URL
   └─ Code extracted from ?code= query parameter

4. Call exchangeAuth0Code()
   ├─ POST to /api/v1/auth/callback-auth0
   ├─ Body: { code, redirectUri }
   ├─ Returns: { accessToken, refreshToken, user }
   └─ Handle timeouts / failures

5. Store tokens
   ├─ localStorage.accessToken
   ├─ localStorage.refreshToken
   └─ Call onLogin() handler

6. Redirect
   └─ Navigate to dashboard home (/)
```

**UI States**:

- **Processing**: Shows spinner, "Processing your login..."
- **Error**: Shows error message, "Return to login" button
- **Success**: Automatic redirect (user doesn't see page)

**Code Location**: [dashboard/src/pages/CallbackPage.tsx](../dashboard/src/pages/CallbackPage.tsx)

**Status**: ✅ Mounted at `/auth/callback` route

---

### 4. React Router Setup (`dashboard/src/main.tsx`)

**Updated**:

- Imported `CallbackPage` component
- Added new route: `<Route path="/auth/callback" element={<CallbackPage ... />} />`
- Route must come before catch-all `<Route path="*" />` to match specifically

**Route Order** (important):

```tsx
<Routes>
  <Route path="/auth/callback" element={...} />  {/* Must be first */}
  <Route path="/fleets/..." element={...} />
  <Route path="*" element={...} />              {/* Catch-all last */}
</Routes>
```

**Status**: ✅ Configured

---

### 5. Backend Auth0 Callback Endpoint (`provisioning/src/routes/auth.ts`)

**Endpoint**: `POST /api/auth/callback-auth0`

**Purpose**: Secure backend code exchange (prevents exposing client secret to frontend)

**Flow**:

```
Frontend               Dashboard Backend         Auth0
   |                         |                    |
   +--- POST /auth/callback--+                    |
   |    { code, redirectUri } |                    |
   |                         +-- POST /oauth/token→
   |                         |  { code, client_secret }
   |                         |                    |
   |                         ←-- { access_token, id_token }
   |                         |                    |
   |                         (parse id_token)
   |                         |
   |←-- { accessToken, ... } +  [TODO: assign user to tenant]
   |
```

**Request**:

```json
POST /api/auth/callback-auth0
{
  "code": "authorization_code_from_auth0_url",
  "redirectUri": "http://localhost:5173/auth/callback"
}
```

**Response (Phase 2 - Placeholder)**:

```json
{
  "data": {
    "accessToken": "placeholder-jwt-here",
    "refreshToken": "placeholder-refresh-here",
    "user": {
      "auth0Sub": "auth0|abc123",
      "email": "user@example.com",
      "name": "User Name"
    }
  }
}
```

**Environment Variables Required**:

```bash
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_CLIENT_ID=provisioning_m2m_client_id
AUTH0_CLIENT_SECRET=provisioning_m2m_client_secret
AUTH0_AUDIENCE=https://api.iotistic.cloud
```

**Error Handling**:

- ❌ `env NOT configured` → 500 "Auth0 not configured on server"
- ❌ `Code exchange fails` → 401 "Failed to exchange Auth0 code"
- ❌ `ID token parse fails` → 401 "Failed to parse user info"
- ❌ `Other errors` → 500 "Internal server error"

**Code Location**: [provisioning/src/routes/auth.ts](../provisioning/src/routes/auth.ts)

**Status**: ✅ Implemented (returns placeholder JWT)

---

## How to Test Phase 2

### 1. Setup Auth0

**Prerequisites**:
- Auth0 account at https://auth0.com
- Create SPA application

**Auth0 Dashboard Configuration**:

1. **Application Settings**:
   - Application Type: Single Page Application
   - Framework: React
   - Name: Iotistica Dashboard Dev

2. **Allowed Callback URLs**:
   ```
   http://localhost:5173/auth/callback
   https://dashboard.iotistic.cloud/auth/callback
   ```

3. **Allowed Logout URLs**:
   ```
   http://localhost:5173/login
   https://dashboard.iotistic.cloud/login
   ```

4. **Allowed Web Origins**:
   ```
   http://localhost:5173
   http://localhost:3000
   https://dashboard.iotistic.cloud
   ```

5. **Copy credentials**:
   - Domain: `your-tenant.auth0.com`
   - Client ID: `abc123...` (SPA)
   - Audience: `https://api.iotistic.cloud`

### 2. Configure Dashboard

**Local Development** (`.env.local`):

```bash
VITE_AUTH0_ENABLED=true
VITE_AUTH0_DOMAIN=your-tenant.auth0.com
VITE_AUTH0_CLIENT_ID=your_spa_client_id_here
VITE_AUTH0_AUDIENCE=https://api.iotistic.cloud
VITE_AUTH0_CALLBACK_URL=http://localhost:5173/auth/callback
VITE_AUTH0_SHOW_SOCIAL_LOGIN=true
```

### 3. Configure Provisioning (Optional for Phase 2)

For full testing (code exchange), configure M2M credentials:

```bash
# M2M application (not SPA) for backend token exchange
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_CLIENT_ID=your_m2m_client_id
AUTH0_CLIENT_SECRET=your_m2m_secret
AUTH0_AUDIENCE=https://api.iotistic.cloud
```

### 4. Start Services

```bash
# Terminal 1: Dashboard
cd dashboard
npm run dev
# http://localhost:5173

# Terminal 2: Provisioning (for callback exchange)
cd provisioning
npm run dev
# http://localhost:3100
```

### 5. Test Login Flow

**Test 1: Local Auth (Legacy)**

```
1. Go to http://localhost:5173/login
2. See "Login with Auth0" button (if AUTH0_ENABLED)
3. See "Or continue with email" divider
4. Enter email/password
5. Click "Sign In"
6. ✅ Should log in via legacy path (/api/v1/auth/login)
```

**Test 2: Auth0 Login**

```
1. Go to http://localhost:5173/login
2. Click "Login with Auth0"
3. Redirected to auth0.com login
4. Enter Auth0 credentials (or signup)
5. Redirected back to http://localhost:5173/auth/callback?code=...
6. CallbackPage shows "Processing your login..."
7. POST /api/v1/auth/callback-auth0 called
8. Tokens exchanged
9. Auto-redirect to dashboard
10. ✅ Should be logged in
```

**Test 3: Auth0 Error**

```
1. Go to http://localhost:5173/login
2. Click "Login with Auth0"
3. You're in Auth0, click "Cancel" or decline
4. Redirected back to ?error=access_denied&error_description=...
5. CallbackPage shows error message
6. Click "Return to login"
7. ✅ Back at login page, can try again
```

**Test 4: Social Login (Google)**

```
1. Go to http://localhost:5173/login
2. Click "Login with Google" (if VITE_AUTH0_SHOW_SOCIAL_LOGIN=true)
3. Same flow as Auth0 (uses Auth0's Google integration)
4. ✅ Auth0 handles Google OAuth seamlessly
```

---

## Known Limitations (Phase 2→3)

### ⚠️ Multi-Tenant Assignment Not Yet Implemented

**Placeholder Response**:
```typescript
res.json({
  data: {
    accessToken: 'placeholder-jwt-here',  // Hardcoded!
    refreshToken: 'placeholder-refresh-here',
    user: { auth0Sub, email, name }
  }
});
```

**TODO (Phase 3)**:
1. Look up customer assigned to Auth0 sub
2. Call internal RBAC endpoint: `GET /api/internal/users/{sub}/tenants/{customer_id}/role`
3. Generate real JWT with tenant + role
4. Return real tokens

### ⚠️ How Auth0 User → Customer Assignment Happens?

**Options**:

**Option A: Admin Dashboard** (Recommended)
- Admin goes to customer > "Users" tab
- Adds "user@email.com" as "admin" / "operator" / etc
- Button: "Add from Auth0"
- Prompts: Enter Auth0 sub or email
- Backend calls `POST /api/internal/users` to assign

**Option B: Auto-First-User-Is-Admin**
- First person to login with Auth0 for a customer
- Automatically becomes admin
- Requires storing customer <→ auth0_sub mapping

**Option C: Auth0 signup webhook**
- User signs up via Auth0
- Auth0 webhook calls provisioning: `POST /api/auth/signup-auth0`
- Frontend specifies which customer to join
- Automatically assigned role "viewer" or prompt for customer selection

**Recommended**: Option A (explicit admin control + Option C for signups)

---

## Architecture Diagram (Phase 2)

```
┌─────────────────────────────────────────────────────────────────┐
│ User Opens http://localhost:5173/login                          │
└─────────────────────────────────────────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
            Click "Login with Auth0"     Enter email/password
                    │                           │
            ┌───────▼──────────┐      ┌────────▼────────┐
            │ handleAuth0Login() │      │  handleSubmit()  │
            │ getAuth0LoginUrl()│      │ POST /auth/login │
            └───────┬───────────┘      └────────┬────────┘
                    │                           │
        Redirect to auth0.com         Response: accessToken
                    │                           │
        User logs in / signs up         localStorage.setItem()
                    │                           │
        Redirects to /auth/callback            │
            ?code=abc123...         ┌──────────▼──────────┐
                    │               │  Logged in, Show    │
         ┌──────────▼──────────┐    │  Dashboard          │
         │  CallbackPage mounts │    └─────────────────────┘
         │  (processes code)    │
         │                      │
         │ exchangeAuth0Code()  │
         │ POST /auth/callback- │
         │ auth0?{code,uri}     │
         │                      │
         │ Backend exchanges    │
         │ with Auth0 (/oauth)  │
         │                      │
         │ Returns accessToken  │
         │ (currently placeholder)
         │                      │
         │ localStorage.setItem │
         │ Redirect to /        │
         └──────────┬───────────┘
                    │
         ┌──────────▼──────────┐
         │  Logged in, Show    │
         │  Dashboard          │
         └─────────────────────┘
```

---

## Next Steps (Phase →3)

### 1. Real Token Generation

Replace placeholder JWT in `/api/auth/callback-auth0`:

```typescript
// Step 3: Get customer assigned to this Auth0 user
const customer = await lookupCustomerByAuth0Sub(auth0Sub);
if (!customer) {
  // Option 1: Auto-create trial for first-time Auth0 users
  // Option 2: Return 404 "No customer assigned"
}

// Step 4: Get role from RBAC cache
const role = await getRoleAndStatus(auth0Sub, customer.id);

// Step 5: Generate JWT with tenant + role info
const jwt = sign({
  sub: auth0Sub,
  email,
  customer_id: customer.id,
  role: role.role,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
}, JWT_SECRET);

res.json({
  data: {
    accessToken: jwt,   // Real JWT!
    refreshToken: '...',   // Implement refresh logic
    user: { email, name, customer_id: customer.id }
  }
});
```

### 2. Multi-Tenant Signup Flow

Create `POST /api/auth/signup-auth0` endpoint:

```
1. User clicks "Sign up with Auth0"
2. Auth0 login/signup
3. CreateOrUpdateCustomerDialog prompts: "Which customer do you want to join?"
4. User selects customer
5. POST /api/auth/signup-auth0 with { auth0Sub, customerId, email }
6. Backend calls POST /api/internal/users to assign role
7. Returns JWT with role
```

### 3. Logout

Add logout button to dashboard header:

```typescript
const handleLogout = () => {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  
  if (auth0Config.enabled) {
    // Redirect to Auth0 logout (optional)
    const logoutUrl = `https://${auth0Config.domain}/v2/logout?client_id=${auth0Config.clientId}&returnTo=${window.location.origin}`;
    window.location.href = logoutUrl;
  } else {
    // Stay on login page for legacy auth
    window.location.href = '/login';
  }
};
```

### 4. Refresh Token

If Auth0 tokens expire (<1 hour), implement refresh logic:

```typescript
// In CallbackPage or after token exchange
const jwtPayload = parseJwt(accessToken);
const expiresIn = jwtPayload.exp - Math.floor(Date.now() / 1000);

if (expiresIn < 300) {  // Less than 5 min left
  // Exchange refresh token for new access token
  // PUT /api/auth/refresh-token with { refreshToken }
}
```

### 5. E2E Tests

Create `dashboard/e2e/auth0-flow.spec.ts`:

```typescript
test('Auth0 login and dashboard access', async ({ page }) => {
  // Test full flow:
  // 1. Navigate to /login
  // 2. Click Auth0 button
  // 3. Mock Auth0 callback
  // 4. Verify dashboard loads
  // 5. Check devices are visible
});
```

---

## Summary of Phase 2 Files

| File | Change | Status |
|------|--------|--------|
| `dashboard/.env.example` | Added Auth0 env vars | ✅ |
| `dashboard/src/config/auth0.ts` | New: Auth0 config + helpers | ✅ |
| `dashboard/src/pages/CallbackPage.tsx` | New: Auth0 callback handler | ✅ |
| `dashboard/src/pages/LoginPage.tsx` | Updated: Added Auth0 button + divider | ✅ |
| `dashboard/src/main.tsx` | Updated: Added /auth/callback route | ✅ |
| `provisioning/src/routes/auth.ts` | Updated: Added code exchange endpoint | ✅ |

---

## Testing Checklist

- [ ] Auth0 tenant created with SPA + callback URLs configured
- [ ] Dashboard `.env.local` configured with Auth0 credentials
- [ ] `npm run dev` in dashboard starts without errors
- [ ] Login page shows "Login with Auth0" button
- [ ] Clicking button redirects to auth0.com
- [ ] Auth0 login succeeds
- [ ] Redirected back to `/auth/callback` with `code=...`
- [ ] CallbackPage processes code
- [ ] POST `/api/auth/callback-auth0` succeeds (returns placeholder JWT)
- [ ] Auto-redirect to dashboard
- [ ] Tab shows "logged in" state (check localStorage)
- [ ] Legacy email/password still works
- [ ] Auth0 error flow works (deny/cancel returns to login)

---

**Phase 2 Complete!** Ready to proceed to Phase 3 (real token generation + multi-tenant assignment).
