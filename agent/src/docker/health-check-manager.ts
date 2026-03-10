/**
 * Health Check Manager
 * 
 * Manages health probe lifecycle:
 * - Schedules periodic checks
 * - Tracks success/failure thresholds
 * - Triggers status transitions
 * - Emits events for container actions (restart, mark unhealthy)
 */

import { EventEmitter } from 'events';
import Docker from 'dockerode';
import { HealthCheckExecutor } from './health-check-executor';
import {
  HealthProbe,
  ProbeState,
  ProbeType,
  ContainerHealth,
  HealthStatus,
  HealthCheckResult,
} from './types/health-check';

export interface HealthCheckConfig {
  containerId: string;
  serviceName: string;
  livenessProbe?: HealthProbe;
  readinessProbe?: HealthProbe;
  startupProbe?: HealthProbe;
}

/**
 * Events emitted by HealthCheckManager:
 * - 'liveness-failed': Container is unhealthy, needs restart
 * - 'readiness-changed': Container readiness status changed
 * - 'startup-completed': Container finished starting up
 */
export class HealthCheckManager extends EventEmitter {
  private executor: HealthCheckExecutor;
  private probes = new Map<string, ProbeState>(); // key: `${containerId}:${probeType}`
  private containerHealth = new Map<string, ContainerHealth>();

  constructor(docker: Docker) {
    super();
    this.executor = new HealthCheckExecutor(docker);
  }

  /**
   * Start monitoring a container with health probes
   */
  startMonitoring(config: HealthCheckConfig): void {
    const { containerId, serviceName } = config;

    // Initialize container health
    this.containerHealth.set(containerId, {
      containerId,
      serviceName,
      isLive: true,
      isReady: false,
      isStarted: false,
    });

    // Start each configured probe
    if (config.startupProbe) {
      this.startProbe(containerId, serviceName, 'startup', config.startupProbe);
    }

    if (config.livenessProbe) {
      this.startProbe(containerId, serviceName, 'liveness', config.livenessProbe);
    }

    if (config.readinessProbe) {
      this.startProbe(containerId, serviceName, 'readiness', config.readinessProbe);
    }

    // If no startup probe, mark as started immediately
    if (!config.startupProbe) {
      const health = this.containerHealth.get(containerId);
      if (health) {
        health.isStarted = true;
      }
    }
  }

  /**
   * Stop monitoring a container
   */
  stopMonitoring(containerId: string): void {
    // Clear all timers for this container
    for (const probeType of ['startup', 'liveness', 'readiness'] as ProbeType[]) {
      const key = this.getProbeKey(containerId, probeType);
      const state = this.probes.get(key);
      
      if (state?.timerId) {
        clearTimeout(state.timerId);
      }
      
      this.probes.delete(key);
    }

    this.containerHealth.delete(containerId);
  }

  /**
   * Get health status for a container
   */
  getHealth(containerId: string): ContainerHealth | undefined {
    return this.containerHealth.get(containerId);
  }

  /**
   * Get all monitored containers
   */
  getAllHealth(): ContainerHealth[] {
    return Array.from(this.containerHealth.values());
  }

  /**
   * Start a specific probe
   */
  private startProbe(
    containerId: string,
    serviceName: string,
    probeType: ProbeType,
    probe: HealthProbe
  ): void {
    const key = this.getProbeKey(containerId, probeType);

    // Initialize probe state
    const state: ProbeState = {
      probe,
      probeType,
      containerId,
      serviceName,
      status: 'unknown',
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
    };

    this.probes.set(key, state);

    // Update container health
    const health = this.containerHealth.get(containerId)!;
    switch (probeType) {
      case 'liveness':
        health.liveness = state;
        break;
      case 'readiness':
        health.readiness = state;
        break;
      case 'startup':
        health.startup = state;
        break;
    }

    // Schedule first check after initial delay
    const initialDelay = (probe.initialDelaySeconds || 0) * 1000;
    state.nextCheckAt = Date.now() + initialDelay;
    
    state.timerId = setTimeout(() => {
      this.performCheck(key);
    }, initialDelay);
  }

