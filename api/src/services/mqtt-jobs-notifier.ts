/**
 * MQTT Jobs Notifier Service
 * 
 * Publishes job notifications to MQTT topics when jobs are created/updated.
 * Implements AWS IoT Jobs-style MQTT notifications for real-time job delivery.
 */

import mqtt from 'mqtt';
import logger from '../utils/logger';

export interface MqttJobNotification {
  execution: {
    jobId: string;
    jobDocument: any;
    queuedAt: number;
    lastUpdatedAt: number;
    versionNumber: number;
    executionNumber: number;
    status: string;
    statusDetails?: any;
  };
  timestamp: number;
}

export class MqttJobsNotifier {
  private mqttClient: mqtt.MqttClient | null = null;
  private isConnected = false;
  private updateHandlers: Map<string, (update: any) => void> = new Map();

  constructor(
    private brokerUrl: string = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
    private username?: string,
    private password?: string
  ) {}

  /**
   * Connect to MQTT broker
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
       logger.info(' Connecting to MQTT broker:', this.brokerUrl);

      const options: any = {
        username: this.username,
        password: this.password,
        clientId: `api-jobs-notifier-${Date.now()}`,
        clean: true,
        reconnectPeriod: 5000,
      };

      // Add TLS options for mqtts:// connections
      if (this.brokerUrl.startsWith('mqtts://')) {
        options.rejectUnauthorized = process.env.MQTT_TLS_REJECT_UNAUTHORIZED !== 'false';
        logger.info('MQTT Jobs Notifier TLS config', { rejectUnauthorized: options.rejectUnauthorized });
      }

      this.mqttClient = mqtt.connect(this.brokerUrl, options);

      this.mqttClient.on('connect', () => {
         logger.info(' Connected to MQTT broker');
        this.isConnected = true;
        
        // Subscribe to job update topics for all devices
        this.subscribeToJobUpdates();
        
        resolve();
      });

      this.mqttClient.on('error', (error) => {
         logger.error(' MQTT connection error:', error);
        this.isConnected = false;
        reject(error);
      });

      this.mqttClient.on('close', () => {
         logger.info(' MQTT connection closed');
        this.isConnected = false;
      });
    });
  }

  /**
   * Disconnect from MQTT broker
   */
  async disconnect(): Promise<void> {
    if (this.mqttClient) {
      return new Promise((resolve) => {
        this.mqttClient!.end(false, {}, () => {
           logger.info(' Disconnected from MQTT broker');
          resolve();
        });
      });
    }
  }

  /**
   * Subscribe to job update topics
   * Listens to: iot/device/+/jobs/+/update
   */
  private subscribeToJobUpdates(): void {
    if (!this.mqttClient) {
      return;
    }

    // Subscribe to all device job updates (wildcard topic)
    const updateTopic = 'iot/device/+/jobs/+/update';
    
    this.mqttClient.subscribe(updateTopic, { qos: 1 }, (error) => {
      if (error) {
         logger.error(` Failed to subscribe to ${updateTopic}:`, error);
      } else {
         logger.info(` Subscribed to job updates: ${updateTopic}`);
      }
    });

    // Also subscribe to start-next requests
    const startNextTopic = 'iot/device/+/jobs/start-next';
    
    this.mqttClient.subscribe(startNextTopic, { qos: 1 }, (error) => {
      if (error) {
         logger.error(` Failed to subscribe to ${startNextTopic}:`, error);
      } else {
         logger.info(` Subscribed to start-next requests: ${startNextTopic}`);
      }
    });

    // Handle incoming messages
    this.mqttClient.on('message', (topic: string, payload: Buffer) => {
      try {
        const message = JSON.parse(payload.toString());
        
        // Handle job update messages
        if (topic.includes('/jobs/') && topic.endsWith('/update')) {
          this.handleJobUpdate(topic, message);
        }
        
        // Handle start-next requests
        if (topic.endsWith('/jobs/start-next')) {
          this.handleStartNextRequest(topic, message);
        }
      } catch (error) {
         logger.error(` Failed to parse message on ${topic}:`, error);
      }
    });
  }

