/**
 * Jobs Feature
 * 
 * Unified job delivery system combining MQTT (primary) and HTTP polling (fallback).
 * Automatically handles failover between MQTT and HTTP based on connection status.
 * 
 * Architecture:
 * - Job Notifications:
 *   - Primary: MQTT push notifications (iot/device/{uuid}/jobs/notify-next, instant ~ms latency)
 *   - Fallback: HTTP polling (GET /api/v1/devices/:uuid/jobs/next, configurable interval, default 30s)
 *   - Automatic failover: Internal monitor switches delivery method based on MQTT connection
 * 
 * - Job Status Updates:
 *   - Primary: MQTT publish (iot/device/{uuid}/jobs/{jobId}/update, instant, QoS 1)
 *   - Fallback: HTTP PATCH (PATCH /api/v1/devices/:uuid/jobs/:jobId/status)
 *   - API responds with: iot/device/{uuid}/jobs/{jobId}/update/accepted
 * 
 * - Unified execution: Single JobEngine handles jobs from both delivery methods
 */

import { HttpClient, FetchHttpClient } from '../../lib/http-client.js';
import { BaseFeature, FeatureConfig } from '../base-feature.js';
import { AgentLogger } from '../../logging/agent-logger.js';
import { LogComponents } from '../../logging/types.js';
import { MqttManager } from '../../mqtt/manager.js';
import { agentTopic } from '../../mqtt/topics.js';
import { JobEngine } from './engine.js';
import { JobDocument, JobStatus, JobExecutionData } from './types.js';
import { normalizeApiEndpoint, getApiVersion } from '../../utils/api-utils.js';

export interface JobsConfig extends FeatureConfig {
  enabled: boolean;
  cloudApiUrl: string;
  deviceApiKey?: string;
  pollingIntervalMs?: number;
  maxRetries?: number;
  handlerDirectory?: string;
  maxConcurrentJobs?: number;
  defaultHandlerTimeout?: number;
}

interface CloudJob {
  job_id: string;
  job_name: string;
  job_document: JobDocument;
  timeout_seconds: number;
  created_at: string;
}

interface JobStatusUpdate {
  status: 'QUEUED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELED';
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  status_details?: {
    message?: string;
    progress?: number;
    error?: string;
    timestamp?: string;
    [key: string]: any;
  };
}

/**
 * Jobs Feature
 * 
 * Unified job delivery system managing both MQTT (primary) and HTTP (fallback).
 * Automatically switches between them based on MQTT connection status.
 */
export class JobsFeature extends BaseFeature {
  private jobEngine: JobEngine;
  private httpClient: HttpClient;
  private baseUrl: string = '';
  private deviceApiKey: string = '';
  private httpPollingInterval?: NodeJS.Timeout;
  private connectionMonitor?: NodeJS.Timeout;
  private lastMqttState: boolean = false;
  private httpPaused: boolean = false;
  private handlingJob: boolean = false;
  private needStop: boolean = false;
  private latestJobNotification: JobExecutionData | null = null;
  private mqttSubscribed: boolean = false;

  constructor(
    config: JobsConfig,
    agentLogger: AgentLogger,
    deviceUuid: string,
    httpClient?: HttpClient // Optional: shared HTTP client for connection pooling
  ) {
    super(
      config,
      agentLogger,
      LogComponents.jobs,
      deviceUuid,
      false, // We'll manage MQTT ourselves
      'JOBS_DEBUG',
      true  // requiresProvisioning: Jobs feature requires cloud API
    );

    // Create shared JobEngine - pass agentLogger instead of this.logger
    this.jobEngine = new JobEngine(agentLogger);

    // Create HTTP client for polling with normalized endpoint
    const jobConfig = this.config as JobsConfig;
    const apiVersion = getApiVersion();
    const normalizedBaseUrl = normalizeApiEndpoint(jobConfig.cloudApiUrl);
    
    // Store base URL and API key for building full URLs
    this.baseUrl = `${normalizedBaseUrl}/${apiVersion}`;
    this.deviceApiKey = jobConfig.deviceApiKey || '';
    
    // Use shared HTTP client if provided, otherwise create dedicated instance
    if (httpClient) {
      this.httpClient = httpClient;
    } else {
      // For localhost/development, disable TLS verification
      const isLocalhost = normalizedBaseUrl.includes('localhost') || normalizedBaseUrl.includes('127.0.0.1');
      
      // Also disable for any HTTPS endpoint (handle self-signed certs in production)
      const isHttps = normalizedBaseUrl.startsWith('https://');
      
      this.httpClient = new FetchHttpClient({
        defaultHeaders: {
          'Content-Type': 'application/json',
          'User-Agent': `Iotistic-agent/${deviceUuid}`,
        },
        defaultTimeout: 30000,
        rejectUnauthorized: !isLocalhost && !isHttps, // Accept self-signed certs for localhost and HTTPS
      });
    }
  }

