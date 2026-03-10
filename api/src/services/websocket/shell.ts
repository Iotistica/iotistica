import { WebSocket } from 'ws';
import { JwtPayload } from 'jsonwebtoken';
import { z } from 'zod';
import { createHmac } from 'crypto';
import { sessionManager } from '../session-manager';
import { query } from '../../db/connection';
import logger from '../../utils/logger';
import { mqttDeviceTopic } from '../../mqtt/topics';
import { getTenantId } from '../../redis/tenant-keys';

// ─── Shared WebSocket Types ──────────────────────────────────────────────────

export interface WebSocketClient {
  ws: WebSocket;
  deviceUuid: string | null;
  user: JwtPayload | null;
  subscriptions: Set<string>;
  intervals: Map<string, NodeJS.Timeout>;
  serviceName?: string;
  redisSubscription?: boolean;
  messageTimestamps: number[];
  tokenExpiryTimeout?: NodeJS.Timeout;
}

export interface WebSocketMessage {
  type: string;
  deviceUuid?: string;
  channel?: string;
  data?: any;
  timestamp?: string;
  message?: string;
  serviceName?: string;
  source?: string;
}

// ─── Shared Zod Schemas (used in DeviceMessageSchema union) ─────────────────

// Device UUID schema: allow canonical UUIDs and legacy lowercase hex IDs
export const UuidSchema = z.union([
  z.string().uuid(),
  z.string().regex(/^[a-f0-9]+$/).min(8).max(128),
]);

// Session ID schema (alphanumeric + hyphens, reasonable length)
export const SessionIdSchema = z.string().uuid();

export const CreateSessionSchema = z.object({
  type: z.literal('create-session'),
  deviceUuid: UuidSchema.optional(),
  data: z.object({
    userId: z.coerce.string().optional(),
  }).optional(),
});

export const AttachSessionSchema = z.object({
  type: z.literal('attach-session'),
  deviceUuid: UuidSchema.optional(),
  data: z.object({
    sessionId: SessionIdSchema,
    userId: z.coerce.string().optional(),
  }),
});

export const DetachSessionSchema = z.object({
  type: z.literal('detach-session'),
  data: z.object({
    sessionId: SessionIdSchema,
  }),
});

export const TerminateSessionSchema = z.object({
  type: z.literal('terminate-session'),
  data: z.object({
    sessionId: SessionIdSchema,
  }),
});

export const ClearAllSessionsSchema = z.object({
  type: z.literal('clear-all-sessions'),
  deviceUuid: UuidSchema.optional(),
  data: z.object({
    userId: z.coerce.string().optional(),
  }).optional(),
});

export const ListSessionsSchema = z.object({
  type: z.literal('list-sessions'),
  deviceUuid: UuidSchema.optional(),
});

export const ShellInputSchema = z.object({
  type: z.literal('shell-input'),
  data: z.object({
    sessionId: SessionIdSchema,
    input: z.string().max(4096),
  }).or(z.object({
    sessionId: SessionIdSchema,
    data: z.string().max(4096),
  })),
});

export const ResizeSessionSchema = z.object({
  type: z.literal('resize-session'),
  data: z.object({
    sessionId: SessionIdSchema,
    cols: z.number().int().min(1).max(999),
    rows: z.number().int().min(1).max(999),
  }),
});

export const LegacyShellSchema = z.object({
  type: z.literal('shell'),
  deviceUuid: UuidSchema.optional(),
  data: z.object({
    action: z.string().max(50),
    sessionId: SessionIdSchema.optional(),
  }).optional(),
});

// ─── ShellHandler ────────────────────────────────────────────────────────────

export interface ShellHandlerDeps {
  send: (ws: WebSocket, message: any) => void;
  broadcast: (deviceUuid: string, message: any) => void;
  getUserIdentifier: (user: JwtPayload | null | undefined) => string;
}

export class ShellHandler {
  private mqttManager: any = null;
  private commandBuffers: Map<string, string> = new Map();
  private shellListenersRegistered = false;

  constructor(private deps: ShellHandlerDeps) {}

  // ─── MQTT setup ──────────────────────────────────────────────────────────

  setMqttManager(manager: any): void {
    this.mqttManager = manager;

    if (!this.shellListenersRegistered && manager) {
      this.shellListenersRegistered = true;

      const shellOutputTopic = mqttDeviceTopic(getTenantId(), '+', 'agent', 'shell-output');
      manager.subscribeTopic(shellOutputTopic, 1);

      manager.on('agent', (payload: any) => {
        if (payload.subTopic === 'shell-output') {
          this.handleShellOutput(payload.deviceUuid, payload.message);
        }
      });

      sessionManager.setStatusChangeCallback((sessionId, status, message) => {
        this.notifySessionStatusChange(sessionId, status, message);
      });
    }
  }