  /**
   * Handle job status update from device
   */
  private handleJobUpdate(topic: string, message: any): void {
    // Parse topic: iot/device/{deviceUuid}/jobs/{jobId}/update
    const parts = topic.split('/');
    const deviceUuid = parts[2];
    const jobId = parts[4];

     logger.info(` Received job update for ${jobId} from device ${deviceUuid}:`, {
      status: message.status,
      hasStdout: !!message.statusDetails?.stdout,
      hasStderr: !!message.statusDetails?.stderr,
      topicParts: parts,
      parsedDeviceUuid: deviceUuid,
      parsedJobId: jobId,
    });

    // Trigger registered handlers
    const handlerKey = `${deviceUuid}:${jobId}`;
    const handler = this.updateHandlers.get(handlerKey);
    
    if (handler) {
      handler(message);
    }

    // Also trigger wildcard handler
    const wildcardHandler = this.updateHandlers.get('*');
    if (wildcardHandler) {
      const updatePayload = { deviceUuid, jobId, ...message };
       logger.info(` Calling wildcard handler with:`, {
        deviceUuid,
        jobId,
        jobIdType: typeof jobId,
        updateKeys: Object.keys(updatePayload),
      });
      wildcardHandler(updatePayload);
    }

    // Respond with update/accepted
    this.publishUpdateAccepted(deviceUuid, jobId, message.status);
  }

  /**
   * Handle start-next request from device
   */
  private handleStartNextRequest(topic: string, message: any): void {
    // Parse topic: iot/device/{deviceUuid}/jobs/start-next
    const parts = topic.split('/');
    const deviceUuid = parts[2];

     logger.info(` Received start-next request from device ${deviceUuid}`);

    // Trigger handler if registered
    const handler = this.updateHandlers.get(`start-next:${deviceUuid}`);
    if (handler) {
      handler({ deviceUuid, clientToken: message.clientToken });
    }
  }

  /**
   * Register a handler for job updates
   * @param deviceUuid - Specific device UUID or '*' for all devices
   * @param jobId - Specific job ID (optional, only needed if not using wildcard)
   * @param handler - Callback function to handle updates
   */
  onJobUpdate(deviceUuid: string, handler: (update: any) => void): void;
  onJobUpdate(deviceUuid: string, jobId: string, handler: (update: any) => void): void;
  onJobUpdate(deviceUuid: string, jobIdOrHandler: string | ((update: any) => void), handler?: (update: any) => void): void {
    if (typeof jobIdOrHandler === 'function') {
      // Wildcard handler for all jobs from this device
      this.updateHandlers.set(deviceUuid, jobIdOrHandler);
    } else if (handler) {
      // Specific job handler
      const handlerKey = `${deviceUuid}:${jobIdOrHandler}`;
      this.updateHandlers.set(handlerKey, handler);
    }
  }

  /**
   * Register handler for start-next requests
   */
  onStartNextRequest(deviceUuid: string, handler: (request: any) => void): void {
    this.updateHandlers.set(`start-next:${deviceUuid}`, handler);
  }

  /**
   * Remove handler
   */
  removeHandler(deviceUuid: string, jobId?: string): void {
    if (jobId) {
      this.updateHandlers.delete(`${deviceUuid}:${jobId}`);
    } else {
      this.updateHandlers.delete(deviceUuid);
    }
  }

