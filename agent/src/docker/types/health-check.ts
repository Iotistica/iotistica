/**
 * Health Check Types
 * 
 * Kubernetes-style health probes for container monitoring:
 * - Liveness: Detects broken containers (triggers restart)
 * - Readiness: Detects temporarily unavailable containers (marks unhealthy)
 * - Startup: Protects slow-starting containers from premature liveness checks
 */

export type HealthCheckType = 'http' | 'tcp' | 'exec';
export type ProbeType = 'liveness' | 'readiness' | 'startup';
export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

/**
 * HTTP health check configuration
 */
export interface HttpHealthCheck {
  type: 'http';
  path: string;                    // e.g., "/health", "/api/healthz"
  port: number;                    // Port to check (inside container)
  scheme?: 'http' | 'https';       // Default: 'http'
  headers?: Record<string, string>; // Optional HTTP headers
  expectedStatus?: number[];        // Default: [200-399]
}

/**
 * TCP socket health check configuration
 */
export interface TcpHealthCheck {
  type: 'tcp';
  port: number;                     // Port to check (inside container)
}

/**
 * Command execution health check configuration
 */
export interface ExecHealthCheck {
  type: 'exec';
  command: string[];                // Command to execute inside container
}

/**
 * Union type for all health check methods
 */
export type HealthCheck = HttpHealthCheck | TcpHealthCheck | ExecHealthCheck;

/**
 * Common health probe configuration
 */
export interface HealthProbe {
  // Health check method
  check: HealthCheck;
  
  // Timing configuration
  initialDelaySeconds?: number;   // Wait before first check (default: 0)
  periodSeconds?: number;         // How often to check (default: 10)
  timeoutSeconds?: number;        // Check timeout (default: 1)
  
  // Success/failure thresholds
  successThreshold?: number;      // Consecutive successes to mark healthy (default: 1)
  failureThreshold?: number;      // Consecutive failures to mark unhealthy (default: 3)
}

/**
 * Result of a single health check execution
 */
export interface HealthCheckResult {
  success: boolean;
  message?: string;
  timestamp: number;
  duration: number;               // milliseconds
}

/**
 * Tracked state for a health probe
 */
export interface ProbeState {
  // Configuration
  probe: HealthProbe;
  probeType: ProbeType;
  containerId: string;
  serviceName: string;
  
  // Current state
  status: HealthStatus;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  
  // History
  lastCheck?: HealthCheckResult;
  lastTransition?: number;        // Timestamp of last status change
  
  // Timer management
  timerId?: NodeJS.Timeout;
  nextCheckAt?: number;
}

/**
 * Container health summary
 */
export interface ContainerHealth {
  containerId: string;
  serviceName: string;
  
  // Probe states
  liveness?: ProbeState;
  readiness?: ProbeState;
  startup?: ProbeState;
  
  // Overall health
  isLive: boolean;                // False = container needs restart
  isReady: boolean;               // False = container not ready for traffic
  isStarted: boolean;             // False = still starting up
}