  // ─── Command signing ─────────────────────────────────────────────────────

  /**
   * Sign shell command with HMAC-SHA256 (matches agent verification)
   */
  private signShellCommand(command: any, deviceUuid: string): any {
    const secret = process.env.AGENT_SHELL_HMAC_KEY;

    if (!secret) {
      logger.warn('🐚 [SHELL] ⚠️ AGENT_SHELL_HMAC_KEY not set - sending unsigned command (INSECURE)', {
        action: command.action,
      });
      return command;
    }

    const issuedAt = Date.now();
    const expiresAt = issuedAt + 60 * 1000; // 60 second expiry window

    const signedCommand = {
      ...command,
      issued_at: issuedAt,
      expires_at: expiresAt,
    };

    // Canonical string must match agent's verifyCommandSignature.
    // Use JSON.stringify to avoid delimiter collision and include deviceUuid
    // to prevent cross-device replay attacks.
    const canonicalPayload = {
      deviceUuid,
      action: command.action,
      sessionId: command.sessionId || '',
      data: command.data || '',
      cols: command.cols || null,
      rows: command.rows || null,
      issued_at: issuedAt,
      expires_at: expiresAt,
    };
    const canonicalString = JSON.stringify(canonicalPayload);

    const signature = createHmac('sha256', secret).update(canonicalString).digest('hex');
    signedCommand.signature = signature;

    logger.debug('🐚 [SHELL] ✅ Command signed with HMAC', {
      action: command.action,
      issued_at: new Date(issuedAt).toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
      deviceUuid: deviceUuid.substring(0, 8) + '...',
    });

    return signedCommand;
  }

  // ─── MQTT publish ─────────────────────────────────────────────────────────

  /**
   * Forward a shell command to a device via MQTT.
   */
  async handleShellCommand(deviceUuid: string, data: any): Promise<void> {
    if (!this.mqttManager) {
      logger.error('🐚 [SHELL] ❌ MQTT Manager not set - cannot send shell command');
      return;
    }

    try {
      const tenantId = getTenantId();
      const topic = mqttDeviceTopic(tenantId, deviceUuid, 'agent', 'shell');

      const signedCommand = this.signShellCommand(data, deviceUuid);
      const payload = JSON.stringify(signedCommand);

      logger.debug('SHELL: Publishing command to MQTT', {
        deviceUuid: deviceUuid.substring(0, 8) + '...',
        topic,
        action: data.action,
        sessionId: data.sessionId?.substring(0, 8),
        signed: !!signedCommand.signature,
      });

      await this.mqttManager.publish(topic, payload, 1);
      logger.debug('SHELL: Command published to MQTT successfully');
    } catch (error) {
      logger.error('🐚 [SHELL] ❌ Failed to send shell command:', error);
    }
  }

  // ─── MQTT shell-output handler ────────────────────────────────────────────