  /**
   * Validate configuration
   */
  protected validateConfig(): void {
    const config = this.config as JobsConfig;
    
    if (!config.cloudApiUrl) {
      throw new Error('cloudApiUrl is required for Jobs feature');
    }

    this.logger.debug(`Jobs configuration validated`);
  }

  /**
   * Initialize - called before start
   */
  protected async onInitialize(): Promise<void> {
    const config = this.config as JobsConfig;
    
    this.logger.debug(`Initializing Jobs Feature - pollingIntervalMs: ${config.pollingIntervalMs || 30000}, handlerDirectory: ${config.handlerDirectory || '/app/data/job-handlers'}`);
  }

  /**
   * Start the unified jobs feature
   */
  protected async onStart(): Promise<void> {
    const config = this.config as JobsConfig;

    // 1. Start HTTP polling (always available as fallback)
    await this.startHttpPolling(config);

    // 2. Initialize MQTT subscriptions (if available)
    await this.initializeMqttSubscriptions();

    // 3. Start connection monitor for automatic fallback
    this.startConnectionMonitor();

    this.logger.debug(`Jobs Feature started - Mode: ${this.mqttSubscribed ? 'MQTT-primary with HTTP fallback' : 'HTTP-only'}`);
  }

  /**
   * Stop the jobs feature
   */
  protected async onStop(): Promise<void> {
    this.logger.debug(`Stopping Jobs Feature`);
    this.needStop = true;

    // Stop connection monitor
    if (this.connectionMonitor) {
      clearInterval(this.connectionMonitor);
      this.connectionMonitor = undefined;
    }

    // Stop HTTP polling
    if (this.httpPollingInterval) {
      clearInterval(this.httpPollingInterval);
      this.httpPollingInterval = undefined;
      this.logger.debug(`HTTP polling stopped`);
    }

    // Unsubscribe from MQTT topics
    if (this.mqttSubscribed) {
      await this.unsubscribeFromMqtt();
    }

    // Wait for current job to complete
    while (this.handlingJob) {
      await this.sleep(100);
    }

    this.logger.debug(`Jobs Feature stopped`);
  }

  /**
   * Start HTTP polling (always available as fallback)
   */
  private async startHttpPolling(config: JobsConfig): Promise<void> {
    const pollingIntervalMs = config.pollingIntervalMs || 30000;
    
    this.logger.debug(`Starting HTTP polling (interval: ${pollingIntervalMs}ms)`);

    // Initial poll
    await this.pollForJobs();

    // Set up recurring polls
    this.httpPollingInterval = setInterval(async () => {
      if (!this.httpPaused && !this.handlingJob && !this.needStop) {
        await this.pollForJobs();
      }
    }, pollingIntervalMs);

    this.logger.debug(`HTTP polling started`);
  }

