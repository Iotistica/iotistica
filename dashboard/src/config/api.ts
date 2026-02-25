/**
 * API Configuration
 * 
 * This module handles API endpoint configuration for both local and K8s deployments.
 * 
 * Local Development:
 *   - Uses localhost:3002 (configurable via VITE_API_URL)
 * 
 * Kubernetes Deployment:
 *   - Uses runtime config from window.env (ConfigMap)
 *   - Falls back to build-time import.meta.env if not available
 * 
 * Usage:
 *   import { getApiUrl } from '@/config/api';
 *   const response = await fetch(`${getApiUrl()}/api/v1/mqtt-monitor/stats`);
 */

// TypeScript declarations for runtime configuration
declare global {
  interface Window {
    env?: {
      VITE_API_URL?: string;
      NODE_ENV?: string;
      APP_VERSION?: string;
    };
  }
}

/**
 * Get the base API URL based on environment
 * 
 * Priority:
 * 1. VITE_API_URL environment variable (set via Helm chart or .env)
 *    - If empty string "", auto-detect using NodePort on current host
 * 2. Check if running in production (window.location.origin)
 * 3. Fall back to localhost:3002 for local development
 */
export function getApiUrl(): string {
  // Priority 1: Runtime configuration from ConfigMap (K8s)
  const runtimeApiUrl = window.env?.VITE_API_URL;
  // Priority 2: Build-time environment variable
  const buildApiUrl = import.meta.env.VITE_API_URL;
  
  const envApiUrl = runtimeApiUrl || buildApiUrl;
  
  // Check for explicit environment variable (runtime or build time)
  if (envApiUrl && envApiUrl !== '__VITE_API_URL__') {
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

  // Local development default - API runs on 4002 (docker-compose maps 4002:3002)
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
  runtimeApiUrl: window.env?.VITE_API_URL,
  buildApiUrl: import.meta.env.VITE_API_URL,
  envHousekeeperUrl: import.meta.env.VITE_HOUSEKEEPER_URL,
  configSource: window.env?.VITE_API_URL ? 'runtime (ConfigMap)' : 'build-time',
};

// Log configuration in development mode
if (import.meta.env.DEV) {
  console.log('[API Config]', apiConfig);
}