  /**
   * Notify device about next pending job
   * Publishes to: iot/device/{deviceUuid}/jobs/notify-next
   */
  async notifyNextJob(deviceUuid: string, job: {
    job_id: string;
    job_name: string;
    job_document: any;
    queued_at: Date;
    timeout_seconds?: number;
  }): Promise<void> {
    if (!this.isConnected || !this.mqttClient) {
       logger.warn(' Not connected to MQTT, skipping notification');
      return;
    }

    const topic = `iot/device/${deviceUuid}/jobs/notify-next`;
    
    const notification: MqttJobNotification = {
      execution: {
        jobId: job.job_id,
        jobDocument: job.job_document,
        queuedAt: new Date(job.queued_at).getTime(),
        lastUpdatedAt: Date.now(),
        versionNumber: 1,
        executionNumber: 1,
        status: 'QUEUED',
      },
      timestamp: Date.now(),
    };

    return new Promise((resolve, reject) => {
      this.mqttClient!.publish(
        topic,
        JSON.stringify(notification),
        { qos: 1, retain: false },
        (error) => {
          if (error) {
             logger.error(` Failed to publish to ${topic}:`, error);
            reject(error);
          } else {
             logger.info(` Published job notification to ${topic}:`, job.job_id);
            resolve();
          }
        }
      );
    });
  }

  /**
   * Respond to start-next request
   * Publishes to: iot/device/{deviceUuid}/jobs/start-next/accepted
   */
  async publishStartNextAccepted(deviceUuid: string, job: {
    job_id: string;
    job_name: string;
    job_document: any;
    queued_at: Date;
  } | null): Promise<void> {
    if (!this.isConnected || !this.mqttClient) {
      return;
    }

    const topic = `iot/device/${deviceUuid}/jobs/start-next/accepted`;
    
    const payload = job ? {
      execution: {
        jobId: job.job_id,
        jobDocument: job.job_document,
        queuedAt: new Date(job.queued_at).getTime(),
        lastUpdatedAt: Date.now(),
        versionNumber: 1,
        executionNumber: 1,
        status: 'IN_PROGRESS',
      },
      timestamp: Date.now(),
    } : {
      timestamp: Date.now(),
      clientToken: null,
    };

    return new Promise((resolve, reject) => {
      this.mqttClient!.publish(
        topic,
        JSON.stringify(payload),
        { qos: 1, retain: false },
        (error) => {
          if (error) {
             logger.error(` Failed to publish to ${topic}:`, error);
            reject(error);
          } else {
             logger.info(` Published start-next response to ${topic}`);
            resolve();
          }
        }
      );
    });
  }

  /**
   * Respond to job update
   * Publishes to: iot/device/{deviceUuid}/jobs/{jobId}/update/accepted
   */
  async publishUpdateAccepted(deviceUuid: string, jobId: string, status: string): Promise<void> {
    if (!this.isConnected || !this.mqttClient) {
      return;
    }

    const topic = `iot/device/${deviceUuid}/jobs/${jobId}/update/accepted`;
    
    const payload = {
      executionState: {
        status,
        statusDetails: {},
        versionNumber: 1,
      },
      timestamp: Date.now(),
    };

    return new Promise((resolve, reject) => {
      this.mqttClient!.publish(
        topic,
        JSON.stringify(payload),
        { qos: 1, retain: false },
        (error) => {
          if (error) {
             logger.error(` Failed to publish to ${topic}:`, error);
            reject(error);
          } else {
             logger.info(` Published update response to ${topic}`);
            resolve();
          }
        }
      );
    });
  }

  /**
   * Check if connected to MQTT broker
   */
  get connected(): boolean {
    return this.isConnected;
  }
}

// Singleton instance
let instance: MqttJobsNotifier | null = null;

export function getMqttJobsNotifier(): MqttJobsNotifier {
  if (!instance) {
    const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
    const username = process.env.MQTT_USERNAME;
    const password = process.env.MQTT_PASSWORD;
    
    instance = new MqttJobsNotifier(brokerUrl, username, password);
    
    // Auto-connect
    instance.connect().catch((error) => {
       logger.error(' Failed to connect:', error);
    });
  }
  
  return instance;
}
