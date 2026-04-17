/**
 * Node-RED Storage Service
 * Handles CRUD operations for Node-RED flows, credentials, settings, sessions, and library
 * Single instance storage (no device isolation)
 */

import { query } from '../../db/connection';
import logger from '../../utils/logger';
import { DeviceFlowExtractionService } from './device-flow-extraction';

interface NodeRedFlows {
  flows: any[];
  revision: number;
}

export interface NodeRedCredentials {
  credentials: Record<string, any>;
  revision?: number;
}

export interface NodeRedSettings {
  settings: Record<string, any>;
}

export interface NodeRedSessions {
  sessions: Record<string, any>;
}

export interface NodeRedLibraryEntry {
  type: string;
  name: string;
  meta?: Record<string, any>;
  body: string | Record<string, any>;
}

export class NodeRedStorageService {
  /**
   * Get flows
   */
  static async getFlows(): Promise<NodeRedFlows> {
    const result = await query(
      `SELECT flows, revision FROM nodered_flows WHERE id = 1`
    );

    if (result.rows.length === 0) {
      return { flows: [], revision: 1 };
    }

    return {
      flows: result.rows[0].flows,
      revision: result.rows[0].revision
    };
  }

  /**
   * Save flows
   */
  static async saveFlows(flows: any[]): Promise<void> {
    await query(
      `INSERT INTO nodered_flows (id, flows, revision)
       VALUES (1, $1, 1)
       ON CONFLICT (id)
       DO UPDATE SET
         flows = $1,
         revision = nodered_flows.revision + 1,
         updated_at = NOW()`,
      [JSON.stringify(flows)]
    );

    logger.info('Saved Node-RED flows', { flowCount: flows.length });

    // Extract device-specific subflows (async, non-blocking)
    DeviceFlowExtractionService.extractAndSaveDeviceFlows(flows).catch((err) => {
      logger.error('Device flow extraction failed (non-blocking)', {
        error: err.message,
        stack: err.stack
      });
    });
  }

  /**
   * Get credentials
   */
  static async getCredentials(): Promise<NodeRedCredentials> {
    const result = await query(
      `SELECT credentials, revision FROM nodered_credentials WHERE id = 1`
    );

    if (result.rows.length === 0) {
      return { credentials: {}, revision: 1 };
    }

    return {
      credentials: result.rows[0].credentials,
      revision: result.rows[0].revision
    };
  }

  /**
   * Save credentials
   */
  static async saveCredentials(credentials: Record<string, any>): Promise<void> {
    await query(
      `INSERT INTO nodered_credentials (id, credentials, revision)
       VALUES (1, $1, 1)
       ON CONFLICT (id)
       DO UPDATE SET
         credentials = $1,
         revision = nodered_credentials.revision + 1,
         updated_at = NOW()`,
      [JSON.stringify(credentials)]
    );

    logger.info('Saved Node-RED credentials');
  }

  /**
   * Get settings
   */
  static async getSettings(): Promise<NodeRedSettings> {
    const result = await query(
      `SELECT settings FROM nodered_settings WHERE id = 1`
    );

    if (result.rows.length === 0) {
      return { settings: {} };
    }

    return { settings: result.rows[0].settings };
  }

  /**
   * Save settings
   */
  static async saveSettings(settings: Record<string, any>): Promise<void> {
    await query(
      `INSERT INTO nodered_settings (id, settings)
       VALUES (1, $1)
       ON CONFLICT (id)
       DO UPDATE SET
         settings = $1,
         updated_at = NOW()`,
      [JSON.stringify(settings)]
    );

    logger.info('Saved Node-RED settings');
  }

  /**
   * Get sessions
   */
  static async getSessions(): Promise<NodeRedSessions> {
    const result = await query(
      `SELECT sessions FROM nodered_sessions WHERE id = 1`
    );

    if (result.rows.length === 0) {
      return { sessions: {} };
    }

    return { sessions: result.rows[0].sessions };
  }

  /**
   * Save sessions
   */
  static async saveSessions(sessions: Record<string, any>): Promise<void> {
    await query(
      `INSERT INTO nodered_sessions (id, sessions)
       VALUES (1, $1)
       ON CONFLICT (id)
       DO UPDATE SET
         sessions = $1,
         updated_at = NOW()`,
      [JSON.stringify(sessions)]
    );

    logger.info('Saved Node-RED sessions');
  }

  /**
   * Get library entry
   */
  static async getLibraryEntry(type: string, name: string): Promise<NodeRedLibraryEntry | null> {
    const result = await query(
      `SELECT type, name, meta, body FROM nodered_library
       WHERE type = $1 AND name = $2`,
      [type, name]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      type: row.type,
      name: row.name,
      meta: row.meta,
      body: row.body
    };
  }

  /**
   * Save library entry
   */
  static async saveLibraryEntry(
    type: string,
    name: string,
    meta: Record<string, any>,
    body: string | Record<string, any>
  ): Promise<void> {
    await query(
      `INSERT INTO nodered_library (type, name, meta, body)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (type, name)
       DO UPDATE SET
         meta = $3,
         body = $4,
         updated_at = NOW()`,
      [type, name, JSON.stringify(meta), typeof body === 'string' ? body : JSON.stringify(body)]
    );

    logger.info(`Saved Node-RED library entry: ${type}/${name}`);
  }
}
