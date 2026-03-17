import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger';
import { SensorDataEntry } from './types';
import { metrics } from './metrics';
import { circuitBreaker, CircuitState } from './circuit-breaker';

export class DiskSpool {
  private currentFile: string | null = null;
  private currentSize = 0;
  private fileIndex = 0;
  private replayInterval: NodeJS.Timeout | null = null;
  private enabled = false;

  constructor(
    private readonly spoolPath: string,
    private readonly maxSizeMb: number,
  ) {}

  async initialize(): Promise<void> {
    try {
      if (!fsSync.existsSync(this.spoolPath)) {
        await fs.mkdir(this.spoolPath, { recursive: true });
        logger.info('Created disk spool directory', { path: this.spoolPath });
      }
      this.enabled = true;
      logger.info('Disk spool fallback initialized', {
        path: this.spoolPath,
        maxSizeMb: this.maxSizeMb,
      });
    } catch (err: any) {
      logger.error('Failed to initialize disk spool', { error: err.message });
      this.enabled = false;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async spoolToDisk(sensorData: SensorDataEntry[]): Promise<void> {
    try {
      const payload = JSON.stringify(sensorData);
      const payloadSize = Buffer.byteLength(payload, 'utf8');

      const totalSpoolSize = await this.getTotalSize();
      if (totalSpoolSize + payloadSize > this.maxSizeMb * 1024 * 1024) {
        await this.deleteOldestFile();
      }

      if (!this.currentFile || this.currentSize > 10 * 1024 * 1024) {
        this.fileIndex++;
        this.currentFile = path.join(this.spoolPath, `spool-${this.fileIndex}.ndjson`);
        this.currentSize = 0;
      }

      await fs.appendFile(this.currentFile, payload + '\n');
      this.currentSize += payloadSize;

      logger.debug('Spooled device data to disk', {
        count: sensorData.length,
        file: path.basename(this.currentFile),
        sizeBytes: payloadSize,
        totalSpoolMb: Math.round(totalSpoolSize / 1024 / 1024),
      });
    } catch (err: any) {
      logger.error('Failed to spool to disk - data lost', {
        count: sensorData.length,
        error: err.message,
      });
      metrics.messagesDropped += sensorData.length;
    }
  }

  /**
   * Start background replayer that drains spool files to Redis when circuit is closed.
   * The onBatch callback is the queue's add() — provided by the caller to avoid circular deps.
   */
  startReplayer(onBatch: (data: SensorDataEntry[]) => Promise<void>): void {
    this.replayInterval = setInterval(async () => {
      if (circuitBreaker.getState() !== CircuitState.CLOSED) return;

      try {
        const files = (await fs.readdir(this.spoolPath))
          .filter(f => f.startsWith('spool-'))
          .sort();

        if (files.length === 0) return;

        const oldestFile = path.join(this.spoolPath, files[0]);
        const content = await fs.readFile(oldestFile, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());

        logger.info('Replaying spooled data to Redis', {
          file: files[0],
          batches: lines.length,
          totalSpooledFiles: files.length,
        });

        for (const line of lines) {
          try {
            const sensorData = JSON.parse(line) as SensorDataEntry[];
            await onBatch(sensorData);
          } catch (err: any) {
            logger.error('Failed to replay spooled batch', { error: err.message });
          }
        }

        await fs.unlink(oldestFile);
        logger.info('Replayed and deleted spool file', { file: files[0] });
      } catch (err: any) {
        logger.error('Spool replay error', { error: err.message });
      }
    }, 10000);
  }

  private async getTotalSize(): Promise<number> {
    try {
      const files = await fs.readdir(this.spoolPath);
      const sizes = await Promise.all(
        files.map(file => fs.stat(path.join(this.spoolPath, file)).then(s => s.size).catch(() => 0)),
      );
      return sizes.reduce((total, size) => total + size, 0);
    } catch {
      return 0;
    }
  }

  private async deleteOldestFile(): Promise<void> {
    try {
      const files = (await fs.readdir(this.spoolPath))
        .filter(f => f.startsWith('spool-'))
        .sort();

      if (files.length > 0) {
        const oldestFile = path.join(this.spoolPath, files[0]);
        await fs.unlink(oldestFile);
        logger.info('Deleted oldest spool file (disk full)', { file: files[0] });
      }
    } catch (err: any) {
      logger.error('Failed to delete oldest spool file', { error: err.message });
    }
  }
}
