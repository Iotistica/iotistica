import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { DeviceDataEntry } from './types';
import { metrics } from './metrics';
import { dbCircuitBreaker, CircuitState } from './circuit-breaker';

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

      // Verify the process can actually write to the directory.
      // Docker named volumes are created as root by default — if the Dockerfile
      // did not pre-create the path owned by appuser the write will fail with EACCES.
      const testFile = path.join(this.spoolPath, '.write-test');
      await fs.writeFile(testFile, '');
      await fs.unlink(testFile);

      // Seed fileIndex from existing files so new files are created at a higher
      // index than any leftover spool files from a previous run. Without this,
      // after a restart fileIndex resets to 0 and new spool-1, spool-2... files
      // sort before spool-N from the previous run, causing the replayer to process
      // new files in an endless loop while old files are stuck at the back.
      try {
        const existing = await fs.readdir(this.spoolPath);
        const maxIndex = existing
          .map(f => { const m = f.match(/^spool-(\d+)\.ndjson$/); return m ? parseInt(m[1], 10) : 0; })
          .reduce((max, n) => Math.max(max, n), 0);
        if (maxIndex > 0) {
          this.fileIndex = maxIndex;
          logger.debug('Seeded spool fileIndex from existing files', { fileIndex: this.fileIndex });
        }
      } catch {
        // Non-fatal — will start from 0
      }

      this.enabled = true;
      logger.info('Disk spool initialized', {
        path: this.spoolPath,
        maxSizeMb: this.maxSizeMb,
      });
    } catch (err: any) {
      logger.error(
        'Failed to initialize disk spool — spool disabled, circuit-breaker fallback will drop data.' +
        ' Ensure the spool directory is writable by the container user.' +
        ' If using a Docker named volume, recreate it after rebuilding the image.',
        { path: this.spoolPath, error: err.message },
      );
      this.enabled = false;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async spoolToDisk(deviceData: DeviceDataEntry[]): Promise<void> {
    const payload = JSON.stringify(deviceData);
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

    // Let errors (EACCES, ENOSPC, etc.) propagate to the caller.
    // fallbackToDiskOrDrop owns the decision of what to log and count.
    await fs.appendFile(this.currentFile, payload + '\n');
    this.currentSize += payloadSize;

    logger.debug('Spooled device data to disk', {
      count: deviceData.length,
      file: path.basename(this.currentFile),
      sizeBytes: payloadSize,
      totalSpoolMb: Math.round(totalSpoolSize / 1024 / 1024),
    });
  }

  /**
   * Start background replayer that drains spool files to Redis when circuit is closed.
   * The onBatch callback is the queue's add() — provided by the caller to avoid circular deps.
   */
  startReplayer(onBatch: (data: DeviceDataEntry[]) => Promise<unknown>, isReady?: () => boolean): void {
    this.replayInterval = setInterval(async () => {
      if (dbCircuitBreaker.getState() !== CircuitState.CLOSED) return;
      // Skip if the underlying Redis client isn't actually connected yet.
      // The circuit can be CLOSED while ioredis is still in reconnecting state,
      // which would cause onBatch → spoolToDisk → unlink(same file) data loss.
      if (isReady && !isReady()) return;

      try {
        const files = (await fs.readdir(this.spoolPath))
          .filter(f => f.startsWith('spool-'))
          .sort((a, b) => {
            const ai = parseInt(a.match(/^spool-(\d+)/)?.[1] ?? '0', 10);
            const bi = parseInt(b.match(/^spool-(\d+)/)?.[1] ?? '0', 10);
            return ai - bi;
          });

        if (files.length === 0) return;

        const oldestFile = path.join(this.spoolPath, files[0]);
        const content = await fs.readFile(oldestFile, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());

        logger.debug('Replaying spooled data to Redis', {
          file: files[0],
          batches: lines.length,
          totalSpooledFiles: files.length,
        });

        // Delete the spool file BEFORE calling onBatch so that any re-spool
        // (if Redis fails mid-replay) writes to a fresh file rather than
        // appending to the file we're about to delete — which would lose that data.
        await fs.unlink(oldestFile);
        if (this.currentFile === oldestFile) {
          this.currentFile = null;
        }

        for (const line of lines) {
          try {
            const deviceData = JSON.parse(line) as DeviceDataEntry[];
            await onBatch(deviceData);
          } catch (err: any) {
            logger.error('Failed to replay spooled batch', { error: err.message });
          }
        }

        logger.debug('Replayed and deleted spool file', { file: files[0] });
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

  async getBacklogCount(): Promise<number> {
    if (!this.enabled) return 0;
    try {
      const files = await fs.readdir(this.spoolPath);
      return files.filter(f => f.startsWith('spool-')).length;
    } catch {
      return 0;
    }
  }

  private async deleteOldestFile(): Promise<void> {
    try {
      const files = (await fs.readdir(this.spoolPath))
        .filter(f => f.startsWith('spool-'))
        .sort((a, b) => {
          const ai = parseInt(a.match(/^spool-(\d+)/)?.[1] ?? '0', 10);
          const bi = parseInt(b.match(/^spool-(\d+)/)?.[1] ?? '0', 10);
          return ai - bi;
        });

      if (files.length > 0) {
        const oldestFile = path.join(this.spoolPath, files[0]);
        await fs.unlink(oldestFile);
        logger.warn('Deleted oldest spool file (disk full)', { file: files[0] });
      }
    } catch (err: any) {
      logger.error('Failed to delete oldest spool file', { error: err.message });
    }
  }
}
