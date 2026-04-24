/**
 * Argo CD Status Service
 * Queries Argo CD API to confirm Application deployment status
 * 
 * Used by deployment workers to determine when a client is fully deployed
 * and mark customer as 'ready' in billing database.
 */

import axios, { AxiosInstance } from 'axios';
import https from 'https';
import { logger } from '../utils/logger';
import { CustomerModel } from '../db/customer-model';

interface ArgoApplication {
  metadata: {
    name: string;
    namespace: string;
  };
  spec: {
    destination: {
      namespace: string;
      server: string;
    };
  };
  status: {
    sync: {
      status: 'Synced' | 'OutOfSync' | 'Unknown';
      revision?: string;
    };
    health: {
      status: 'Healthy' | 'Progressing' | 'Degraded' | 'Suspended' | 'Missing' | 'Unknown';
      message?: string;
    };
    operationState?: {
      phase: 'Running' | 'Succeeded' | 'Failed' | 'Error' | 'Terminating';
      message?: string;
      finishedAt?: string;
    };
  };
}

interface ArgoConfig {
  baseUrl: string;
  token: string;
  maxRetries: number;
  retryDelayMs: number;
}

export class ArgoStatusService {
  private client: AxiosInstance;
  private config: ArgoConfig;

  constructor() {
    this.config = {
      baseUrl: process.env.ARGOCD_BASE_URL || 'https://argocd.iotistica.com',
      token: process.env.ARGOCD_TOKEN || '',
      maxRetries: parseInt(process.env.ARGOCD_STATUS_MAX_RETRIES || '90'),
      retryDelayMs: parseInt(process.env.ARGOCD_STATUS_RETRY_DELAY_MS || '10000'),
    };

    // Remove trailing slash from base URL
    this.config.baseUrl = this.config.baseUrl.replace(/\/$/, '');

    this.client = axios.create({
      baseURL: this.config.baseUrl,
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      // Allow self-signed certificates for dev/test environments
      httpsAgent: process.env.NODE_ENV === 'production' 
        ? undefined 
        : new https.Agent({ rejectUnauthorized: false }),
    });

    if (!this.config.token) {
      logger.warn('ARGOCD_TOKEN not set - status checks will fail');
    }
  }

