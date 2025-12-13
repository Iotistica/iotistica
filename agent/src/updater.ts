/**
 * Agent Updater
 * 
 * Handles remote agent updates via MQTT commands.
 * Supports both Docker and systemd deployments with scheduled updates.
 */

import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { AgentLogger } from './logging/agent-logger.js';
import { LogComponents } from './logging/types.js';
import { MqttManager } from './mqtt/manager.js';

const execAsync = promisify(exec);

export interface UpdateCommand {
  action: 'update';
  version: string;
  scheduled_time?: string;
  force?: boolean;
  timestamp?: number;
}

export interface UpdaterConfig {
  deviceUuid: string;
  currentVersion: string;
  logger: AgentLogger;
}

/**
 * Agent Updater
 * 
 * Subscribes to MQTT update commands and orchestrates agent self-updates.
 */
export class AgentUpdater {
  private deviceUuid: string;
  private currentVersion: string;
  private logger: AgentLogger;
  private updateTopic: string;
  private statusTopic: string;

  constructor(config: UpdaterConfig) {
    this.deviceUuid = config.deviceUuid;
    this.currentVersion = config.currentVersion;
    this.logger = config.logger;
    
    // Follow standard IoT topic pattern: iot/device/{uuid}/agent/{action}
    this.updateTopic = `iot/device/${this.deviceUuid}/agent/update`;
    this.statusTopic = `iot/device/${this.deviceUuid}/agent/status`;
  }

  /**
   * Initialize MQTT update listener
   */
  async initialize(): Promise<void> {
    const mqttManager = MqttManager.getInstance();
    
    if (!mqttManager.isConnected()) {
      this.logger.debugSync("MQTT not connected - skipping update listener", {
        component: LogComponents.agentUpdater,
        note: "Update listener will not be available"
      });
      return;
    }
    
    try {
      // Subscribe to update commands with message handler
      await mqttManager.subscribe(this.updateTopic, undefined, async (topic: string, message: Buffer) => {
        await this.handleUpdateCommand(message);
      });
      
      this.logger.debugSync("MQTT update listener initialized", {
        component: LogComponents.agentUpdater,
        updateTopic: this.updateTopic,
        statusTopic: this.statusTopic
      });
      
    } catch (error) {
      this.logger.errorSync(
        "Failed to initialize MQTT update listener",
        error instanceof Error ? error : new Error(String(error)),
        {
          component: LogComponents.agentUpdater
        }
      );
    }
  }

  /**
   * Handle incoming update command
   */
  private async handleUpdateCommand(message: Buffer): Promise<void> {
    try {
      const command: UpdateCommand = JSON.parse(message.toString());
      
      if (command.action !== 'update') {
        this.logger.warnSync("Unknown update command action", {
          component: LogComponents.agentUpdater,
          action: command.action
        });
        return;
      }

      const { version, scheduled_time, force } = command;
      
      this.logger.debugSync("Agent update command received", {
        component: LogComponents.agentUpdater,
        version,
        scheduled_time,
        force: !!force
      });

      // Report update command received
      await this.publishStatus({
        type: 'update_command_received',
        version,
        timestamp: Date.now()
      });

      // If scheduled, wait until that time
      if (scheduled_time) {
        const scheduledDate = new Date(scheduled_time);
        const delay = scheduledDate.getTime() - Date.now();
        
        if (delay > 0) {
          this.logger.debugSync("Update scheduled for later", {
            component: LogComponents.agentUpdater,
            scheduled_time,
            delay_ms: delay,
            delay_hours: Math.round(delay / 3600000)
          });
          
          await this.publishStatus({
            type: 'update_scheduled',
            version,
            scheduled_time,
            timestamp: Date.now()
          });
          
          setTimeout(() => this.performUpdate(version, force), delay);
          return;
        }
      }

      // Execute immediately
      await this.performUpdate(version, force);
      
    } catch (error) {
      this.logger.errorSync(
        "Failed to process update command",
        error instanceof Error ? error : new Error(String(error)),
        {
          component: LogComponents.agentUpdater,
          topic: this.updateTopic
        }
      );
    }
  }

  /**
   * Perform agent update
   */
  private async performUpdate(version: string, force: boolean = false): Promise<void> {
    // Detect deployment type
    const deploymentType = process.env.DEPLOYMENT_TYPE || 
      (existsSync('/.dockerenv') ? 'docker' : 'systemd');
    
    this.logger.infoSync("Starting agent self-update", {
      component: LogComponents.agentUpdater,
      currentVersion: this.currentVersion,
      targetVersion: version,
      deploymentType,
      force
    });

    // Report update started
    try {
      await this.publishStatus({
        type: 'update_started',
        current_version: this.currentVersion,
        target_version: version,
        deployment_type: deploymentType,
        timestamp: Date.now()
      });
    } catch (error) {
      this.logger.warnSync("Failed to publish update started status", {
        component: LogComponents.agentUpdater,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Determine update script path
    const updateScript = deploymentType === 'docker'
      ? '/app/bin/update-agent-docker.sh'
      : '/usr/local/bin/update-agent-systemd.sh';
    
    // Check if update script exists
    if (!existsSync(updateScript)) {
      this.logger.errorSync(
        "Update script not found",
        new Error(`Script not found: ${updateScript}`),
        {
          component: LogComponents.agentUpdater,
          updateScript,
          deploymentType
        }
      );
      
      await this.publishStatus({
        type: 'update_failed',
        reason: 'update_script_not_found',
        script_path: updateScript,
        timestamp: Date.now()
      });
      
      return;
    }

    this.logger.infoSync("Executing update script", {
      component: LogComponents.agentUpdater,
      script: updateScript,
      version,
      note: "Agent will restart shortly"
    });

    // Execute update script in background (agent will restart)
    // Pass version and force flag as arguments
    const forceFlag = force ? 'true' : 'false';
    const command = `${updateScript} ${version} ${forceFlag} > /tmp/agent-update.log 2>&1 &`;
    
    try {
      execAsync(command);
      
      this.logger.infoSync("Update script executed", {
        component: LogComponents.agentUpdater,
        note: "Agent will restart to complete update"
      });
      
    } catch (error) {
      this.logger.errorSync(
        "Failed to execute update script",
        error instanceof Error ? error : new Error(String(error)),
        {
          component: LogComponents.agentUpdater,
          script: updateScript
        }
      );
      
      await this.publishStatus({
        type: 'update_failed',
        reason: 'script_execution_failed',
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now()
      });
    }
  }

  /**
   * Publish status update to MQTT
   */
  private async publishStatus(payload: Record<string, any>): Promise<void> {
    const mqttManager = MqttManager.getInstance();
    
    if (!mqttManager.isConnected()) {
      return;
    }

    try {
      await mqttManager.publish(this.statusTopic, JSON.stringify(payload));
    } catch (error) {
      this.logger.warnSync("Failed to publish status update", {
        component: LogComponents.agentUpdater,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Cleanup - unsubscribe from MQTT topics
   */
  async cleanup(): Promise<void> {
    const mqttManager = MqttManager.getInstance();
    
    if (!mqttManager.isConnected()) {
      return;
    }

    try {
      await mqttManager.unsubscribe(this.updateTopic);
      this.logger.debugSync("Unsubscribed from update topic", {
        component: LogComponents.agentUpdater,
        topic: this.updateTopic
      });
    } catch (error) {
      this.logger.warnSync("Failed to unsubscribe from update topic", {
        component: LogComponents.agentUpdater,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
