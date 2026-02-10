import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';
import { query } from '../db/connection';

interface SessionInfo {
  sessionId: string;
  deviceUuid: string;
  userId?: string;
  status: 'creating' | 'active' | 'detached' | 'terminated';
  createdAt: Date;
  lastActivity: Date;
  terminatedAt?: Date;
  metadata?: any;
}

interface SessionBuffer {
  chunks: string[]; // Raw output chunks to preserve ANSI sequences
  totalBytes: number;
  maxChunks: number;
  maxBytes: number;
}

interface ActiveSession {
  info: SessionInfo;
  buffer: SessionBuffer;
  attachedClients: Set<WebSocket>;
  devicePtyActive: boolean;
  lastActivityWriteTime: number; // Debounce DB writes
  ptyStartedAt?: Date; // Track when PTY actually started
}

export class SessionManager {
  private sessions: Map<string, ActiveSession> = new Map();
  private activePtySession: Map<string, string> = new Map(); // deviceUuid -> sessionId with active PTY
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  // Configuration
  private readonly BUFFER_MAX_CHUNKS = parseInt(process.env.SESSION_BUFFER_CHUNKS || '1000', 10); // ~1000 chunks
  private readonly BUFFER_MAX_BYTES = parseInt(process.env.SESSION_BUFFER_MAX_BYTES || '1048576', 10); // 1MB
  private readonly REPLAY_MAX_CHUNKS = parseInt(process.env.SESSION_REPLAY_CHUNKS || '500', 10); // Max chunks to replay on attach
  private readonly REPLAY_MAX_BYTES = parseInt(process.env.SESSION_REPLAY_MAX_BYTES || '131072', 10); // 128KB max replay
  private readonly SESSION_TIMEOUT_MINUTES = parseInt(process.env.SESSION_TIMEOUT_MINUTES || '30', 10);
  private readonly SESSION_MAX_PER_DEVICE = parseInt(process.env.SESSION_MAX_PER_DEVICE || '5', 10);
  private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly ACTIVITY_UPDATE_DEBOUNCE_MS = 5000; // Only update DB every 5 seconds
  private readonly PTY_STARTUP_GRACE_PERIOD_MS = 30000; // 30 seconds for PTY to start

  constructor() {
    this.startCleanupJob();
  }

