/**
 * Log inserter: writes a batch of agent log entries into agent_logs.
 * Uses COPY protocol (fast path) with a batch INSERT fallback.
 */

import { Readable } from 'stream';
import { from as copyFrom } from 'pg-copy-streams';
import { pool, query } from '../db/connection';
import logger from '../utils/logger';

export interface LogEntry {
  deviceUuid: string;
  serviceName?: string;
  timestamp?: Date;
  message: string;
  level?: string;
  isSystem?: boolean;
  isStderr?: boolean;
  meta?: Record<string, unknown> | null;
}

export class LogInserter {
  async insertBatch(logs: LogEntry[]): Promise<void> {
    if (logs.length === 0) return;

    try {
      await this.insertBatchCopy(logs);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('COPY failed for agent_logs, falling back to INSERT', { error: msg, count: logs.length });
      await this.insertBatchInsert(logs);
    }
  }

  private async insertBatchCopy(logs: LogEntry[]): Promise<void> {
    const client = await pool.connect();

    try {
      const csvData = logs.map(log => {
        const message = (log.message || '[empty log message]')
          .replace(/\t/g, ' ')
          .replace(/\n/g, '\\n');
        const serviceName = (log.serviceName || '\\N').replace(/\t/g, ' ');
        const timestamp = (log.timestamp || new Date()).toISOString();
        const level = log.level || 'info';
        const isSystem = log.isSystem ? 't' : 'f';
        const isStderr = log.isStderr ? 't' : 'f';
        const meta = log.meta
          ? JSON.stringify(log.meta)
              .replace(/\\/g, '\\\\')
              .replace(/\t/g, ' ')
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r')
          : '\\N';

        return `${log.deviceUuid}\t${serviceName}\t${timestamp}\t${message}\t${level}\t${isSystem}\t${isStderr}\t${meta}`;
      }).join('\n');

      const stream = Readable.from([csvData]);
      const copyStream = (client as Parameters<typeof copyFrom>[0] & { query: (s: ReturnType<typeof copyFrom>) => NodeJS.WritableStream }).query(
        copyFrom(`COPY agent_logs (agent_uuid, service_name, timestamp, message, level, is_system, is_stderr, meta) FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '\\N')`)
      );

      await new Promise<void>((resolve, reject) => {
        stream.pipe(copyStream).on('finish', resolve).on('error', reject);
      });
    } finally {
      client.release();
    }
  }

  private async insertBatchInsert(logs: LogEntry[]): Promise<void> {
    const chunkSize = 500;
    const chunks: LogEntry[][] = [];
    for (let i = 0; i < logs.length; i += chunkSize) {
      chunks.push(logs.slice(i, i + chunkSize));
    }

    await Promise.all(
      chunks.map(async (chunk) => {
        const values: unknown[] = [];
        const placeholders = chunk.map((log, index) => {
          const offset = index * 8;
          values.push(
            log.deviceUuid,
            log.serviceName ?? null,
            log.timestamp ?? new Date(),
            log.message || '[empty log message]',
            log.level ?? 'info',
            log.isSystem ?? false,
            log.isStderr ?? false,
            log.meta ? JSON.stringify(log.meta) : null,
          );
          return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`;
        });

        await query(
          `INSERT INTO agent_logs (agent_uuid, service_name, timestamp, message, level, is_system, is_stderr, meta) VALUES ${placeholders.join(', ')}`,
          values,
        );
      }),
    );
  }
}