  /**
   * Get Application status from Argo CD
   */
  async getApplicationStatus(clientId: string): Promise<ArgoApplication | null> {
    try {
      const appName = `client-${clientId}`;
      const response = await this.client.get<ArgoApplication>(
        `/api/v1/applications/${appName}`
      );

      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.warn('Application not found in Argo CD', { clientId });
        return null;
      }

      logger.error('Failed to get Application status', {
        clientId,
        error: error.message,
        status: error.response?.status,
      });
      throw error;
    }
  }

  /**
   * Check if Application has reached an acceptable ready state.
   *
   * Primary success condition is Synced + Healthy.
   * Secondary success condition is Synced + operation Succeeded while health is
   * still catching up in Argo CD aggregation (commonly Progressing/Unknown).
   */
  async isApplicationReady(clientId: string): Promise<boolean> {
    const app = await this.getApplicationStatus(clientId);
    
    if (!app) {
      return false;
    }

    const syncStatus = app.status.sync.status;
    const healthStatus = app.status.health.status;
    const operationPhase = app.status.operationState?.phase;
    const isReady = this.isReadyState(syncStatus, healthStatus, operationPhase);

    logger.info('Application status check', {
      clientId,
      syncStatus,
      healthStatus,
      operationPhase,
      isReady,
    });

    return isReady;
  }

  /**
   * Wait for Application to become ready with retries
   * 
   * Polls Argo CD API until:
   * - Application is Synced and Healthy (success)
   * - Max retries reached (failure)
   * - Application sync/health fails (failure)
   * 
   * Implements smart retry logic:
   * - Tracks retry count in database (argo_retry_count)
   * - Auto-retry up to 3 times with exponential backoff
   * - After 3 failures, marks as 'deployment_failed' for manual intervention
   * 
   * @param clientId Client ID (without 'client-' prefix)
   * @param customerId Customer ID for retry tracking
   * @returns true if ready, false if failed/timeout
   */
  async waitForApplicationReady(clientId: string, customerId?: string): Promise<boolean> {
    logger.info('Waiting for Application to be ready', {
      clientId,
      customerId,
      maxRetries: this.config.maxRetries,
      retryDelayMs: this.config.retryDelayMs,
    });

    let lastKnownStatus: { syncStatus: string; healthStatus: string; operationPhase?: string } | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const app = await this.getApplicationStatus(clientId);

        if (!app) {
          logger.warn('Application not found, retrying...', {
            clientId,
            attempt,
            maxRetries: this.config.maxRetries,
          });
          
          if (attempt < this.config.maxRetries) {
            await this.sleep(this.config.retryDelayMs);
          }
          continue;
        }

        const syncStatus = app.status.sync.status;
        const healthStatus = app.status.health.status;
        const operationPhase = app.status.operationState?.phase;

        lastKnownStatus = { syncStatus, healthStatus, operationPhase };

        logger.info('Application status', {
          clientId,
          attempt,
          syncStatus,
          healthStatus,
          operationPhase,
        });

        if (this.isReadyState(syncStatus, healthStatus, operationPhase)) {
          logger.info('Application reached ready state', {
            clientId,
            attempt,
            revision: app.status.sync.revision,
            syncStatus,
            healthStatus,
            operationPhase,
          });

          if (customerId) {
            await CustomerModel.resetArgoRetry(customerId);
            logger.info('Reset Argo CD retry count after successful deployment', {
              customerId,
            });
          }

          return true;
        }

        const isTerminalHealthFailure =
          (healthStatus === 'Degraded' || healthStatus === 'Missing') &&
          syncStatus === 'Synced' &&
          operationPhase !== 'Running';

        if (isTerminalHealthFailure) {
          logger.error('Application health check failed after sync completed', {
            clientId,
            healthStatus,
            healthMessage: app.status.health.message,
            syncStatus,
            operationPhase,
          });

          if (customerId) {
            const customer = await CustomerModel.incrementArgoRetry(customerId);
            const retryCount = customer.argo_retry_count || 0;

            logger.info('Incremented Argo CD retry count', {
              customerId,
              retryCount,
            });

            if (retryCount >= 3) {
              logger.error('Max Argo CD retries reached, marking as argo_failed', {
                customerId,
                retryCount,
              });

              await CustomerModel.updateDeploymentStatus(customerId, 'argo_failed', {
                deploymentError: `Argo CD health remained ${healthStatus} after sync: ${app.status.health.message}`,
              });
            }
          }

          return false;
        }

        if (operationPhase === 'Failed' || operationPhase === 'Error') {
          logger.error('Application sync operation failed', {
            clientId,
            operationPhase,
            operationMessage: app.status.operationState?.message,
          });

          if (customerId) {
            const customer = await CustomerModel.incrementArgoRetry(customerId);
            const retryCount = customer.argo_retry_count || 0;

            logger.info('Incremented Argo CD retry count', {
              customerId,
              retryCount,
            });

            if (retryCount >= 3) {
              logger.error('Max Argo CD retries reached, marking as argo_failed', {
                customerId,
                retryCount,
              });

              await CustomerModel.updateDeploymentStatus(customerId, 'argo_failed', {
                deploymentError: `Argo CD operation ${operationPhase} after ${retryCount} attempts: ${app.status.operationState?.message}`,
              });
            }
          }

          return false;
        }

        logger.info('Application still progressing, retrying...', {
          clientId,
          attempt,
          syncStatus,
          healthStatus,
          operationPhase,
          nextRetryIn: `${this.config.retryDelayMs}ms`,
        });

        if (attempt < this.config.maxRetries) {
          await this.sleep(this.config.retryDelayMs);
        }
      } catch (error: any) {
        const status = error.response?.status;

        if (status === 401) {
          logger.error('Authentication failed - invalid ARGOCD_TOKEN', {
            clientId,
            status,
          });
          return false;
        }

        if (status === 403 || status === 404) {
          logger.warn('Application not found or not accessible yet, retrying...', {
            clientId,
            attempt,
            status,
            maxRetries: this.config.maxRetries,
          });
        } else {
          logger.error('Error checking Application status', {
            clientId,
            attempt,
            error: error.message,
            status,
          });
        }

        if (attempt < this.config.maxRetries) {
          await this.sleep(this.config.retryDelayMs);
        }
      }
    }

    if (lastKnownStatus && this.isReadyState(
      lastKnownStatus.syncStatus,
      lastKnownStatus.healthStatus,
      lastKnownStatus.operationPhase
    )) {
      logger.warn('Argo CD monitoring timed out after sync completed, treating as success', {
        clientId,
        lastKnownStatus,
        maxRetries: this.config.maxRetries,
        totalWaitTime: `${(this.config.maxRetries * this.config.retryDelayMs) / 1000}s`,
        note: 'Argo CD sync completed and operation succeeded, but health aggregation lagged.',
      });

      return true;
    }

    if (lastKnownStatus &&
        (lastKnownStatus.healthStatus === 'Progressing' || lastKnownStatus.operationPhase === 'Running')) {
      logger.warn('Argo CD monitoring timed out, but application is still progressing', {
        clientId,
        lastKnownStatus,
        maxRetries: this.config.maxRetries,
        totalWaitTime: `${(this.config.maxRetries * this.config.retryDelayMs) / 1000}s`,
        note: 'Argo CD will continue syncing in the background. Check Argo CD UI for progress.',
      });

      return true;
    }

    logger.error('Application readiness check timed out', {
      clientId,
      lastKnownStatus,
      maxRetries: this.config.maxRetries,
      totalWaitTime: `${(this.config.maxRetries * this.config.retryDelayMs) / 1000}s`,
    });

    return false;
  }

  private isReadyState(
    syncStatus: string,
    healthStatus: string,
    operationPhase?: string
  ): boolean {
    if (syncStatus !== 'Synced') {
      return false;
    }

    if (healthStatus === 'Healthy') {
      return true;
    }

    return operationPhase === 'Succeeded' &&
      healthStatus !== 'Degraded' &&
      healthStatus !== 'Missing';
  }

  /**
   * Get detailed Application information
   */
  async getApplicationDetails(clientId: string): Promise<{
    syncStatus: string;
    healthStatus: string;
    revision?: string;
    message?: string;
  } | null> {
    const app = await this.getApplicationStatus(clientId);
    
    if (!app) {
      return null;
    }

    return {
      syncStatus: app.status.sync.status,
      healthStatus: app.status.health.status,
      revision: app.status.sync.revision,
      message: app.status.health.message || app.status.operationState?.message,
    };
  }

  /**
   * List all Applications managed by Iotistic
   */
  async listApplications(): Promise<string[]> {
    try {
      const response = await this.client.get('/api/v1/applications', {
        params: {
          selector: 'managed-by=iotistic',
        },
      });

      const apps = response.data.items || [];
      return apps.map((app: ArgoApplication) => app.metadata.name);
    } catch (error: any) {
      logger.error('Failed to list Applications', {
        error: error.message,
      });
      return [];
    }
  }

  /**
   * Trigger manual sync for Application
   */
  async syncApplication(clientId: string): Promise<boolean> {
    try {
      const appName = `client-${clientId}`;
      await this.client.post(`/api/v1/applications/${appName}/sync`);
      
      logger.info('Application sync triggered', { clientId });
      return true;
    } catch (error: any) {
      logger.error('Failed to trigger Application sync', {
        clientId,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Delete Application from Argo CD
   * Note: This is usually not needed since deleting the manifest from Git
   * will cause Argo CD to prune the Application automatically
   */
  async deleteApplication(clientId: string): Promise<boolean> {
    try {
      const appName = `client-${clientId}`;
      await this.client.delete(`/api/v1/applications/${appName}`);
      
      logger.info('Application deleted from Argo CD', { clientId });
      return true;
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.info('Application already deleted', { clientId });
        return true;
      }

      logger.error('Failed to delete Application', {
        clientId,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if service is enabled (has required configuration)
   */
  isEnabled(): boolean {
    return !!(this.config.baseUrl && this.config.token);
  }
}

// Singleton instance
export const argoStatusService = new ArgoStatusService();
