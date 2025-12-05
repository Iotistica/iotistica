/**
 * API Configuration
 * 
 * This module handles API endpoint configuration for both local and K8s deployments.
 * 
 * Local Development:
 *   - Uses localhost:4002 (configurable via VITE_API_URL)
 * 
 * Kubernetes Deployment:
 *   - Uses relative path "/api" (same ingress as dashboard)
 *   - Environment variables are injected at build time via Vite
 * 
 * Usage:
 *   import { getApiUrl } from '@/config/api';
 *   const response = await fetch(`${getApiUrl()}/api/v1/mqtt-monitor/stats`);
 */

/**
 * Get the base API URL based on environment
 * 
 * Priority:
 * 1. VITE_API_URL environment variable (set via Helm chart or .env)
 *    - If empty string "", auto-detect using NodePort on current host
 * 2. Check if running in production (window.location.origin)
 * 3. Fall back to localhost:4002 for local development
 */
export function getApiUrl(): string {
  const envApiUrl = import.meta.env.VITE_API_URL;
  
  // Check for explicit environment variable (set at build time for K8s)
  if (envApiUrl) {
    // Empty string means auto-detect (K8s NodePort mode)
    if (envApiUrl === '' && import.meta.env.PROD) {
      // Extract hostname from current URL and use API NodePort (30002)
      const hostname = window.location.hostname;
      const protocol = window.location.protocol;
      return `${protocol}//${hostname}:30002`;
    }
    return envApiUrl;
  }

  // In production (K8s), try auto-detect with NodePort
  if (import.meta.env.PROD) {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;
    // Default to NodePort 30002 if no explicit config
    return `${protocol}//${hostname}:30002`;
  }

  // Local development default
  return 'http://localhost:4002';
}

/**
 * Build a full API endpoint URL
 * @param path - API path (e.g., '/api/v1/mqtt-monitor/stats')
 * @returns Full URL
 */
export function buildApiUrl(path: string): string {
  const baseUrl = getApiUrl();
  // Remove leading slash if present to avoid double slashes
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${cleanPath}`;
}

/**
 * Get the Housekeeper service URL
 * 
 * Priority:
 * 1. VITE_HOUSEKEEPER_URL environment variable
 * 2. Fall back to localhost:3400 for local development
 * 3. In production, use relative path or same host
 */
export function getHousekeeperUrl(): string {
  // Check for explicit environment variable
  if (import.meta.env.VITE_HOUSEKEEPER_URL) {
    return import.meta.env.VITE_HOUSEKEEPER_URL;
  }

  // In production (K8s), use relative path if available
  if (import.meta.env.PROD) {
    return window.location.origin;
  }

  // Local development default - housekeeper runs on port 3400
  return 'http://localhost:3400';
}

/**
 * Build a full Housekeeper API endpoint URL
 * @param path - API path (e.g., '/api/housekeeper/tasks')
 * @returns Full URL
 */
export function buildHousekeeperUrl(path: string): string {
  const baseUrl = getHousekeeperUrl();
  // Remove leading slash if present to avoid double slashes
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${cleanPath}`;
}

// Export current configuration for debugging
export const apiConfig = {
  baseUrl: getApiUrl(),
  housekeeperUrl: getHousekeeperUrl(),
  isDevelopment: import.meta.env.DEV,
  isProduction: import.meta.env.PROD,
  envApiUrl: import.meta.env.VITE_API_URL,
  envHousekeeperUrl: import.meta.env.VITE_HOUSEKEEPER_URL,
};

// Log configuration in development mode
if (import.meta.env.DEV) {
  console.log('[API Config]', apiConfig);
}