  /**
   * Poll cloud API for pending jobs
   */
  private async pollForJobs(): Promise<void> {
    try {
      const url = `${this.baseUrl}/devices/${this.deviceUuid}/jobs/next`;
      const response = await this.httpClient.get<CloudJob | null>(url, {
        headers: {
          'X-Device-API-Key': this.deviceApiKey,
        },
      });

      if (response.ok && response.status === 200) {
        const cloudJob = await response.json();

        if (cloudJob) {
          // Validate job_id
          if (!cloudJob.job_id) {
            this.logger.error(`HTTP job response missing job_id`, {
              cloudJob
            });
            return;
          }
          
          this.logger.info(`Received job from HTTP polling: ${cloudJob.job_id}`);
        
        // Validate job document
        if (!cloudJob.job_document) {
          this.logger.error(`HTTP job response missing job_document for job ${cloudJob.job_id}`, {
            jobId: cloudJob.job_id,
            cloudJob
          });
          return;
        }

        // Parse job_document if it's a string
        let jobDocument = cloudJob.job_document;
        if (typeof jobDocument === 'string') {
          try {
            jobDocument = JSON.parse(jobDocument);
            this.logger.debug(`Parsed job_document from string`, { jobId: cloudJob.job_id });
          } catch (error) {
            this.logger.error(`Failed to parse job_document JSON`, {
              jobId: cloudJob.job_id,
              error: error instanceof Error ? error.message : String(error),
              jobDocument: jobDocument
            });
            return;
          }
        }
        
        // Convert to JobExecutionData format
        const jobData: JobExecutionData = {
          jobId: cloudJob.job_id,
          deviceUuid: this.deviceUuid,
          jobDocument: jobDocument,
          status: 'QUEUED' as any,
          versionNumber: 1,
          executionNumber: 1
        };

        await this.executeJob(jobData);
        }
      }
    } catch (error: any) {
      // 404 is expected when no jobs available (via HttpError or response check)
      const is404 = (error.status === 404) || (error.response?.status === 404);
      
      if (!is404) {
        // Serialize error properly - handle nested cause objects
        let errorMessage = error.message;
        if (!errorMessage && error.cause) {
          errorMessage = error.cause.message || (typeof error.cause === 'object' ? JSON.stringify(error.cause) : String(error.cause));
        }
        if (!errorMessage) {
          errorMessage = String(error);
        }
        
        const errorDetails: Record<string, any> = {
          errorType: error.name || 'Unknown',
          url: `${this.baseUrl}/devices/${this.deviceUuid}/jobs/next`
        };
        
        // Add relevant error properties
        if (error.code) errorDetails.code = error.code;
        if (error.status) errorDetails.status = error.status;
        if (error.cause) {
          if (typeof error.cause === 'object') {
            errorDetails.cause = error.cause.message || error.cause.code || JSON.stringify(error.cause);
            if (error.cause.code) errorDetails.causeCode = error.cause.code;
          } else {
            errorDetails.cause = String(error.cause);
          }
        }
        
        this.logger.error(`HTTP polling error: ${errorMessage}`, errorDetails);
      }
    }
  }

  /**
   * Initialize MQTT subscriptions (optional, primary method)
   */
  private async initializeMqttSubscriptions(): Promise<void> {
    try {
      const mqttManager = MqttManager.getInstance();
      if (!mqttManager.isConnected()) {
        this.logger.warn(`MQTT not connected, using HTTP-only mode`);
        return;
      }

      this.logger.debug(`Initializing MQTT job notifications (primary)`);

      // Subscribe to job notification topic
      const notifyTopic = agentTopic(this.deviceUuid, 'jobs', 'notify-next');
      
      await mqttManager.subscribe(notifyTopic, { qos: 1 }, async (topic: string, payload: Buffer) => {
        try {
          const message = JSON.parse(payload.toString());
          await this.handleMqttJobNotification(message);
        } catch (error) {
          this.logger.error(`Failed to parse MQTT job notification: ${error}`);
        }
      });

      this.mqttSubscribed = true;
      this.logger.debug(`MQTT job notifications initialized`);

    } catch (error) {
      this.logger.warn(`Failed to initialize MQTT subscriptions (will use HTTP fallback): ${error}`);
      this.mqttSubscribed = false;
    }
  }

  /**
   * Handle MQTT job notification
   */
  private async handleMqttJobNotification(message: any): Promise<void> {
    this.logger.debug(`Received MQTT job notification`);
    
    if (!message.execution) {
      this.logger.debug(`No pending jobs available`);
      return;
    }

    // Validate critical fields
    if (!message.execution.jobId) {
      this.logger.error(`MQTT job notification missing jobId`, { message });
      return;
    }

    if (!message.execution.jobDocument) {
      this.logger.error(`MQTT job notification missing jobDocument for job ${message.execution.jobId}`, { 
        jobId: message.execution.jobId,
        executionData: message.execution 
      });
      return;
    }

    // Parse job_document if it's a string
    let jobDocument = message.execution.jobDocument;
    if (typeof jobDocument === 'string') {
      try {
        jobDocument = JSON.parse(jobDocument);
        this.logger.debug(`Parsed jobDocument from string`, { jobId: message.execution.jobId });
      } catch (error) {
        this.logger.error(`Failed to parse jobDocument JSON`, {
          jobId: message.execution.jobId,
          error: error instanceof Error ? error.message : String(error),
          jobDocument: jobDocument
        });
        return;
      }
    }

    const jobData: JobExecutionData = {
      jobId: message.execution.jobId,
      deviceUuid: message.execution.deviceUuid || message.execution.thingName || this.deviceUuid,
      jobDocument: jobDocument,
      status: message.execution.status || 'QUEUED',
      queuedAt: message.execution.queuedAt ? new Date(message.execution.queuedAt) : undefined,
      startedAt: message.execution.startedAt ? new Date(message.execution.startedAt) : undefined,
      lastUpdatedAt: message.execution.lastUpdatedAt ? new Date(message.execution.lastUpdatedAt) : undefined,
      versionNumber: message.execution.versionNumber || 1,
      executionNumber: message.execution.executionNumber || 1,
      statusDetails: message.execution.statusDetails
    };

    if (this.isDuplicateNotification(jobData)) {
      this.logger.debug(`Ignoring duplicate job notification for job ${jobData.jobId}`);
      return;
    }

    await this.executeJob(jobData);
  }

