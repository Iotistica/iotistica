import * as pty from 'node-pty';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { MqttManager } from '../mqtt/manager';
import { deviceTopic } from '../mqtt/topics.js';
import * as os from 'os';
import { createHmac, timingSafeEqual } from 'crypto';
import * as fs from 'fs';

/**
 * Shell command message structure
 */
interface ShellCommand {
  action: 'start' | 'stop' | 'input' | 'resize';
  sessionId?: string;
  data?: string;
  cols?: number;
  rows?: number;
  signature?: string;      // HMAC-SHA256 signature of command fields
  issued_at?: number;      // Unix timestamp (ms) when command was issued
  expires_at?: number;     // Optional expiry timestamp (prevents replay attacks)
}

/**
 * Verify HMAC signature of shell command (prevents unauthorized access)
 */
function verifyCommandSignature(command: ShellCommand, secret: string, deviceUuid: string): boolean {
  if (!command.signature || !command.issued_at) {
    return false;
  }

  // Create canonical string from command fields (excluding signature)
  // Use JSON.stringify to avoid delimiter collision (e.g., data containing '|')
  // Include deviceUuid to prevent cross-device replay attacks
  const canonicalPayload = {
    deviceUuid,
    action: command.action,
    sessionId: command.sessionId || '',
    data: command.data || '',
    cols: command.cols || null,
    rows: command.rows || null,
    issued_at: command.issued_at,
    expires_at: command.expires_at || null
  };
  const canonicalString = JSON.stringify(canonicalPayload);

  // Compute expected HMAC
  const expectedSignature = createHmac('sha256', secret)
    .update(canonicalString)
    .digest('hex');

  // Timing-safe comparison (prevents timing attacks)
  try {
    return timingSafeEqual(
      Buffer.from(command.signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  } catch {
    return false; // Invalid signature format
  }
}

/**
 * Shell Handler - Spawns PTY process and manages bidirectional I/O
 * 
 * MQTT Topics:
 * - Subscribe: iot/device/{uuid}/agent/shell (commands from cloud)
 * - Publish: iot/device/{uuid}/agent/shell-output (output to cloud)
 * 
 * Security:
 * - Disabled without HMAC secret (prevents misconfigured production deployments)
 * - HMAC-SHA256 signature verification (requires AGENT_SHELL_HMAC_KEY env var)
 * - Device UUID in signature (prevents cross-device replay attacks)
 * - JSON-based canonical string (prevents delimiter collision attacks)
 * - Command age validation (rejects commands older than 30 seconds)
 * - Command expiry validation (prevents replay attacks)
 * - Session ID validation (prevents command misrouting)
 * - Shell path allowlist (prevents arbitrary code execution via env injection)
 * - Privilege dropping (runs as non-root user in Docker)
 * - 5-minute idle timeout (terminates inactive sessions)
 * - Maximum session duration (prevents keepalive bypass, default 1 hour)
 * - 200KB output buffer cap (prevents memory exhaustion)
 * - Minimal environment (no credential leakage via 'env' command)
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
  private outputBuffer = ''; // Buffer for batching PTY output chunks
  private flushTimer: NodeJS.Timeout | null = null; // Timer for flushing buffered output
  private idleTimer: NodeJS.Timeout | null = null; // Timer for idle timeout
  private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_SESSION_MS: number; // Maximum session duration (prevents keepalive bypass)
  private readonly MAX_BUFFER_SIZE = 200000; // 200KB max buffer (prevents memory exhaustion)
  private hmacSecret: string | undefined; // HMAC secret for command signature verification
  private sessionStartTime: number | null = null; // Track session start for max duration enforcement
  private readonly shellEnabled: boolean; // Shell disabled if no HMAC secret (prevents misconfigured containers)
  
  // SECURITY: Shell path allowlist (prevents arbitrary code execution via AGENT_SHELL env injection)
  private readonly ALLOWED_SHELLS = [
    '/bin/bash',
    '/bin/sh',
    '/bin/zsh',
    '/bin/dash',
    '/usr/bin/bash',
    '/usr/bin/sh',
    'powershell.exe',
    'pwsh.exe',
    'cmd.exe'
  ];

    /**
     * Resolve shell path with explicit validation (no implicit fallback behavior).
     */
    private resolveShell(): string {
      const platformDefault = os.platform() === 'win32' ? 'powershell.exe' : '/bin/sh';
      const requestedShell = process.env.AGENT_SHELL;

      if (!requestedShell) {
        return platformDefault;
      }

      if (!this.ALLOWED_SHELLS.includes(requestedShell)) {
        throw new Error(
          `AGENT_SHELL '${requestedShell}' is not allowlisted. Allowed: ${this.ALLOWED_SHELLS.join(', ')}`
        );
      }

      return requestedShell;
    }

    /**
     * Check if a shell exists at the given path
     */
    private shellExists(shellPath: string): boolean {
      if (os.platform() === 'win32') {
        // On Windows, trust the exe names (powershell.exe, pwsh.exe, cmd.exe)
        return true;
      }
      try {
        fs.accessSync(shellPath, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }

    /**
     * Resolve working directory explicitly (no fallback chain).
     */
    private resolveWorkingDirectory(): string {
      const configured = process.env.AGENT_SHELL_CWD || process.env.CONFIG_DIR || '/app/data';
      try {
        fs.accessSync(configured, fs.constants.R_OK | fs.constants.X_OK);
        return configured;
      } catch {
        throw new Error(
          `Shell working directory '${configured}' is not accessible. Set AGENT_SHELL_CWD to a readable/executable path.`
        );
      }
    }

  constructor(deviceUuid: string, mqtt: MqttManager, logger: AgentLogger) {
    this.deviceUuid = deviceUuid;
    this.mqtt = mqtt;
    this.logger = logger;
    this.commandTopic = deviceTopic(deviceUuid, 'agent', 'shell');
    this.outputTopic = deviceTopic(deviceUuid, 'agent', 'shell-output');
    
    // SECURITY: Load HMAC secret from environment (REQUIRED for production)
    // Without this, shell is completely disabled to prevent misconfigured deployments
    this.hmacSecret = process.env.AGENT_SHELL_HMAC_KEY;
    this.shellEnabled = !!this.hmacSecret;
    
    if (!this.hmacSecret) {
      this.logger.errorSync(
        'AGENT_SHELL_HMAC_KEY not set - shell access DISABLED',
        new Error('Missing HMAC secret'),
        {
          component: LogComponents.shell,
          security_risk: 'critical',
          recommendation: 'Set AGENT_SHELL_HMAC_KEY environment variable to enable shell access'
        }
      );
    }
    
    // Load max session duration (prevents keepalive bypass attacks)
    // Default: 1 hour for SaaS, disabled (0) for self-hosted
    const maxSessionEnv = process.env.AGENT_SHELL_MAX_SESSION_MS;
    this.MAX_SESSION_MS = maxSessionEnv ? Number(maxSessionEnv) : 60 * 60 * 1000; // 1 hour default
  }

  /**
   * Initialize shell handler - subscribe to shell commands
   */
  async initialize(): Promise<void> {

    // Subscribe to shell command topic
    await this.mqtt.subscribe(
      this.commandTopic,
      { qos: 1 },
      (topic, payload) => this.handleCommand(payload)
    );

  }

  /**
   * Handle incoming shell command
   */
  private async handleCommand(payload: Buffer): Promise<void> {
    try {
      const command: ShellCommand = JSON.parse(payload.toString());
      
      // SECURITY: Reject all commands if shell is disabled (no HMAC secret configured)
      // This prevents misconfigured production containers from exposing unauthenticated shells
      if (!this.shellEnabled) {
        this.logger.errorSync(
          'Shell command rejected - shell disabled (no HMAC secret)',
          new Error('Shell access disabled'),
          {
            component: LogComponents.shell,
            action: command.action,
            recommendation: 'Configure AGENT_SHELL_HMAC_KEY to enable shell access'
          }
        );
        return;
      }
      
      this.logger.debugSync('Received shell command', {
        component: LogComponents.shell,
        action: command.action,
        sessionActive: this.sessionActive,
      });

      // SECURITY: Verify command signature (prevents unauthorized shell access)
      // This is the primary security control - without it, anyone with MQTT access gets shell
      if (this.hmacSecret) {
        if (!verifyCommandSignature(command, this.hmacSecret, this.deviceUuid)) {
          this.logger.errorSync(
            'Shell command rejected - invalid signature',
            new Error('HMAC verification failed'),
            {
              component: LogComponents.shell,
              action: command.action,
              hasSignature: !!command.signature,
              hasIssuedAt: !!command.issued_at
            }
          );
          return;
        }
        
        // Check command age (prevents replay attacks with old commands)
        // Even with valid signature, reject commands older than 30 seconds
        const MAX_COMMAND_AGE_MS = 30000; // 30 seconds
        if (command.issued_at && Date.now() - command.issued_at > MAX_COMMAND_AGE_MS) {
          const ageSeconds = Math.floor((Date.now() - command.issued_at) / 1000);
          this.logger.warnSync('Shell command too old', {
            component: LogComponents.shell,
            action: command.action,
            issued_at: new Date(command.issued_at).toISOString(),
            age_seconds: ageSeconds,
            max_age_seconds: MAX_COMMAND_AGE_MS / 1000
          });
          return;
        }
        
        // Check command expiry (prevents replay attacks with old captured messages)
        if (command.expires_at && Date.now() > command.expires_at) {
          const ageSeconds = Math.floor((Date.now() - command.expires_at) / 1000);
          this.logger.warnSync('Shell command expired', {
            component: LogComponents.shell,
            action: command.action,
            expires_at: new Date(command.expires_at).toISOString(),
            age_seconds: ageSeconds
          });
          return;
        }
      }

      switch (command.action) {
        case 'start':
          await this.startSession(command.sessionId);
          break;
        case 'stop':
          this.stopSession();
          break;
        case 'input':
          // SECURITY: Validate input is for the current session
          // Prevents misrouted input from cloud API or injection attacks where an attacker
          // could route commands to a different user's active shell session.
          // The cloud API must pass the correct sessionId, and we verify it matches before writing to PTY.
          if (command.sessionId && command.sessionId !== this.currentSessionId) {
            this.logger.warnSync('Input rejected - sessionId mismatch', {
              component: LogComponents.shell,
              incomingSessionId: command.sessionId.substring(0, 8),
              currentSessionId: this.currentSessionId?.substring(0, 8) || 'none',
            });
            break;
          }
          
          if (command.data && this.ptyProcess) {
            // Don't log per-chunk - would destroy performance under load
            this.ptyProcess.write(command.data);
            this.resetIdleTimer();
          } else if (!this.ptyProcess) {
            this.logger.warnSync('Cannot write - PTY not active', {
              component: LogComponents.shell,
            });
          }
          break;
        case 'resize':
          if (command.cols && command.rows && this.ptyProcess) {
            this.ptyProcess.resize(command.cols, command.rows);
            this.resetIdleTimer();
          }
          break;
        default:
          this.logger.warnSync('Unknown shell action', {
            component: LogComponents.shell,
            action: command.action,
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

    // Track session start time (for max duration enforcement)
    this.sessionStartTime = Date.now();

    // Clear any leftover output buffer from previous session
    this.outputBuffer = '';

    try {
      // SECURITY: explicit shell/cwd resolution (no implicit fallback behavior)
      const shell = this.resolveShell();
      const willDropPrivileges = !!(process.getuid && process.getuid() === 0 && os.platform() !== 'win32');
      const cwd = this.resolveWorkingDirectory();

      if (!this.shellExists(shell)) {
        throw new Error(`Configured shell '${shell}' not found or not executable`);
      }

      // SECURITY: Minimal environment (prevents credential leakage via 'env' command)
      // Only expose essential variables, NOT database passwords, API tokens, secrets, etc.
      const safeEnv: { [key: string]: string } = {
        HOME: cwd,
        TERM: 'xterm-256color',
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        USER: process.env.USER || 'agent',
        SHELL: shell,
        LANG: process.env.LANG || 'en_US.UTF-8',
      };

      // Preserve non-sensitive endpoint config so iotctl resolves local device API correctly.
      // Without this, iotctl falls back to port 48484 even when agent runs on generated ports (e.g., 48481).
      if (process.env.DEVICE_API_PORT) {
        safeEnv.DEVICE_API_PORT = process.env.DEVICE_API_PORT;
      }
      if (process.env.DEVICE_API_URL) {
        safeEnv.DEVICE_API_URL = process.env.DEVICE_API_URL;
      }
      if (process.env.CLOUD_API_ENDPOINT) {
        safeEnv.CLOUD_API_ENDPOINT = process.env.CLOUD_API_ENDPOINT;
      }

      const spawnOptions: any = {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: safeEnv,
      };

      // SECURITY: Drop privileges if running as root (Docker deployment)
      // Systemd: Already running as service user, this is a no-op
      // Use configurable UID/GID to support different container base images
      if (willDropPrivileges) {
        const targetUid = Number(process.env.AGENT_UID || 1000);
        const targetGid = Number(process.env.AGENT_GID || 1000);
        spawnOptions.uid = targetUid;
        spawnOptions.gid = targetGid;
      }

      this.logger.infoSync('Starting PTY process', {
        component: LogComponents.shell,
        shell,
        cwd,
        platform: os.platform(),
      });

      // Spawn PTY process
      this.ptyProcess = pty.spawn(shell, [], spawnOptions);

      this.sessionActive = true;

      // Send terminal reset sequence to ensure clean state (fixes interactive command artifacts)
      // This clears any alternate screen buffers and resets cursor positioning
      this.ptyProcess.write('\x1b[?1049l\x1b[2J\x1b[H');

      // Handle PTY output - buffer chunks instead of publishing per chunk
      // This reduces MQTT messages by 80-95% under heavy output
      this.ptyProcess.onData((data: string) => {
        this.outputBuffer += data;
        
        // SECURITY: Cap buffer size to prevent memory exhaustion
        // (e.g., from 'yes', 'cat /dev/urandom', or huge log files)
        if (this.outputBuffer.length > this.MAX_BUFFER_SIZE) {
          this.outputBuffer = this.outputBuffer.slice(-this.MAX_BUFFER_SIZE);
        }
        
        // Schedule flush if not already scheduled
        if (!this.flushTimer) {
          this.flushTimer = setTimeout(() => {
            this.flushOutput();
          }, 30); // 30ms batching window (sweet spot for interactive feel)
        }
        
        // Reset idle timer on output activity
        this.resetIdleTimer();
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
      
      // Start idle timeout
      this.resetIdleTimer();
      
      this.logger.infoSync('Shell session started', {
        component: LogComponents.shell,
      });
    } catch (error) {
      this.logger.errorSync('Failed to start shell session', error as Error, {
        component: LogComponents.shell,
      });
      this.sessionActive = false;
      this.sendOutput(`\r\n\x1b[31m✗ Failed to start shell: ${(error as Error).message}\x1b[0m\r\n`);
    }
  }

  /**
   * Stop the shell session
   */
  private stopSession(): void {
    if (!this.sessionActive) {
      return;
    }

    // Clear idle timer
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
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
    this.sessionStartTime = null;

    this.logger.infoSync('Shell session stopped', {
      component: LogComponents.shell,
    });
  }

  /**
   * Reset idle timeout (called on input/output activity)
   * Also enforces maximum session duration to prevent keepalive bypass attacks
   */
  private resetIdleTimer(): void {
    // SECURITY: Check maximum session duration (prevents keepalive bypass)
    // Even if user keeps sending activity, session must terminate after MAX_SESSION_MS
    if (this.MAX_SESSION_MS > 0 && this.sessionStartTime) {
      const sessionAge = Date.now() - this.sessionStartTime;
      if (sessionAge >= this.MAX_SESSION_MS) {
        const sessionMinutes = Math.floor(sessionAge / 60000);
        this.logger.infoSync('Shell max duration exceeded - closing session', {
          component: LogComponents.shell,
          maxSessionMs: this.MAX_SESSION_MS,
          sessionAgeMs: sessionAge,
          sessionMinutes
        });
        this.sendOutput('\r\n\x1b[31m⚠ Session closed: maximum duration exceeded\x1b[0m\r\n');
        this.stopSession();
        return;
      }
    }
    
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    
    this.idleTimer = setTimeout(() => {
      this.logger.infoSync('Shell idle timeout - closing session', {
        component: LogComponents.shell,
        idleTimeoutMs: this.IDLE_TIMEOUT_MS,
      });
      this.sendOutput('\r\n\x1b[33m⚠ Session closed due to inactivity\x1b[0m\r\n');
      this.stopSession();
    }, this.IDLE_TIMEOUT_MS);
  }

  /**
   * Send output message (one-time, not from PTY stream)
   * Adds to buffer and flushes immediately to ensure delivery
   */
  private sendOutput(data: string): void {
    this.outputBuffer += data;
    // Flush immediately for one-time messages (welcome, error)
    this.flushOutput();
  }

  /**
   * Flush buffered PTY output to cloud via MQTT
   * Fire-and-forget with error handling (never block PTY on network I/O)
   */
  private flushOutput(): void {
    // Guard against race condition (session stopped but flush scheduled)
    if (!this.outputBuffer) {
      this.flushTimer = null;
      return;
    }

    const chunk = this.outputBuffer;
    this.outputBuffer = '';
    this.flushTimer = null;

    try {
      const payload = {
        format: 'json' as const,
        data: {
          sessionId: this.currentSessionId,
          output: chunk,
          timestamp: new Date().toISOString(),
        },
      };

      // Fire-and-forget: never await MQTT publish
      // PTY output must never block on network latency
      // Use .catch() to handle errors without blocking
      this.mqtt.publish(
        this.outputTopic,
        payload,
        { qos: 0, retain: false }
      ).catch((error) => {
        this.logger.errorSync('Failed to publish shell output', error as Error, {
          component: LogComponents.shell,
          chunkSize: chunk.length,
        });
      });
    } catch (error) {
      this.logger.errorSync('Error preparing shell output', error as Error, {
        component: LogComponents.shell,
      });
    }
  }

  /**
   * Cleanup - stop session and unsubscribe
   */
  async cleanup(): Promise<void> {
    // Clear idle timer
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    
    // Flush any remaining buffered output before cleanup
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.outputBuffer) {
      this.flushOutput();
    }
    
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