  /**
   * Handle shell output received from MQTT - forward to attached WebSocket clients.
   */
  handleShellOutput(deviceUuid: string, message: any): void {
    const outputData = message?.data || message;
    const sessionId = outputData?.sessionId;
    const output = outputData?.output;

    if (sessionId && output) {
      if (!sessionManager.isPtyActive(sessionId)) {
        sessionManager.setPtyActive(sessionId, true);
      }

      sessionManager.appendToBuffer(sessionId, output);

      const attachedClients = sessionManager.getAttachedClients(sessionId);
      logger.debug(`SHELL: Broadcasting to ${attachedClients.size} attached clients`);

      let sentCount = 0;
      attachedClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            this.deps.send(ws, {
              type: 'shell-output',
              sessionId,
              data: { output },
              timestamp: new Date().toISOString(),
              source: 'mqtt',
            });
            sentCount++;
          } catch (err) {
            logger.warn('SHELL: Failed to send to client, will detach on next error');
          }
        }
      });

      logger.debug(`🐚 [SHELL] Sent to ${sentCount}/${attachedClients.size} clients`);
    } else {
      // Legacy non-session output: broadcast to all device clients
      logger.debug('SHELL: Broadcasting legacy output');
      this.deps.broadcast(deviceUuid, {
        type: 'shell',
        deviceUuid,
        data: outputData,
        timestamp: new Date().toISOString(),
        source: 'mqtt',
      });
    }

    logger.debug('SHELL: Broadcast complete');
  }

  // ─── Session status notification ─────────────────────────────────────────

  notifySessionStatusChange(sessionId: string, status: string, message: string): void {
    const attachedClients = sessionManager.getAttachedClients(sessionId);
    logger.debug(`SHELL: Notifying ${attachedClients.size} clients of session status: ${status}`);

    attachedClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        this.deps.send(ws, {
          type: 'session-status',
          sessionId,
          data: { status, message },
        });
      }
    });
  }

  // ─── Session handlers ─────────────────────────────────────────────────────

  async handleCreateSession(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    try {
      const userId = this.deps.getUserIdentifier(client.user);
      if (userId === 'unknown') {
        logger.warn('SHELL: Rejected - unauthenticated user attempting to create session');
        this.deps.send(client.ws, {
          type: 'error',
          message: 'Unauthorized: authentication required for shell access',
        });
        return;
      }

      const deviceUuid = message.deviceUuid || client.deviceUuid;
      if (!deviceUuid) {
        this.deps.send(client.ws, {
          type: 'error',
          message: 'Device UUID required to create session',
        });
        return;
      }

      const session = await sessionManager.createSession(deviceUuid, userId);

      await this.handleShellCommand(deviceUuid, {
        action: 'start',
        sessionId: session.sessionId,
      });

      await sessionManager.markStartCommandSent(session.sessionId);
      logger.debug('SHELL: Waiting for agent response for session');

      this.deps.send(client.ws, {
        type: 'session-created',
        sessionId: session.sessionId,
        deviceUuid,
        data: session,
      });

      logger.info(`🐚 SESSION created: ${session.sessionId.substring(0, 8)}... (user: ${userId})`);
    } catch (error: any) {
      logger.error('SHELL: Failed to create session:', error);
      this.deps.send(client.ws, {
        type: 'error',
        message: `Failed to create session: ${error.message}`,
      });
    }
  }

  /**
   * Attach client to existing session.
   * Validates user is authenticated and owns the session.
   * Auto-restarts PTY if it died.
   */
  async handleAttachSession(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    const userId = this.deps.getUserIdentifier(client.user);
    if (userId === 'unknown') {
      logger.warn('SHELL: Rejected - unauthenticated user attempting to attach to session');
      this.deps.send(client.ws, {
        type: 'error',
        message: 'Unauthorized: authentication required for shell access',
      });
      return;
    }

    logger.debug('SHELL: handleAttachSession called', {
      hasSessionId: !!message.data?.sessionId,
      sessionId: message.data?.sessionId?.substring(0, 8) + '...',
      userId,
      deviceUuid: client.deviceUuid?.substring(0, 8) + '...',
    });

    try {
      const sessionId = message.data?.sessionId;
      if (!sessionId) {
        logger.warn('SHELL: No sessionId provided in attach request');
        this.deps.send(client.ws, { type: 'error', message: 'Session ID required' });
        return;
      }

      const result = await sessionManager.attachSession(sessionId, client.ws, userId);
      logger.debug(`SHELL: Attached, buffer size: ${result.buffer.length} chunks, needsPtyRestart: ${result.needsPtyRestart}`);

      if (client.deviceUuid && result.needsPtyRestart) {
        logger.debug('SHELL: Restarting PTY');
        await this.handleShellCommand(client.deviceUuid, {
          action: 'start',
          sessionId,
        });
        logger.debug('SHELL: PTY start command sent');
      } else {
        logger.debug('SHELL: PTY already running, skipping start command');
      }

      this.deps.send(client.ws, {
        type: 'session-attached',
        sessionId,
        data: {
          buffer: result.buffer,
          ptyRestarted: result.needsPtyRestart,
        },
      });

      logger.debug('SHELL: Client attached to session');
    } catch (error: any) {
      logger.error('🐚 [SESSION] Failed to attach session:', error);
      logger.error('🐚 [SESSION] Error stack:', error.stack);
      this.deps.send(client.ws, {
        type: 'error',
        message: `Failed to attach session: ${error.message}`,
      });
    }
  }

  async handleDetachSession(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    try {
      const userId = this.deps.getUserIdentifier(client.user);
      if (userId === 'unknown') {
        logger.warn('🐚 [SESSION] Rejected - unauthenticated user attempting to detach from session');
        return;
      }

      const sessionId = message.data?.sessionId;
      if (!sessionId) return;

      await sessionManager.detachSession(sessionId, client.ws);
      this.deps.send(client.ws, { type: 'session-detached', sessionId });
      logger.debug('SHELL: Client detached from session');
    } catch (error: any) {
      logger.error('🐚 [SESSION] Failed to detach session:', error);
    }
  }

  async handleTerminateSession(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    try {
      const userId = this.deps.getUserIdentifier(client.user);
      if (userId === 'unknown') {
        logger.warn('🐚 [SESSION] Rejected - unauthenticated user attempting to terminate session');
        this.deps.send(client.ws, {
          type: 'error',
          message: 'Unauthorized: authentication required for shell access',
        });
        return;
      }

      const sessionId = message.data?.sessionId;
      if (!sessionId) {
        this.deps.send(client.ws, { type: 'error', message: 'Session ID required' });
        return;
      }

      const sessions = await sessionManager.listSessions();
      const session = sessions.find(s => s.sessionId === sessionId);

      if (!session) {
        this.deps.send(client.ws, { type: 'error', message: 'Session not found' });
        return;
      }

      if (session.userId && session.userId !== userId) {
        logger.warn(`🐚 [SESSION] Rejected - user ${userId} attempting to terminate session owned by ${session.userId}`);
        this.deps.send(client.ws, {
          type: 'error',
          message: 'Unauthorized: you do not own this session',
        });
        return;
      }

      await this.handleShellCommand(session.deviceUuid, { action: 'stop', sessionId });
      await sessionManager.terminateSession(sessionId);
      this.commandBuffers.delete(sessionId);

      logger.debug('SHELL: Terminated session');
    } catch (error: any) {
      logger.error('🐚 [SESSION] Failed to terminate session:', error);
      this.deps.send(client.ws, {
        type: 'error',
        message: `Failed to terminate session: ${error.message}`,
      });
    }
  }

  async handleClearAllSessions(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    try {
      const userId = this.deps.getUserIdentifier(client.user);
      if (userId === 'unknown') {
        logger.warn('🐚 [SESSION] Rejected - unauthenticated user attempting to clear sessions');
        this.deps.send(client.ws, {
          type: 'error',
          message: 'Unauthorized: authentication required to clear sessions',
        });
        return;
      }

      const deviceUuid = message.deviceUuid || client.deviceUuid;
      logger.debug(`SHELL: Clear all sessions requested`);
      logger.debug(`Device: ${deviceUuid?.substring(0, 8)}...`);
      logger.debug(`User: ${userId}`);

      if (!deviceUuid) {
        logger.error('No device UUID provided');
        this.deps.send(client.ws, { type: 'error', message: 'Device UUID required' });
        return;
      }

      const sessionsBefore = await sessionManager.listSessions(deviceUuid);
      logger.debug(`Sessions before clear: ${sessionsBefore.length}`);

      await sessionManager.terminateAllSessions(deviceUuid, userId);
      logger.debug('Terminate completed');

      sessionsBefore.forEach(session => {
        if (session.userId === userId) {
          this.commandBuffers.delete(session.sessionId);
        }
      });
      logger.debug('Command buffers cleaned');

      const sessionsAfter = await sessionManager.listSessions(deviceUuid);
      logger.debug(`Sessions after clear: ${sessionsAfter.length}`);

      this.deps.send(client.ws, {
        type: 'all-sessions-cleared',
        message: 'All sessions cleared successfully',
      });

      this.deps.send(client.ws, {
        type: 'sessions-list',
        data: { sessions: sessionsAfter },
      });

      logger.debug('Clear all sessions completed');
    } catch (error: any) {
      logger.error('Failed to clear sessions:', error);
      this.deps.send(client.ws, {
        type: 'error',
        message: `Failed to clear sessions: ${error.message}`,
      });
    }
  }

  async handleListSessions(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    try {
      const deviceUuid = message.deviceUuid || client.deviceUuid;
      const sessions = await sessionManager.listSessions(deviceUuid);

      this.deps.send(client.ws, {
        type: 'sessions-list',
        deviceUuid,
        data: { sessions },
      });

      logger.debug(`Listed ${sessions.length} sessions`);
    } catch (error: any) {
      logger.error('Failed to list sessions:', error);
      this.deps.send(client.ws, {
        type: 'error',
        message: `Failed to list sessions: ${error.message}`,
      });
    }
  }

  async handleShellInput(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    try {
      const userId = this.deps.getUserIdentifier(client.user);
      if (userId === 'unknown') {
        logger.warn('🐚 [SESSION] Rejected - unauthenticated user attempting to send shell input');
        this.deps.send(client.ws, {
          type: 'error',
          message: 'Unauthorized: authentication required for shell access',
        });
        return;
      }

      const sessionId = message.data?.sessionId;
      const input = message.data?.input ?? message.data?.data;

      if (!sessionId || input === undefined) {
        this.deps.send(client.ws, { type: 'error', message: 'Session ID and input required' });
        return;
      }

      const sessions = await sessionManager.listSessions();
      const session = sessions.find(s => s.sessionId === sessionId);

      if (!session) {
        this.deps.send(client.ws, { type: 'error', message: 'Session not found' });
        return;
      }

      if (session.userId && session.userId !== userId) {
        logger.warn(`🐚 [SESSION] Rejected - user ${userId} attempting to access session owned by ${session.userId}`);
        this.deps.send(client.ws, {
          type: 'error',
          message: 'Unauthorized: you do not own this session',
        });
        return;
      }

      await this.trackShellCommand(sessionId, input, session.deviceUuid, session.userId);

      await this.handleShellCommand(session.deviceUuid, {
        action: 'input',
        sessionId,
        data: input,
      });

      logger.debug(`🐚 [SESSION] Forwarded input to session ${sessionId.substring(0, 8)}...`);
    } catch (error: any) {
      logger.error('🐚 [SESSION] Failed to handle shell input:', error);
      this.deps.send(client.ws, {
        type: 'error',
        message: `Failed to send input: ${error.message}`,
      });
    }
  }

  async handleResizeSession(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    try {
      const userId = this.deps.getUserIdentifier(client.user);
      if (userId === 'unknown') {
        logger.warn('🐚 [SESSION] Rejected - unauthenticated user attempting to resize session');
        return;
      }

      const sessionId = message.data?.sessionId;
      const cols = message.data?.cols;
      const rows = message.data?.rows;

      if (!sessionId || !cols || !rows) {
        logger.warn('🐚 [SESSION] Invalid resize request - missing sessionId, cols, or rows');
        return;
      }

      const sessions = await sessionManager.listSessions();
      const session = sessions.find(s => s.sessionId === sessionId);

      if (!session) {
        logger.warn(`🐚 [SESSION] Cannot resize - session ${sessionId.substring(0, 8)}... not found`);
        return;
      }

      if (session.userId && session.userId !== userId) {
        logger.warn(`🐚 [SESSION] Rejected - user ${userId} attempting to resize session owned by ${session.userId}`);
        return;
      }

      await this.handleShellCommand(session.deviceUuid, {
        action: 'resize',
        sessionId,
        cols,
        rows,
      });

      logger.debug(`🐚 [SESSION] Forwarded resize (${cols}x${rows}) to session ${sessionId.substring(0, 8)}...`);
    } catch (error: any) {
      logger.error('🐚 [SESSION] Failed to handle resize:', error);
    }
  }

  // ─── Audit logging ────────────────────────────────────────────────────────

  private async trackShellCommand(
    sessionId: string,
    input: string,
    deviceUuid: string,
    userId: string,
  ): Promise<void> {
    try {
      let commandBuffer = this.commandBuffers.get(sessionId) || '';
      const isEnter = input === '\r' || input === '\n';

      if (isEnter) {
        if (commandBuffer.trim().length > 0) {
          await query(
            `INSERT INTO shell_audit_log (user_id, device_uuid, session_id, command)
             VALUES ($1, $2, $3, $4)`,
            [userId, deviceUuid, sessionId, commandBuffer],
          );
          logger.info('📝 [AUDIT] Logged shell command', {
            sessionId: sessionId.substring(0, 8),
            deviceUuid: deviceUuid.substring(0, 8),
            userId,
            commandLength: commandBuffer.length,
          });
        }
        this.commandBuffers.delete(sessionId);
      } else if (input === '\x7f' || input === '\b') {
        commandBuffer = commandBuffer.slice(0, -1);
        this.commandBuffers.set(sessionId, commandBuffer);
      } else if (input === '\x03') {
        this.commandBuffers.delete(sessionId);
      } else {
        commandBuffer += input;
        this.commandBuffers.set(sessionId, commandBuffer);
      }
    } catch (error: any) {
      logger.error('📝 [AUDIT] Failed to track shell command:', error);
      // Don't throw - audit logging failure shouldn't break shell functionality
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  shutdown(): void {
    this.commandBuffers.clear();
  }
}
