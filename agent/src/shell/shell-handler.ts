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
  private currentSessionId: string | null = null;

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
      component: LogComponents.shell,
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
      component: LogComponents.shell,
    });
  }

  /**
   * Handle incoming shell command
   */
  private async handleCommand(payload: Buffer): Promise<void> {
    try {
      const message = JSON.parse(payload.toString());
      
      this.logger.debugSync('Received shell command', {
        component: LogComponents.shell,
        action: message.action,
        sessionActive: this.sessionActive,
      });

      switch (message.action) {
        case 'start':
          await this.startSession(message.sessionId);
          break;
        case 'stop':
          this.stopSession();
          break;
        case 'input':
          this.logger.debugSync('Received input action', {
            component: LogComponents.shell,
            hasData: !!message.data,
            hasPty: !!this.ptyProcess,
            sessionActive: this.sessionActive,
            dataLength: message.data?.length || 0,
            sessionId: message.sessionId || 'none',
            currentSessionId: this.currentSessionId || 'none',
          });
          
          if (message.data && this.ptyProcess) {
            this.logger.debugSync('Writing to PTY', {
              component: LogComponents.shell,
              data: message.data.substring(0, 20),
            });
            this.ptyProcess.write(message.data);
          } else {
            this.logger.warnSync('Cannot write - missing data or PTY', {
              component: LogComponents.shell,
              hasData: !!message.data,
              hasPty: !!this.ptyProcess,
            });
          }
          break;
        case 'resize':
          if (message.cols && message.rows && this.ptyProcess) {
            this.ptyProcess.resize(message.cols, message.rows);
          }
          break;
        default:
          this.logger.warnSync('Unknown shell action', {
            component: LogComponents.shell,
            action: message.action,
          });
      }
    } catch (error) {
      this.logger.errorSync('Error handling shell command', error as Error, {
        component: LogComponents.shell,
      });
    }
  }

  /**
   * Start a new shell session
   */
  private async startSession(sessionId?: string): Promise<void> {
    if (this.sessionActive) {
      if (this.currentSessionId && sessionId && this.currentSessionId !== sessionId) {
        this.logger.infoSync('Switching shell session', {
          component: LogComponents.shell,
          fromSessionId: this.currentSessionId.substring(0, 8),
          toSessionId: sessionId.substring(0, 8),
        });
        this.stopSession();
      } else {
        this.logger.warnSync('Shell session already active', {
          component: LogComponents.shell,
        });
        return;
      }
    }

    // Store sessionId for including in shell-output messages
    this.currentSessionId = sessionId || null;

    try {
      // Determine shell and platform
      const shell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/sh';
      const cwd = os.homedir();

      this.logger.infoSync('Starting PTY process', {
        component: LogComponents.shell,
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
        // Explicitly handle flow control to prevent echo issues
        handleFlowControl: false,
        // Use flowing mode for consistent character handling
        useConpty: os.platform() === 'win32' ? true : undefined,
      });

      this.sessionActive = true;

      // Handle PTY output
      this.ptyProcess.onData((data: string) => {
        this.logger.debugSync('PTY onData triggered', {
          component: LogComponents.shell,
          dataLength: data.length,
          preview: data.substring(0, 30).replace(/[\r\n]/g, '\\n'),
        });
        this.sendOutput(data);
      });

      // Handle PTY exit
      this.ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        this.logger.infoSync('PTY process exited', {
          component: LogComponents.shell,
          exitCode,
          signal,
        });
        this.stopSession();
      });

      // Send welcome message
      await this.sendOutput('\r\n\x1b[32m✓ Shell session started\x1b[0m\r\n');
      
      this.logger.infoSync('Shell session started', {
        component: LogComponents.shell,
      });
    } catch (error) {
      this.logger.errorSync('Failed to start shell session', error as Error, {
        component: LogComponents.shell,
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
      component: LogComponents.shell,
    });

    if (this.ptyProcess) {
      try {
        this.ptyProcess.kill();
      } catch (error) {
        this.logger.errorSync('Error killing PTY process', error as Error, {
          component: LogComponents.shell,
        });
      }
      this.ptyProcess = null;
    this.currentSessionId = null;
    }

    this.sessionActive = false;

    this.logger.infoSync('Shell session stopped', {
      component: LogComponents.shell,
    });
  }

  /**
   * Send shell output to cloud via MQTT
   */
  private async sendOutput(data: string): Promise<void> {
    this.logger.debugSync('sendOutput called', {
      component: LogComponents.shell,
      dataLength: data.length,
      sessionId: this.currentSessionId || 'none',
      outputTopic: this.outputTopic,
      preview: data.substring(0, 50).replace(/[\r\n]/g, '\\n'),
    });
    
    try {
      const payload = {
        format: 'json' as const,
        data: {
          sessionId: this.currentSessionId,
          output: data,
          timestamp: new Date().toISOString(),
        },
      };
      
      this.logger.debugSync('Publishing to MQTT', {
        component: LogComponents.shell,
        topic: this.outputTopic,
        payloadSize: JSON.stringify(payload).length,
      });
      
      await this.mqtt.publish(
        this.outputTopic,
        payload,
        { qos: 0, retain: false }
      );
      
      this.logger.debugSync('MQTT publish successful', {
        component: LogComponents.shell,
      });
    } catch (error) {
      this.logger.errorSync('Failed to publish shell output', error as Error, {
        component: LogComponents.shell,
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
        component: LogComponents.shell,
      });
    }

    this.logger.infoSync('Shell handler cleaned up', {
      component: LogComponents.shell,
    });
  }
}
