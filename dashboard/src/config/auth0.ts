/**
 * Auth0 Configuration
 * 
 * Handles Auth0 SPA authentication and token exchange.
 * Reads from window.env (Kubernetes ConfigMap) at runtime,
 * with fallback to import.meta.env (build-time environment variables).
 */

// Read from window.env (Kubernetes ConfigMap) first, then fallback to import.meta.env
const getEnv = (key: string): string => {
  // @ts-ignore - window.env is set by Kubernetes ConfigMap injected config.js
  if (typeof window !== 'undefined' && window.env && window.env[key]) {
    // @ts-ignore
    return window.env[key];
  }
  return (import.meta.env as Record<string, string | undefined>)[key] || '';
};

// Auth0 configuration from environment (required)
const AUTH0_DOMAIN = getEnv('VITE_AUTH0_DOMAIN');
const AUTH0_CLIENT_ID = getEnv('VITE_AUTH0_CLIENT_ID');
const AUTH0_AUDIENCE = getEnv('VITE_AUTH0_AUDIENCE');
const AUTH0_CALLBACK_URL = getEnv('VITE_AUTH0_CALLBACK_URL');
const AUTH0_SHOW_SOCIAL = getEnv('VITE_AUTH0_SHOW_SOCIAL_LOGIN') === 'true';

// Provisioning API URL (billing service)
const PROVISIONING_API_URL = getEnv('VITE_PROVISIONING_API_URL') || 'http://localhost:3100';

export const auth0Config = {
  domain: AUTH0_DOMAIN,
  clientId: AUTH0_CLIENT_ID,
  audience: AUTH0_AUDIENCE,
  callbackUrl: AUTH0_CALLBACK_URL,
  showSocialLogin: AUTH0_SHOW_SOCIAL,
  provisioningApiUrl: PROVISIONING_API_URL,
};

/**
 * Generate Auth0 login URL
 * 
 * Redirects user to Auth0 login page with:
 * - Specific audience (API identifier)
 * - Callback URL for redirect after login
 * - Scope for ID token + user info
 */
export function getAuth0LoginUrl(): string {
  if (!AUTH0_DOMAIN || !AUTH0_CLIENT_ID) {
    throw new Error('Auth0 not configured - check VITE_AUTH0_DOMAIN and VITE_AUTH0_CLIENT_ID');
  }

  const params = new URLSearchParams({
    client_id: AUTH0_CLIENT_ID,
    redirect_uri: AUTH0_CALLBACK_URL,
    response_type: 'code',
    scope: 'openid profile email',
    // Force login screen only (no signup tab) - new signups go through provisioning API
    screen_hint: 'login',
  });

  return `https://${AUTH0_DOMAIN}/authorize?${params.toString()}`;
}

/**
 * Exchange Auth0 authorization code for tokens
 * 
 * Called from /auth/callback after Auth0 redirects back
 * Server-side code exchange (recommended for security)
 * 
 * @param code - Authorization code from Auth0
 * @returns { accessToken, refreshToken, user }
 */
export async function exchangeAuth0Code(
  code: string
): Promise<{
  accessToken: string;
  refreshToken: string;
  user: any;
}> {
  if (!AUTH0_DOMAIN || !AUTH0_CLIENT_ID) {
    throw new Error('Auth0 not configured - check environment variables');
  }

  // Use provisioning API URL from config (defaults to localhost:3100 for development)
  const response = await fetch(`${PROVISIONING_API_URL}/api/auth/callback-auth0`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code,
      redirectUri: AUTH0_CALLBACK_URL,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    // Preserve full error object for needs_signup detection
    const err = new Error(error.message || 'Auth0 callback exchange failed');
    (err as any).data = error;
    throw err;
  }

  const data = await response.json();
  return {
    accessToken: data.data.accessToken,
    refreshToken: data.data.refreshToken,
    user: data.data.user,
  };
}

/**
 * Get Auth0 authorization code from URL
 * 
 * After Auth0 redirects back to /auth/callback, parse the code
 * Format: ?code=authorization_code_here
 * 
 * @returns Authorization code or null if not in URL
 */
export function getAuth0CodeFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('code');
}

/**
 * Get Auth0 error from callback URL
 * 
 * If Auth0 login failed, redirects with error + error_description
 * 
 * @returns { error, description } or null
 */
export function getAuth0ErrorFromUrl(): { error: string; description: string } | null {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  const description = params.get('error_description');

  if (error) {
    return { error, description: description || '' };
  }

  return null;
}

/**
 * Format Auth0 user info from JWT
 * 
 * Extracts minimal claims from ID token:
 * - sub: User identifier
 * - email: Email address
 * - name: Display name
 * 
 * @param idToken - JWT ID token from Auth0
 * @returns User info object
 */
export function parseAuth0IdToken(idToken: string): {
  sub: string;
  email: string;
  name?: string;
} {
  try {
    // Decode JWT (without verification - done by API)
    const parts = idToken.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }

    const payload = JSON.parse(atob(parts[1]));
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
    };
  } catch (error: any) {
    throw new Error(`Failed to parse Auth0 ID token: ${error.message}`);
  }
}