  /**
   * Unsubscribe from MQTT topics
   */
  private async unsubscribeFromMqtt(): Promise<void> {
    try {
      const mqttManager = MqttManager.getInstance();
      const notifyTopic = agentTopic(this.deviceUuid, 'jobs', 'notify-next');
      await mqttManager.unsubscribe(notifyTopic);
      this.mqttSubscribed = false;
      this.logger.info(`Unsubscribed from MQTT job notifications`);
    } catch (error) {
      this.logger.warn(`Failed to unsubscribe from MQTT: ${error}`);
    }
  }

  /**
   * Execute a job
   */
  private async executeJob(jobData: JobExecutionData): Promise<void> {
    if (this.needStop) {
      this.logger.info(`Ignoring job ${jobData.jobId} due to shutdown request`);
      return;
    }

    if (this.handlingJob) {
      this.logger.warn(`Already handling a job, ignoring job ${jobData.jobId}`);
      return;
    }

    this.handlingJob = true;
    this.latestJobNotification = jobData;

    try {
      this.logger.info(`Starting execution of job ${jobData.jobId}`);

      // Validate job document
      if (!jobData.jobDocument) {
        this.logger.error('Job document is missing from job data', {
          jobId: jobData.jobId,
          jobDataKeys: Object.keys(jobData),
          jobData: JSON.stringify(jobData)
        });
        throw new Error('Job document is missing from job data');
      }

      this.logger.debug('Job document received', {
        jobId: jobData.jobId,
        jobDocumentType: typeof jobData.jobDocument,
        hasSteps: 'steps' in jobData.jobDocument,
        stepsType: typeof jobData.jobDocument.steps,
        jobDocumentKeys: Object.keys(jobData.jobDocument),
        jobDocument: JSON.stringify(jobData.jobDocument)
      });

      if (!jobData.jobDocument.steps || !Array.isArray(jobData.jobDocument.steps)) {
        this.logger.error('Job document missing required "steps" array', {
          jobId: jobData.jobId,
          jobDocument: JSON.stringify(jobData.jobDocument),
          stepsValue: jobData.jobDocument.steps,
          stepsType: typeof jobData.jobDocument.steps
        });
        throw new Error('Job document missing required "steps" array');
      }

      // Update job status to IN_PROGRESS
      await this.updateJobStatus(jobData.jobId, {
        status: 'IN_PROGRESS',
        status_details: {
          message: 'Job execution started',
          timestamp: new Date().toISOString()
        }
      });

      // Execute the job
      const config = this.config as JobsConfig;
      const result = await this.jobEngine.executeSteps(
        jobData.jobDocument,
        config.handlerDirectory || '/app/data/job-handlers'
      );

      // Update final job status
      const finalStatus = result.success ? 'SUCCEEDED' : 'FAILED';
      await this.updateJobStatus(jobData.jobId, {
        status: finalStatus,
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        status_details: {
          message: result.reason || (result.success ? 'Job completed successfully' : 'Job failed'),
          timestamp: new Date().toISOString()
        }
      });

      this.logger.info(`Job ${jobData.jobId} completed with status: ${finalStatus}`);

    } catch (error) {
      const errorMessage = `Job execution failed: ${error instanceof Error ? error.message : String(error)}`;
      this.logger.error(errorMessage);

      try {
        await this.updateJobStatus(jobData.jobId, {
          status: 'FAILED',
          stderr: errorMessage,
          status_details: {
            error: errorMessage,
            timestamp: new Date().toISOString()
          }
        });
      } catch (updateError) {
        this.logger.error(`Failed to update job status after error: ${updateError}`);
      }
    } finally {
      this.handlingJob = false;
    }
  }

