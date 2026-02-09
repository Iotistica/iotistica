import * as pty from 'node-pty';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { MqttManager } from '../mqtt/manager';
import * as os from 'os';

/**
 * Shell Handler - Spawns PTY process and manages bidirectional I/O
 * 
 * MQTT Topics:
 * - Subscribe: iot/device/{uuid}/agent/shell (commands from cloud)
 * - Publish: iot/device/{uuid}/agent/shell-output (output to cloud)
 */
export class ShellHandler {
  private deviceUuid: string;
  private logger: AgentLogger;
  private mqtt: MqttManager;
  private ptyProcess: pty.IPty | null = null;
  private commandTopic: string;
  private outputTopic: string;
  private sessionActive = false;

  constructor(deviceUuid: string, mqtt: MqttManager, logger: AgentLogger) {
    this.deviceUuid = deviceUuid;
    this.mqtt = mqtt;
    this.logger = logger;
    this.commandTopic = `iot/device/${deviceUuid}/agent/shell`;
    this.outputTopic = `iot/device/${deviceUuid}/agent/shell-output`;
  }

  /**
   * Initialize shell handler - subscribe to shell commands
   */
  async initialize(): Promise<void> {
    this.logger.infoSync('Shell handler initializing', {
      component: LogComponents.agent,
      commandTopic: this.commandTopic,
      outputTopic: this.outputTopic,
    });

    // Subscribe to shell command topic
    await this.mqtt.subscribe(
      this.commandTopic,
      { qos: 1 },
      (topic, payload) => this.handleCommand(payload)
    );

    this.logger.infoSync('Shell handler initialized', {
      component: LogComponents.agent,
    });
  }

  /**
   * Handle incoming shell command
   */
  private async handleCommand(payload: Buffer): Promise<void> {
    try {
      const message = JSON.parse(payload.toString());
      
      this.logger.debugSync('Received shell command', {
        component: LogComponents.agent,
        action: message.action,
        sessionActive: this.sessionActive,
      });

      switch (message.action) {
        case 'start':
          await this.startSession();
          break;
        case 'stop':
          this.stopSession();
          break;
        case 'input':
          if (message.data && this.ptyProcess) {
            this.ptyProcess.write(message.data);
          }
          break;
        case 'resize':
          if (message.cols && message.rows && this.ptyProcess) {
            this.ptyProcess.resize(message.cols, message.rows);
          }
          break;
        default:
          this.logger.warnSync('Unknown shell action', {
            component: LogComponents.agent,
            action: message.action,
          });
      }
    } catch (error) {
      this.logger.errorSync('Error handling shell command', error as Error, {
        component: LogComponents.agent,
      });
    }
  }

  /**
   * Start a new shell session
   */
  private async startSession(): Promise<void> {
    if (this.sessionActive) {
      this.logger.warnSync('Shell session already active', {
        component: LogComponents.agent,
      });
      return;
    }

    try {
      // Determine shell and platform
      const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
      const cwd = os.homedir();

      this.logger.infoSync('Starting PTY process', {
        component: LogComponents.agent,
        shell,
        cwd,
        platform: os.platform(),
      });

      // Spawn PTY process
      this.ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: process.env as { [key: string]: string },
      });

      this.sessionActive = true;

      // Handle PTY output
      this.ptyProcess.onData((data: string) => {
        this.sendOutput(data);
      });

      // Handle PTY exit
      this.ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        this.logger.infoSync('PTY process exited', {
          component: LogComponents.agent,
          exitCode,
          signal,
        });
        this.stopSession();
      });

      // Send welcome message
      await this.sendOutput('\r\n\x1b[32m✓ Shell session started\x1b[0m\r\n');
      
      this.logger.infoSync('Shell session started', {
        component: LogComponents.agent,
      });
    } catch (error) {
      this.logger.errorSync('Failed to start shell session', error as Error, {
        component: LogComponents.agent,
      });
      this.sessionActive = false;
      await this.sendOutput(`\r\n\x1b[31m✗ Failed to start shell: ${(error as Error).message}\x1b[0m\r\n`);
    }
  }

  /**
   * Stop the shell session
   */
  private stopSession(): void {
    if (!this.sessionActive) {
      return;
    }

    this.logger.infoSync('Stopping shell session', {
      component: LogComponents.agent,
    });

    if (this.ptyProcess) {
      try {
        this.ptyProcess.kill();
      } catch (error) {
        this.logger.errorSync('Error killing PTY process', error as Error, {
          component: LogComponents.agent,
        });
      }
      this.ptyProcess = null;
    }

    this.sessionActive = false;

    this.logger.infoSync('Shell session stopped', {
      component: LogComponents.agent,
    });
  }

  /**
   * Send shell output to cloud via MQTT
   */
  private async sendOutput(data: string): Promise<void> {
    try {
      await this.mqtt.publish(
        this.outputTopic,
        {
          format: 'json',
          data: {
            output: data,
            timestamp: new Date().toISOString(),
          },
        },
        { qos: 0, retain: false }
      );
    } catch (error) {
      this.logger.errorSync('Failed to publish shell output', error as Error, {
        component: LogComponents.agent,
      });
    }
  }

  /**
   * Cleanup - stop session and unsubscribe
   */
  async cleanup(): Promise<void> {
    this.stopSession();
    
    try {
      await this.mqtt.unsubscribe(this.commandTopic);
    } catch (error) {
      this.logger.errorSync('Error unsubscribing from shell topic', error as Error, {
        component: LogComponents.agent,
      });
    }

    this.logger.infoSync('Shell handler cleaned up', {
      component: LogComponents.agent,
    });
  }
}