  /**
   * Perform a health check
   */
  private async performCheck(probeKey: string): Promise<void> {
    const state = this.probes.get(probeKey);
    if (!state) return;

    const { probe, containerId, probeType, serviceName } = state;
    const timeoutMs = (probe.timeoutSeconds || 1) * 1000;

    try {
      // Don't run liveness/readiness checks if startup probe hasn't passed
      if (probeType !== 'startup') {
        const health = this.containerHealth.get(containerId);
        if (health && !health.isStarted) {
          // Reschedule check
          this.scheduleNextCheck(probeKey);
          return;
        }
      }

      // Execute the check
      const result = await this.executor.execute(containerId, probe.check, timeoutMs);
      
      // Update state
      state.lastCheck = result;
      this.processResult(probeKey, result);

    } catch (error) {
      // Treat exceptions as failures
      const result: HealthCheckResult = {
        success: false,
        message: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
        duration: 0,
      };
      state.lastCheck = result;
      this.processResult(probeKey, result);
    }

    // Schedule next check
    this.scheduleNextCheck(probeKey);
  }

  /**
   * Process check result and update status
   */
  private processResult(probeKey: string, result: HealthCheckResult): void {
    const state = this.probes.get(probeKey);
    if (!state) return;

    const { probe, probeType, containerId, serviceName } = state;
    const successThreshold = probe.successThreshold || 1;
    const failureThreshold = probe.failureThreshold || 3;

    const previousStatus = state.status;

    if (result.success) {
      state.consecutiveSuccesses++;
      state.consecutiveFailures = 0;

      // Check if we've reached success threshold
      if (state.consecutiveSuccesses >= successThreshold && state.status !== 'healthy') {
        state.status = 'healthy';
        state.lastTransition = Date.now();
        this.handleStatusChange(probeKey, previousStatus, 'healthy');
      }
    } else {
      state.consecutiveFailures++;
      state.consecutiveSuccesses = 0;

      // Check if we've reached failure threshold
      if (state.consecutiveFailures >= failureThreshold && state.status !== 'unhealthy') {
        state.status = 'unhealthy';
        state.lastTransition = Date.now();
        this.handleStatusChange(probeKey, previousStatus, 'unhealthy');
      }
    }
  }

  /**
   * Handle status change events
   */
  private handleStatusChange(
    probeKey: string,
    oldStatus: HealthStatus,
    newStatus: HealthStatus
  ): void {
    const state = this.probes.get(probeKey);
    if (!state) return;

    const { probeType, containerId, serviceName } = state;
    const health = this.containerHealth.get(containerId);
    if (!health) return;

    console.log(
      `[HealthCheck] ${serviceName} (${containerId.slice(0, 12)}) ${probeType} probe: ${oldStatus} → ${newStatus}`
    );

    switch (probeType) {
      case 'startup':
        if (newStatus === 'healthy') {
          health.isStarted = true;
          this.emit('startup-completed', { containerId, serviceName });
          console.log(`[HealthCheck] ${serviceName} startup completed`);
        }
        break;

      case 'liveness':
        health.isLive = newStatus === 'healthy';
        if (newStatus === 'unhealthy') {
          this.emit('liveness-failed', {
            containerId,
            serviceName,
            message: state.lastCheck?.message,
          });
          console.log(
            `[HealthCheck] ${serviceName} liveness failed: ${state.lastCheck?.message || 'unknown'}`
          );
        }
        break;

      case 'readiness':
        const wasReady = health.isReady;
        health.isReady = newStatus === 'healthy';
        
        if (wasReady !== health.isReady) {
          this.emit('readiness-changed', {
            containerId,
            serviceName,
            isReady: health.isReady,
          });
          console.log(`[HealthCheck] ${serviceName} readiness: ${health.isReady ? 'ready' : 'not ready'}`);
        }
        break;
    }
  }

  /**
   * Schedule next check
   */
  private scheduleNextCheck(probeKey: string): void {
    const state = this.probes.get(probeKey);
    if (!state) return;

    const periodMs = (state.probe.periodSeconds || 10) * 1000;
    state.nextCheckAt = Date.now() + periodMs;

    state.timerId = setTimeout(() => {
      this.performCheck(probeKey);
    }, periodMs);
  }

  /**
   * Generate probe key
   */
  private getProbeKey(containerId: string, probeType: ProbeType): string {
    return `${containerId}:${probeType}`;
  }
}