  /**
   * Update job status (MQTT primary, HTTP fallback)
   */
  private async updateJobStatus(jobId: string, update: JobStatusUpdate): Promise<void> {
    const mqttManager = MqttManager.getInstance();
    let mqttSuccess = false;

    // Check MQTT health FIRST - skip if disconnected to avoid wasted attempts
		const mqttHealthy = mqttManager?.isConnected() ?? false;

    // Try MQTT first (primary method)
    if (mqttHealthy) {
      try {
        const updateTopic = agentTopic(this.deviceUuid, 'jobs', jobId, 'update');
        
        this.logger.debug(`Updating job status via MQTT: ${updateTopic}`, { status: update.status });
        
        await mqttManager.publishNoQueue(updateTopic, JSON.stringify(update), { qos: 1 });
        
        mqttSuccess = true;
        this.logger.debug(`Updated job ${jobId} status to ${update.status} via MQTT`);
        return; // Success, exit early
      } catch (error: any) {
        this.logger.warn(`MQTT status update failed, falling back to HTTP: ${error.message}`);
      }
    } else {
      this.logger.debug(`MQTT not connected, using HTTP for status update`);
    }

    // Fallback to HTTP if MQTT failed or not available
    const url = `${this.baseUrl}/devices/${this.deviceUuid}/jobs/${jobId}/status`;
    try {
      this.logger.debug(`Updating job status via HTTP: PATCH ${url}`, { status: update.status });
      
      await this.httpClient.patch(url, update, {
        headers: {
          'X-Device-API-Key': this.deviceApiKey,
        },
      });
      
      this.logger.debug(`Updated job ${jobId} status to ${update.status} via HTTP`);
    } catch (error: any) {
      this.logger.error(`Failed to update job status (MQTT: ${mqttSuccess ? 'succeeded' : 'failed'}, HTTP: failed): ${error.message}`, {
        url,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data
      });
      throw error;
    }
  }

  /**
   * Check if this is a duplicate job notification
   */
  private isDuplicateNotification(jobData: JobExecutionData): boolean {
    if (!this.latestJobNotification) {
      return false;
    }

    return this.latestJobNotification.jobId === jobData.jobId &&
           this.latestJobNotification.versionNumber === jobData.versionNumber &&
           this.latestJobNotification.executionNumber === jobData.executionNumber;
  }

  /**
   * Monitor MQTT connection and coordinate HTTP pause/resume
   */
  private startConnectionMonitor(): void {
    const mqttManager = MqttManager.getInstance();
    this.lastMqttState = mqttManager.isConnected();

    // Initially pause HTTP if MQTT is connected
    if (this.lastMqttState && this.mqttSubscribed) {
      this.httpPaused = true;
      this.logger.info(`MQTT connected - HTTP polling paused (MQTT-primary mode)`);
    }

    // Monitor MQTT connection every 5 seconds
    this.connectionMonitor = setInterval(() => {
      const currentMqttState = mqttManager.isConnected();

      // MQTT state changed
      if (currentMqttState !== this.lastMqttState) {
        if (currentMqttState && this.mqttSubscribed) {
          // MQTT reconnected - pause HTTP polling
          this.httpPaused = true;
          this.logger.debug(`MQTT reconnected - switching to MQTT-primary mode`);
        } else {
          // MQTT disconnected - resume HTTP polling
          this.httpPaused = false;
          this.logger.warn(`MQTT disconnected - falling back to HTTP polling`);
        }

        this.lastMqttState = currentMqttState;
      }
    }, 5000); // Check every 5 seconds

    this.logger.debug(`Connection monitor started - Initial mode: ${this.lastMqttState && this.mqttSubscribed ? 'MQTT-primary' : 'HTTP-fallback'}`);
  }

  /**
   * Utility method for async sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get the shared JobEngine instance
   */
  public getJobEngine(): JobEngine {
    return this.jobEngine;
  }

  /**
   * Check if MQTT jobs are active
   */
  public isMqttActive(): boolean {
    return this.mqttSubscribed && MqttManager.getInstance().isConnected();
  }

  /**
   * Check if HTTP jobs are active
   */
  public isHttpActive(): boolean {
    return !this.httpPaused;
  }

  /**
   * Get current delivery mode
   */
  public getCurrentMode(): 'mqtt' | 'http' {
    return this.isMqttActive() ? 'mqtt' : 'http';
  }
}
