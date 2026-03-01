/**
 * Authentication Interceptor
 * 
 * Automatically adds JWT token to all API requests
 * and handles token refresh on 401 responses
 * 
 * NOTE: This interceptor chains with apiInterceptor.ts
 * Make sure to import authInterceptor AFTER apiInterceptor in App.tsx
 */

import { buildApiUrl } from '../config/api';

// Store the current fetch (might already be wrapped by apiInterceptor)
const originalFetch = window.fetch;

// Track if we're currently refreshing to avoid multiple refresh attempts
let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = localStorage.getItem('refreshToken');

  if (!refreshToken) {
    return false;
  }

  try {
    const response = await originalFetch(buildApiUrl('/api/v1/auth/refresh'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) {
      // Refresh failed, clear tokens
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      return false;
    }

    const data = await response.json();
    localStorage.setItem('accessToken', data.data.accessToken);
    return true;
  } catch (error) {
    console.error('Token refresh error:', error);
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    return false;
  }
}

// Override global fetch
window.fetch = async function (...args: Parameters<typeof fetch>): Promise<Response> {
  const [url, options = {}] = args;
  const urlString = typeof url === 'string' ? url : url.toString();

  // Only intercept API calls (not external resources)
  const isApiCall = urlString.includes('/api/v1/');
  
  // Don't intercept auth endpoints
  const isAuthEndpoint = urlString.includes('/api/v1/auth/login') || 
                         urlString.includes('/api/v1/auth/register') ||
                         urlString.includes('/api/v1/auth/refresh');

  if (isApiCall && !isAuthEndpoint) {
    // Add Authorization header
    const accessToken = localStorage.getItem('accessToken');
    if (accessToken) {
      options.headers = {
        ...options.headers,
        Authorization: `Bearer ${accessToken}`,
      };
    }
  }

  // Make the request
  let response = await originalFetch(url, options);

  // Handle 401 Unauthorized by attempting token refresh
  if (response.status === 401 && isApiCall && !isAuthEndpoint) {
    // If already refreshing, wait for that refresh to complete
    if (isRefreshing && refreshPromise) {
      const refreshed = await refreshPromise;
      if (refreshed) {
        // Retry the original request with new token
        const newToken = localStorage.getItem('accessToken');
        options.headers = {
          ...options.headers,
          Authorization: `Bearer ${newToken}`,
        };
        response = await originalFetch(url, options);
      }
    } else {
      // Start refresh process
      isRefreshing = true;
      refreshPromise = refreshAccessToken();
      
      const refreshed = await refreshPromise;
      isRefreshing = false;
      refreshPromise = null;

      if (refreshed) {
        // Retry the original request with new token
        const newToken = localStorage.getItem('accessToken');
        options.headers = {
          ...options.headers,
          Authorization: `Bearer ${newToken}`,
        };
        response = await originalFetch(url, options);
      } else {
        // Refresh failed: keep current route and let page-level auth handling decide.
        // Some endpoints can legitimately return 401/403 for authorization reasons.
        console.log('Token refresh failed; preserving current route for app-level handling.');
      }
    }
  }

  return response;
};