  /**
   * Create a new shell session
   */
  async createSession(deviceUuid: string, userId?: string): Promise<SessionInfo> {
    // Check device session limit
    const deviceSessions = this.getDeviceSessions(deviceUuid);
    let activeSessions = deviceSessions.filter(s => s.status !== 'terminated');
    
    if (activeSessions.length >= this.SESSION_MAX_PER_DEVICE) {
      // Try to free a slot by terminating the oldest detached session
      const detachedSessions = activeSessions.filter(s =>
        s.status === 'detached' && (!userId || !s.userId || s.userId === userId)
      );

      if (detachedSessions.length > 0) {
        const oldestDetached = detachedSessions.sort((a, b) =>
          new Date(a.lastActivity).getTime() - new Date(b.lastActivity).getTime()
        )[0];
        logger.info(`🐚 [SESSION] Auto-terminating oldest detached session ${oldestDetached.sessionId.substring(0, 8)}...`);
        await this.terminateSession(oldestDetached.sessionId);
      } else {
        const params: any[] = [deviceUuid];
        let userClause = '';
        if (userId) {
          userClause = ' AND (user_id IS NULL OR user_id = $2)';
          params.push(userId);
        }
        const result = await query(
          `SELECT session_id FROM shell_sessions WHERE device_uuid = $1 AND status = 'detached'${userClause} ORDER BY last_activity ASC LIMIT 1`,
          params
        );

        if (result.rows.length > 0) {
          const oldestDetachedId = result.rows[0].session_id as string;
          await this.loadSessionFromDatabase(oldestDetachedId);
          logger.info(`🐚 [SESSION] Auto-terminating oldest detached session ${oldestDetachedId.substring(0, 8)}...`);
          await this.terminateSession(oldestDetachedId);
        }
      }

      activeSessions = this.getDeviceSessions(deviceUuid).filter(s => s.status !== 'terminated');
      if (activeSessions.length >= this.SESSION_MAX_PER_DEVICE) {
        throw new Error(`Device ${deviceUuid} has reached maximum sessions (${this.SESSION_MAX_PER_DEVICE})`);
      }
    }

    const sessionId = uuidv4();
    const now = new Date();

    const sessionInfo: SessionInfo = {
      sessionId,
      deviceUuid,
      userId,
      status: 'creating',
      createdAt: now,
      lastActivity: now,
    };

    // Save to database
    await query(
      `INSERT INTO shell_sessions (session_id, device_uuid, user_id, status, created_at, last_activity)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, deviceUuid, userId, sessionInfo.status, sessionInfo.createdAt, sessionInfo.lastActivity]
    );

    // Create in-memory session
    const activeSession: ActiveSession = {
      info: sessionInfo,
      buffer: {
        chunks: [],
        totalBytes: 0,
        maxChunks: this.BUFFER_MAX_CHUNKS,
        maxBytes: this.BUFFER_MAX_BYTES,
      },
      attachedClients: new Set(),
      devicePtyActive: false,
      lastActivityWriteTime: 0, // Init to 0 so first activity always writes to DB
    };

    this.sessions.set(sessionId, activeSession);

    logger.info(`🐚 [SESSION] Created session ${sessionId.substring(0, 8)}... for device ${deviceUuid.substring(0, 8)}...`);

    return sessionInfo;
  }

  /**
   * Attach a WebSocket client to a session
   * Security: validates user ownership
   * Returns: { buffer, needsPtyRestart } - buffer chunks and flag indicating if PTY needs restart
   */
  async attachSession(sessionId: string, ws: WebSocket, userId?: string): Promise<{ buffer: string[], needsPtyRestart: boolean }> {
    logger.info(`🔄 [SESSION] Preparing to attach to session ${sessionId.substring(0, 8)}... - detaching from any existing sessions first`);
    
    // Detach from any existing sessions first to prevent multi-attach
    await this.detachClientFromAllSessions(ws);
    
    logger.info(`🔄 [SESSION] Detach complete, now attaching to ${sessionId.substring(0, 8)}...`);
    
    // Load session if not in memory
    let session = this.sessions.get(sessionId);
    if (!session) {
      const loaded = await this.loadSessionFromDatabase(sessionId);
      if (!loaded) {
        throw new Error(`Session ${sessionId} not found`);
      }
      session = this.sessions.get(sessionId)!;
    }

    if (session.info.status === 'terminated') {
      throw new Error(`Session ${sessionId} has been terminated`);
    }

    // SECURITY: Validate session ownership
    // Allow if: (1) owner, (2) no owner set, or (3) admin (future: check role)
    if (session.info.userId && userId && session.info.userId !== userId) {
      logger.warn(`🐚 [SESSION] ⚠️ User ${userId} attempted to attach to session owned by ${session.info.userId}`);
      throw new Error(`Access denied: session belongs to another user`);
    }

    // Check if PTY needs to be restarted
    let needsPtyRestart = false;
    
    // Get current active PTY session for this device
    const currentPtySessionId = this.activePtySession.get(session.info.deviceUuid);
    
    // Restart PTY if:
    // 1. Attaching to a different session than the one with active PTY
    // 2. OR PTY is not active at all
    if (currentPtySessionId && currentPtySessionId !== sessionId) {
      logger.info(`🐚 [SESSION] Switching PTY from session ${currentPtySessionId.substring(0, 8)} to ${sessionId.substring(0, 8)}`);
      needsPtyRestart = true;
      // Mark old session's PTY as inactive
      const oldSession = this.sessions.get(currentPtySessionId);
      if (oldSession) {
        oldSession.devicePtyActive = false;
      }
    } else if (session.info.status !== 'creating' && !session.devicePtyActive) {
      const timeSinceCreation = Date.now() - session.info.createdAt.getTime();
      if (timeSinceCreation > this.PTY_STARTUP_GRACE_PERIOD_MS) {
        logger.warn(`🐚 [SESSION] PTY is not active for session ${sessionId.substring(0, 8)}... - will request restart`);
        needsPtyRestart = true;
        // Reset PTY active flag so new output will be accepted
        session.devicePtyActive = false;
      }
    }
    
    // Track this as the active PTY session if restarting
    if (needsPtyRestart) {
      this.activePtySession.set(session.info.deviceUuid, sessionId);
    }

    // Add client to attached set
    session.attachedClients.add(ws);

    // Update status to active if not already
    if (session.info.status !== 'active') {
      await this.updateSessionStatus(sessionId, 'active');
    }

    // Update last activity (force immediate write on attach)
    await this.updateLastActivity(sessionId, true);

    logger.info(`🐚 [SESSION] Client attached to session ${sessionId.substring(0, 8)}... (${session.attachedClients.size} clients)${needsPtyRestart ? ' - PTY restart needed' : ''}`);

    // Return buffered output (capped to prevent WS flooding on reconnect)
    return {
      buffer: this.getReplayChunks(session),
      needsPtyRestart,
    };
  }

  /**
   * Detach a WebSocket client from a session (but keep session alive)
   */
  async detachSession(sessionId: string, ws: WebSocket): Promise<void> {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      logger.warn(`🐚 [SESSION] Cannot detach - session ${sessionId} not found`);
      return;
    }

    // Remove client from attached set
    session.attachedClients.delete(ws);

    logger.info(`🐚 [SESSION] Client detached from session ${sessionId.substring(0, 8)}... (${session.attachedClients.size} clients remaining, current status: ${session.info.status})`);

    // If no more clients attached, mark as detached (unless already terminated)
    if (session.attachedClients.size === 0 && session.info.status !== 'terminated') {
      logger.info(`🐚 [SESSION] No more clients attached, updating status to detached for session ${sessionId.substring(0, 8)}...`);
      await this.updateSessionStatus(sessionId, 'detached');
    }

    // Update last activity (force immediate write on detach)
    await this.updateLastActivity(sessionId, true);
  }

  /**
   * Detach a WebSocket client from all sessions (used when client disconnects)
   */
  async detachClientFromAllSessions(ws: WebSocket): Promise<void> {
    const sessionsToDetach: string[] = [];
    
    // Find all sessions this client is attached to
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.attachedClients.has(ws)) {
        sessionsToDetach.push(sessionId);
      }
    }

    if (sessionsToDetach.length > 0) {
      logger.info(`🔄 [SESSION] Detaching client from ${sessionsToDetach.length} session(s): ${sessionsToDetach.map(s => s.substring(0, 8)).join(', ')}`);
    } else {
      logger.info(`🔄 [SESSION] Client not attached to any sessions, nothing to detach`);
    }

    // Detach from each session
    for (const sessionId of sessionsToDetach) {
      try {
        await this.detachSession(sessionId, ws);
      } catch (error) {
        logger.error(`🐚 [SESSION] Error detaching client from session ${sessionId}:`, error);
      }
    }

    if (sessionsToDetach.length > 0) {
      logger.info(`🐚 [SESSION] Client detached from ${sessionsToDetach.length} session(s) on disconnect`);
    }
  }

  /**
   * Terminate a session (kill PTY, cleanup resources)
   */
  async terminateSession(sessionId: string): Promise<void> {
    logger.info(`🐚 [SESSION] 🗑️ terminateSession() called for ${sessionId.substring(0, 8)}...`);
    
    // Load from database if not in memory (handles detached/stale sessions)
    let session = this.sessions.get(sessionId);
    if (!session) {
      logger.warn(`🐚 [SESSION] 🗑️ Session ${sessionId.substring(0, 8)}... not in memory, loading from database`);
      const loaded = await this.loadSessionFromDatabase(sessionId);
      if (!loaded) {
        logger.warn(`🐚 [SESSION] 🗑️ Session ${sessionId.substring(0, 8)}... not found in database either`);
        // Still update database in case it exists
        const now = new Date();
        const updateResult = await query(
          `UPDATE shell_sessions SET status = 'terminated', terminated_at = $1 WHERE session_id = $2`,
          [now, sessionId]
        );
        logger.info(`🐚 [SESSION] 🗑️ Direct database UPDATE - rowCount: ${updateResult.rowCount}`);
        return;
      }
      session = this.sessions.get(sessionId);
    }

    if (!session) {
      logger.warn(`🐚 [SESSION] 🗑️ Cannot terminate - session ${sessionId} could not be loaded`);
      return;
    }

    logger.info(`🐚 [SESSION] 🗑️ Updating session status to 'terminated'`);
    // Update status
    await this.updateSessionStatus(sessionId, 'terminated');
    session.info.terminatedAt = new Date();

    logger.info(`🐚 [SESSION] 🗑️ Updating database with terminated_at timestamp`);
    // Update database
    const updateResult = await query(
      `UPDATE shell_sessions SET terminated_at = $1 WHERE session_id = $2`,
      [session.info.terminatedAt, sessionId]
    );
    logger.info(`🐚 [SESSION] 🗑️ Database UPDATE executed - rowCount: ${updateResult.rowCount}`);

    const activeSessionId = this.activePtySession.get(session.info.deviceUuid);
    if (activeSessionId === sessionId) {
      logger.info(`🐚 [SESSION] 🗑️ Clearing active PTY session for device`);
      this.activePtySession.delete(session.info.deviceUuid);
    }

    logger.info(`🐚 [SESSION] 🗑️ Closing ${session.attachedClients.size} attached client(s)`);
    // Close all attached clients
    session.attachedClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'session-terminated',
          sessionId,
          message: 'Session has been terminated',
        }));
      }
    });
    session.attachedClients.clear();

    logger.info(`🐚 [SESSION] 🗑️ Session ${sessionId.substring(0, 8)}... terminated successfully`);
  }

  /**
   * Terminate all sessions for a user on a device (or all sessions if no userId specified)
   */
  async terminateAllSessions(deviceUuid: string, userId?: string): Promise<void> {
    logger.info(`🐚 [SESSION] 🗑️ terminateAllSessions() called for device ${deviceUuid.substring(0, 8)}...${userId ? ' and user ' + userId : ''}`);
    
    // Query database for all sessions (not just memory) to ensure we catch detached/stale sessions
    const allSessions = await this.listSessions(deviceUuid, true); // Include terminated to see full picture
    logger.info(`🐚 [SESSION] 🗑️ Total device sessions in database: ${allSessions.length}`);
    
    const sessionsToTerminate = allSessions.filter(s => {
      const isTerminated = s.status === 'terminated';
      const userMatch = !userId || !s.userId || s.userId === userId;
      const shouldTerminate = !isTerminated && userMatch;
      
      logger.info(`🐚 [SESSION] 🗑️   Session ${s.sessionId.substring(0, 8)}... status=${s.status} userId=${s.userId || 'none'} shouldTerminate=${shouldTerminate}`);
      
      return shouldTerminate;
    });

    if (sessionsToTerminate.length === 0) {
      logger.info(`🐚 [SESSION] 🗑️ No sessions to terminate for device ${deviceUuid.substring(0, 8)}...${userId ? ' and user ' + userId : ''}`);
      return;
    }

    logger.info(`🐚 [SESSION] 🗑️ Will terminate ${sessionsToTerminate.length} session(s)`);

    // Terminate all matching sessions (kept in DB for audit purposes)
    for (const session of sessionsToTerminate) {
      logger.info(`🐚 [SESSION] 🗑️ Terminating session ${session.sessionId.substring(0, 8)}...`);
      await this.terminateSession(session.sessionId);
      logger.info(`🐚 [SESSION] 🗑️ Session ${session.sessionId.substring(0, 8)}... terminated (kept in DB for audit)`);
    }

    logger.info(`🐚 [SESSION] 🗑️ terminateAllSessions() completed - ${sessionsToTerminate.length} sessions marked as terminated`);
  }

  /**
   * Append output to session buffer
   * Stores raw chunks to preserve ANSI escape sequences
   * Debounces lastActivity DB writes to prevent hammering on high-frequency output
   */
  appendToBuffer(sessionId: string, output: string): void {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      logger.warn(`🐚 [SESSION] Cannot append - session ${sessionId} not found`);
      return;
    }

    if (session.info.status === 'terminated') {
      logger.debug(`🐚 [SESSION] Ignoring output for terminated session ${sessionId.substring(0, 8)}...`);
      return;
    }

    // Store raw chunks (don't split by \n - preserves ANSI escape sequences)
    const outputBytes = Buffer.byteLength(output, 'utf8');
    session.buffer.chunks.push(output);
    session.buffer.totalBytes += outputBytes;

    // Circular buffer: trim by max chunks
    while (session.buffer.chunks.length > session.buffer.maxChunks) {
      const removed = session.buffer.chunks.shift();
      if (removed) {
        session.buffer.totalBytes -= Buffer.byteLength(removed, 'utf8');
      }
    }

    // Also trim by max bytes
    while (session.buffer.totalBytes > session.buffer.maxBytes && session.buffer.chunks.length > 0) {
      const removed = session.buffer.chunks.shift();
      if (removed) {
        session.buffer.totalBytes -= Buffer.byteLength(removed, 'utf8');
      }
    }

    // Debounced lastActivity update (prevent DB hammering on high-frequency output like journalctl -f)
    const now = Date.now();
    if (now - session.lastActivityWriteTime > this.ACTIVITY_UPDATE_DEBOUNCE_MS) {
      this.updateLastActivityDebounced(sessionId, now);
    } else {
      // Update in-memory timestamp without DB write
      session.info.lastActivity = new Date(now);
    }
  }

  /**
   * Get session buffer (raw chunks)
   */
  getSessionBuffer(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    return session ? session.buffer.chunks : [];
  }

  /**
   * Get capped replay chunks (prevent flooding on attach)
   * Enforces REPLAY_MAX_CHUNKS and REPLAY_MAX_BYTES limits
   */
  private getReplayChunks(session: ActiveSession): string[] {
    const chunks = session.buffer.chunks;
    
    // If buffer is within limits, return all
    if (chunks.length <= this.REPLAY_MAX_CHUNKS && session.buffer.totalBytes <= this.REPLAY_MAX_BYTES) {
      return chunks;
    }

    // Cap by chunk count from the end
    const cappedByCount = chunks.slice(-this.REPLAY_MAX_CHUNKS);

    // Also enforce byte limit
    const result: string[] = [];
    let totalBytes = 0;

    for (let i = cappedByCount.length - 1; i >= 0; i--) {
      const chunk = cappedByCount[i];
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      
      if (totalBytes + chunkBytes > this.REPLAY_MAX_BYTES) {
        break;
      }
      
      result.unshift(chunk);
      totalBytes += chunkBytes;
    }

    logger.info(`🐚 [SESSION] Replay capped: ${chunks.length} chunks (${session.buffer.totalBytes} bytes) → ${result.length} chunks (${totalBytes} bytes)`);

    return result;
  }

  /**
   * Get all attached clients for a session
   */
  getAttachedClients(sessionId: string): Set<WebSocket> {
    const session = this.sessions.get(sessionId);
    return session ? session.attachedClients : new Set();
  }

  /**
   * List sessions for a device (or all sessions)
   */
  async listSessions(deviceUuid?: string, includeTerminated = false): Promise<SessionInfo[]> {
    let sqlQuery = `SELECT * FROM shell_sessions WHERE 1=1`;
    const params: any[] = [];

    if (deviceUuid) {
      params.push(deviceUuid);
      sqlQuery += ` AND device_uuid = $${params.length}`;
    }

    // Exclude terminated sessions by default (for audit, they stay in DB)
    if (!includeTerminated) {
      sqlQuery += ` AND status != 'terminated'`;
    }

    sqlQuery += ` ORDER BY last_activity DESC`;

    logger.info(`🐚 [SESSION] 🗑️ Executing listSessions SQL: ${sqlQuery}`);
    const result = await query(sqlQuery, params);
    logger.info(`🐚 [SESSION] 🗑️ listSessions returned ${result.rows.length} rows from database (includeTerminated=${includeTerminated})`);
    
    const sessions = result.rows.map(row => {
      logger.info(`🐚 [SESSION] 🗑️   - ${row.session_id.substring(0, 8)}... status=${row.status} terminated_at=${row.terminated_at}`);
      return {
        sessionId: row.session_id,
        deviceUuid: row.device_uuid,
        userId: row.user_id,
        status: row.status,
        createdAt: row.created_at,
        lastActivity: row.last_activity,
        terminatedAt: row.terminated_at,
        metadata: row.metadata,
      };
    });

    return sessions;
  }

  /**
   * Get device sessions from memory
   */
  getDeviceSessions(deviceUuid: string): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    
    this.sessions.forEach(session => {
      if (session.info.deviceUuid === deviceUuid) {
        sessions.push(session.info);
      }
    });

    return sessions;
  }

  /**
   * Mark PTY as active for a session
   */
  setPtyActive(sessionId: string, active: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.devicePtyActive = active;
      if (active) {
        this.activePtySession.set(session.info.deviceUuid, sessionId);
      } else {
        const currentSessionId = this.activePtySession.get(session.info.deviceUuid);
        if (currentSessionId === sessionId) {
          this.activePtySession.delete(session.info.deviceUuid);
        }
      }
      if (active && !session.ptyStartedAt) {
        session.ptyStartedAt = new Date();
        logger.info(`🐚 [SESSION] PTY started for session ${sessionId.substring(0, 8)}...`);
      } else if (!active) {
        logger.warn(`🐚 [SESSION] PTY stopped for session ${sessionId.substring(0, 8)}...`);
      }
    }
  }

  /**
   * Check if PTY is active for a session
   */
  isPtyActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session ? session.devicePtyActive : false;
  }

  /**
   * Update session status in database and memory
   */
  private async updateSessionStatus(sessionId: string, status: SessionInfo['status']): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.info.status = status;
    }

    logger.info(`🐚 [SESSION] 🗑️ Executing SQL: UPDATE shell_sessions SET status = '${status}' WHERE session_id = '${sessionId.substring(0, 8)}...'`);
    const updateResult = await query(
      `UPDATE shell_sessions SET status = $1 WHERE session_id = $2`,
      [status, sessionId]
    );
    logger.info(`🐚 [SESSION] 🗑️ Status UPDATE executed - rowCount: ${updateResult.rowCount}`);
  }

  /**
   * Update last activity timestamp
   * @param force - Force immediate DB write (for attach/detach), otherwise debounced
   */
  private async updateLastActivity(sessionId: string, force = false): Promise<void> {
    const now = Date.now();
    const session = this.sessions.get(sessionId);
    
    if (!session) return;

    const timestamp = new Date(now);
    session.info.lastActivity = timestamp;

    // Only write to DB if forced or debounce period elapsed
    if (force || now - session.lastActivityWriteTime > this.ACTIVITY_UPDATE_DEBOUNCE_MS) {
      session.lastActivityWriteTime = now;
      await query(
        `UPDATE shell_sessions SET last_activity = $1 WHERE session_id = $2`,
        [timestamp, sessionId]
      );
    }
  }

  /**
   * Debounced activity update (called from appendToBuffer)
   */
  private updateLastActivityDebounced(sessionId: string, now: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastActivityWriteTime = now;
    const timestamp = new Date(now);

    // Fire-and-forget DB update (don't await)
    query(
      `UPDATE shell_sessions SET last_activity = $1 WHERE session_id = $2`,
      [timestamp, sessionId]
    ).catch(err => {
      logger.error(`🐚 [SESSION] Failed to update last activity: ${err.message}`);
    });
  }

  /**
   * Load session from database into memory
   */
  private async loadSessionFromDatabase(sessionId: string): Promise<boolean> {
    const result = await query(
      `SELECT * FROM shell_sessions WHERE session_id = $1`,
      [sessionId]
    );

    if (result.rows.length === 0) {
      return false;
    }

    const row = result.rows[0];
    const sessionInfo: SessionInfo = {
      sessionId: row.session_id,
      deviceUuid: row.device_uuid,
      userId: row.user_id,
      status: row.status,
      createdAt: row.created_at,
      lastActivity: row.last_activity,
      terminatedAt: row.terminated_at,
      metadata: row.metadata,
    };

    const activeSession: ActiveSession = {
      info: sessionInfo,
      buffer: {
        chunks: [],
        totalBytes: 0,
        maxChunks: this.BUFFER_MAX_CHUNKS,
        maxBytes: this.BUFFER_MAX_BYTES,
      },
      attachedClients: new Set(),
      devicePtyActive: false,
      lastActivityWriteTime: 0, // Init to 0 so first activity always writes to DB
    };

    this.sessions.set(sessionId, activeSession);

    logger.info(`🐚 [SESSION] Loaded session ${sessionId.substring(0, 8)}... from database`);

    return true;
  }

  /**
   * Cleanup job: terminate inactive sessions and delete old terminated sessions
   */
  private startCleanupJob(): void {
    if (this.cleanupInterval) {
      return;
    }

    this.cleanupInterval = setInterval(() => {
      this.runCleanup();
    }, this.CLEANUP_INTERVAL_MS);

    logger.info(`🐚 [SESSION] Started cleanup job (interval: ${this.CLEANUP_INTERVAL_MS}ms, timeout: ${this.SESSION_TIMEOUT_MINUTES}min)`);
  }

  /**
   * Run cleanup: terminate stale sessions, delete old ones
   */
  private async runCleanup(): Promise<void> {
    const now = new Date();
    const timeoutMs = this.SESSION_TIMEOUT_MINUTES * 60 * 1000;

    // Find sessions to terminate (use Set to avoid duplicates)
    const sessionsToTerminate = new Set<string>();
    
    this.sessions.forEach((session, sessionId) => {
      if (session.info.status !== 'terminated') {
        const inactiveMs = now.getTime() - session.info.lastActivity.getTime();
        
        // Terminate if inactive > timeout
        if (inactiveMs > timeoutMs) {
          sessionsToTerminate.add(sessionId);
        }
        
        // Terminate if PTY never started (grace period exceeded)
        if (!session.devicePtyActive && session.info.status === 'active') {
          const timeSinceCreation = now.getTime() - session.info.createdAt.getTime();
          if (timeSinceCreation > this.PTY_STARTUP_GRACE_PERIOD_MS) {
            logger.warn(`🐚 [SESSION] PTY never started for ${sessionId.substring(0, 8)}... - terminating`);
            sessionsToTerminate.add(sessionId);
          }
        }
      }
    });

    // Terminate inactive sessions
    for (const sessionId of sessionsToTerminate) {
      logger.info(`🐚 [SESSION] Auto-terminating inactive session ${sessionId.substring(0, 8)}...`);
      await this.terminateSession(sessionId);
    }

    // Delete old terminated sessions (> 1 hour old)
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    const deleteResult = await query(
      `DELETE FROM shell_sessions 
       WHERE status = 'terminated' 
       AND terminated_at < $1
       RETURNING session_id`,
      [oneHourAgo]
    );

    if (deleteResult.rows.length > 0) {
      // Remove from memory
      deleteResult.rows.forEach(row => {
        this.sessions.delete(row.session_id);
      });

      logger.info(`🐚 [SESSION] Deleted ${deleteResult.rows.length} old terminated sessions`);
    }

    if (sessionsToTerminate.size > 0 || deleteResult.rows.length > 0) {
      logger.info(`🐚 [SESSION] Cleanup complete: ${sessionsToTerminate.size} terminated, ${deleteResult.rows.length} deleted`);
    }
  }

  /**
   * Shutdown: cleanup all resources
   */
  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Terminate all active sessions
    const activeSessionIds = Array.from(this.sessions.keys());
    for (const sessionId of activeSessionIds) {
      await this.terminateSession(sessionId);
    }

    this.sessions.clear();

    logger.info('🐚 [SESSION] Shutdown complete');
  }
}

export const sessionManager = new SessionManager();
