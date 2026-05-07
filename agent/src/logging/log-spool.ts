import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { LogBatch, AckCursor } from './types';

export interface SpoolConfig {
	spoolPath: string;
	/** Max active spool file size before rotation (bytes) */
	maxSpoolSizeMb: number;
	/** Max total size across all spool segment files (bytes) */
	maxTotalSpoolSizeMb: number;
}

/**
 * LogSpool
 * ========
 * Disk-backed durability layer for the cloud log pipeline.
 *
 * Responsibilities:
 * - Append log batches to an NDJSON spool file (write coalescing to reduce flash wear)
 * - Rotate the active file when it exceeds the per-file size cap
 * - Enforce a total disk cap by dropping oldest rotated segments first
 * - Persist an ACK cursor so replayed batches are not re-sent after restart
 * - Replay unsent batches on startup, returning them for the caller to re-queue
 *
 * All I/O is async to prevent event-loop stalls on slow flash storage.
 */
export class LogSpool {
	private readonly spoolPath: string;
	private readonly spoolFilePath: string;
	private readonly spoolCursorPath: string;
	private readonly maxSpoolSize: number;
	private readonly maxTotalSpoolSize: number;

	// Write coalescing: accumulate small writes and flush in one append
	private spoolWriteChunks: string[] = [];
	private spoolWriteBufferBytes: number = 0;
	private spoolWriteTimer?: NodeJS.Timeout;
	private spoolWriteFlushPromise?: Promise<void>;
	private spoolActiveBytes: number = 0;
	private spoolActiveSizeKnown: boolean = false;

	private readonly SPOOL_WRITE_FLUSH_MS = 1000;      // 1 s write coalescing window
	private readonly SPOOL_WRITE_FLUSH_BYTES = 64 * 1024; // flush early at 64 KB

	constructor(config: SpoolConfig) {
		this.spoolPath         = config.spoolPath;
		this.spoolFilePath     = path.join(config.spoolPath, 'buffer.ndjson');
		this.spoolCursorPath   = path.join(config.spoolPath, 'cursor.json');
		this.maxSpoolSize      = config.maxSpoolSizeMb * 1024 * 1024;
		this.maxTotalSpoolSize = config.maxTotalSpoolSizeMb * 1024 * 1024;
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/** Create the spool directory and enforce the total size cap. */
	async initialize(): Promise<void> {
		await fsp.mkdir(this.spoolPath, { recursive: true });
		await this.enforceCapCap();
	}

	/**
	* Append batches to the spool file (via write coalescing buffer).
	* Called before sending so data survives a crash between write and ACK.
	*/
	async write(batches: LogBatch[]): Promise<void> {
		try {
			const batchLines = batches.map(b => JSON.stringify(b)).join('\n') + '\n';

			this.spoolWriteChunks.push(batchLines);
			this.spoolWriteBufferBytes += Buffer.byteLength(batchLines, 'utf8');

			if (this.spoolWriteBufferBytes >= this.SPOOL_WRITE_FLUSH_BYTES) {
				await this.flushWriteBuffer();
			} else if (!this.spoolWriteTimer) {
				this.spoolWriteTimer = setTimeout(() => {
					this.spoolWriteTimer = undefined;
					void this.flushWriteBuffer();
				}, this.SPOOL_WRITE_FLUSH_MS);
			}
		} catch (error) {
			console.error(`[CloudLog] Failed to write to spool: ${error}`);
		}
	}

	/** Flush any buffered writes to disk immediately. */
	async flushWriteBuffer(): Promise<void> {
		if (this.spoolWriteFlushPromise) {
			await this.spoolWriteFlushPromise;
			return;
		}

		if (this.spoolWriteBufferBytes === 0) {
			if (this.spoolWriteTimer) {
				clearTimeout(this.spoolWriteTimer);
				this.spoolWriteTimer = undefined;
			}
			return;
		}

		if (this.spoolWriteTimer) {
			clearTimeout(this.spoolWriteTimer);
			this.spoolWriteTimer = undefined;
		}

		const payload      = this.spoolWriteChunks.join('');
		const payloadBytes = this.spoolWriteBufferBytes;

		// Reset queue before I/O so producers can continue buffering.
		this.spoolWriteChunks       = [];
		this.spoolWriteBufferBytes  = 0;

		this.spoolWriteFlushPromise = (async () => {
			try {
				if (!this.spoolActiveSizeKnown) {
					try {
						const stats = await fsp.stat(this.spoolFilePath);
						this.spoolActiveBytes = stats.size;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
						this.spoolActiveBytes = 0;
					}
					this.spoolActiveSizeKnown = true;
				}

				await fsp.appendFile(this.spoolFilePath, payload, 'utf8');
				this.spoolActiveBytes += payloadBytes;

				if (this.spoolActiveBytes > this.maxSpoolSize) {
					await this.rotate();
				}

				await this.enforceCapCap();
			} catch (error) {
				// Re-queue on failure to avoid data loss.
				this.spoolWriteChunks.unshift(payload);
				this.spoolWriteBufferBytes += payloadBytes;
				console.error(`[CloudLog] Failed to flush spool write buffer: ${error}`);
			}
		})();

		try {
			await this.spoolWriteFlushPromise;
		} finally {
			this.spoolWriteFlushPromise = undefined;
		}
	}

	/**
	* Replay unsent batches from the spool into memory.
	*
	* Returns a Map of batchId → LogBatch for the caller to restore into
	* `pendingBatches`. Does NOT schedule a flush — that is the caller's job.
	*/
	async replay(): Promise<Map<string, LogBatch>> {
		const result: Map<string, LogBatch> = new Map();

		try {
			await this.flushWriteBuffer();
			const ackCursor   = await this.loadAckCursor();
			const spoolFiles  = await this.getSpoolFiles();

			if (spoolFiles.length === 0) {
				return result;
			}

			console.log('[CloudLog] Replaying spooled batches', {
				spoolFiles:      spoolFiles.map(f => path.basename(f)),
				lastAckBatchId:  ackCursor.lastAckBatchId || 'none',
			});

			let replayedCount = 0;
			let skippedCount  = 0;

			for (const spoolFile of spoolFiles) {
				for await (const line of this.streamSpoolLines(spoolFile)) {
					try {
						const batch: LogBatch = JSON.parse(line);

						if (this.isBatchAcked(batch.batchId, ackCursor)) {
							skippedCount++;
							continue;
						}

						result.set(batch.batchId, batch);
						replayedCount++;
					} catch {
						process.stderr.write(`[CloudLog] Skipping corrupted spool entry in ${path.basename(spoolFile)}\n`);
					}
				}
			}

			console.log(`[CloudLog] Replayed ${replayedCount} batches, skipped ${skippedCount} ACKed batches`);
		} catch (error) {
			console.error(`[CloudLog] Failed to replay spooled logs: ${error}`);
		}

		return result;
	}

	/** Remove all spool segment files after every pending batch has been ACKed. */
	async clear(): Promise<void> {
		try {
			await this.flushWriteBuffer();
			const spoolFiles = await this.getSpoolFiles();
			for (const file of spoolFiles) {
				await fsp.unlink(file);
			}
			this.spoolActiveBytes     = 0;
			this.spoolActiveSizeKnown = true;
			console.log('[CloudLog] Spool cleared after successful upload', { filesRemoved: spoolFiles.length });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				console.error(`[CloudLog] Failed to clear spool: ${error}`);
			}
		}
	}

	/** Prune ACKed batches from spool segment files using the stored cursor. */
	async pruneByAcks(): Promise<void> {
		try {
			await this.flushWriteBuffer();
			const ackCursor  = await this.loadAckCursor();

			if (!ackCursor.lastAckBatchId) return;

			const spoolFiles = await this.getSpoolFiles();
			if (spoolFiles.length === 0) return;

			let totalPruned    = 0;
			let totalRemaining = 0;

			for (const spoolFile of spoolFiles) {
				const content   = await fsp.readFile(spoolFile, 'utf8');
				const lines     = content.split('\n').filter(l => l.trim());
				const remaining: string[] = [];
				let pruned = 0;

				for (const line of lines) {
					try {
						const batch: LogBatch = JSON.parse(line);
						if (this.isBatchAcked(batch.batchId, ackCursor)) {
							pruned++;
						} else {
							remaining.push(line);
						}
					} catch {
						remaining.push(line); // keep corrupted entries for later inspection
					}
				}

				totalPruned    += pruned;
				totalRemaining += remaining.length;

				if (pruned === 0) continue;

				if (remaining.length === 0) {
					await fsp.unlink(spoolFile);
					continue;
				}

				// Atomic rewrite via tmp file + rename.
				const tmpPath = spoolFile + '.tmp';
				await fsp.writeFile(tmpPath, remaining.join('\n') + '\n', 'utf8');
				await fsp.rename(tmpPath, spoolFile);
			}

			if (totalPruned > 0) {
				console.log(`[CloudLog] Pruned ${totalPruned} ACKed batches from spool (${totalRemaining} remaining)`);
			}

			// Active file size may have changed after pruning.
			this.spoolActiveSizeKnown = false;
		} catch (error) {
			console.error(`[CloudLog] Failed to prune spool: ${error}`);
		}
	}

	/** Enforce total disk cap across active + rotated segments; drops oldest data first. */
	async enforceCapCap(): Promise<void> {
		const spoolFiles = await this.getSpoolFiles();
		if (spoolFiles.length === 0) return;

		const fileInfos: Array<{ file: string; size: number; isActive: boolean }> = [];
		let totalBytes = 0;

		for (const file of spoolFiles) {
			try {
				const stats = await fsp.stat(file);
				fileInfos.push({ file, size: stats.size, isActive: file === this.spoolFilePath });
				totalBytes += stats.size;
			} catch {
				// Race with concurrent delete/rotate — ignore.
			}
		}

		if (totalBytes <= this.maxTotalSpoolSize) return;

		let bytesToDrop  = totalBytes - this.maxTotalSpoolSize;
		let droppedBytes = 0;

		// Drop oldest rotated segments first.
		for (const info of fileInfos) {
			if (bytesToDrop <= 0) break;
			if (info.isActive) continue;
			try {
				await fsp.unlink(info.file);
				bytesToDrop  -= info.size;
				droppedBytes += info.size;
			} catch {
				// Race — ignore.
			}
		}

		// If still over cap, trim oldest lines from the active spool.
		if (bytesToDrop > 0) {
			try {
				const activeContent = await fsp.readFile(this.spoolFilePath, 'utf8');
				const lines         = activeContent.split('\n').filter(l => l.trim());

				if (lines.length > 0) {
					let removeUntil  = 0;
					let removedBytes = 0;

					while (removeUntil < lines.length && removedBytes < bytesToDrop) {
						removedBytes += Buffer.byteLength(lines[removeUntil] + '\n', 'utf8');
						removeUntil++;
					}

					const remaining = lines.slice(removeUntil);
					const out       = remaining.length > 0 ? remaining.join('\n') + '\n' : '';
					const tmpPath   = this.spoolFilePath + '.tmp';
					await fsp.writeFile(tmpPath, out, 'utf8');
					await fsp.rename(tmpPath, this.spoolFilePath);

					droppedBytes          += removedBytes;
					this.spoolActiveBytes  = Buffer.byteLength(out, 'utf8');
					this.spoolActiveSizeKnown = true;
				}
			} catch (error) {
				console.error(`[CloudLog] Failed trimming active spool for cap enforcement: ${error}`);
			}
		}

		if (droppedBytes > 0) {
			process.stderr.write(`[CloudLog] Total spool cap enforced: dropped ~${Math.round(droppedBytes / 1024)} KB oldest data\n`);
		}
	}

	/**
	* Update the ACK cursor after a batch is confirmed by the server.
	* Only advances monotonically — never moves the cursor backwards.
	*/
	async updateAckCursor(batchId: string): Promise<void> {
		try {
			let cursor: AckCursor = { lastAckTime: 0 };
			try {
				const content = await fsp.readFile(this.spoolCursorPath, 'utf8');
				cursor = JSON.parse(content);
			} catch {
				// File doesn't exist yet — use defaults.
			}

			if (!cursor.lastAckBatchId || this.compareBatchIds(batchId, cursor.lastAckBatchId) > 0) {
				cursor.lastAckBatchId = batchId;
			}
			cursor.lastAckTime = Date.now();

			// Atomic write via tmp + rename.
			const tmpPath = this.spoolCursorPath + '.tmp';
			await fsp.writeFile(tmpPath, JSON.stringify(cursor), 'utf8');
			await fsp.rename(tmpPath, this.spoolCursorPath);
		} catch (error) {
			console.error(`[CloudLog] Failed to update ACK cursor: ${error}`);
		}
	}

	/** Flush pending writes and cancel timers; call on graceful shutdown. */
	async stop(): Promise<void> {
		if (this.spoolWriteTimer) {
			clearTimeout(this.spoolWriteTimer);
			this.spoolWriteTimer = undefined;
		}
		await this.flushWriteBuffer();
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	/**
	* Rotate the active spool to a timestamped segment file.
	* Never deletes unsent data — just starts a fresh active file.
	*/
	private async rotate(): Promise<void> {
		try {
			const rotatedPath = `${this.spoolFilePath}.${Date.now()}`;
			await fsp.rename(this.spoolFilePath, rotatedPath);
			this.spoolActiveBytes     = 0;
			this.spoolActiveSizeKnown = true;
			process.stderr.write(`[CloudLog] Spool rotated: ${path.basename(rotatedPath)}\n`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				console.error(`[CloudLog] Failed to rotate spool: ${error}`);
			}
		}
	}

	/** Load the stored ACK cursor from disk. Returns a zero-state cursor on any error. */
	private async loadAckCursor(): Promise<AckCursor> {
		try {
			const content      = await fsp.readFile(this.spoolCursorPath, 'utf8');
			const cursor: AckCursor = JSON.parse(content);
			return { lastAckBatchId: cursor.lastAckBatchId, lastAckTime: cursor.lastAckTime || 0 };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				console.error(`[CloudLog] Failed to load ACK cursor: ${error}`);
			}
			return { lastAckTime: 0 };
		}
	}

	/**
	* Compare two monotonic batch IDs.
	* Format: {deviceUuid}-{timestamp}-{counter}
	*/
	private compareBatchIds(a: string, b: string): number {
		const parse = (id: string) => {
			const match = id.match(/-(\d+)-(\d+)$/);
			if (!match) return null;
			return { timestamp: Number(match[1]), counter: Number(match[2]) };
		};

		const pa = parse(a);
		const pb = parse(b);

		if (!pa || !pb) return a.localeCompare(b);
		if (pa.timestamp !== pb.timestamp) return pa.timestamp - pb.timestamp;
		return pa.counter - pb.counter;
	}

	/** Returns true if the batch has already been acknowledged. */
	private isBatchAcked(batchId: string, cursor: AckCursor): boolean {
		if (!cursor.lastAckBatchId) return false;
		return this.compareBatchIds(batchId, cursor.lastAckBatchId) <= 0;
	}

	/**
	* Stream a spool segment file as non-empty NDJSON lines.
	* Avoids loading large segment files fully into memory.
	*/
	private async *streamSpoolLines(spoolFile: string): AsyncGenerator<string> {
		const stream = fs.createReadStream(spoolFile, { encoding: 'utf8' });
		const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

		try {
			for await (const line of rl) {
				const trimmed = line.trim();
				if (trimmed.length > 0) yield trimmed;
			}
		} finally {
			rl.close();
			stream.destroy();
		}
	}

	/**
	* Return all spool segment files sorted oldest → newest.
	* Rotated segments come before the active file to ensure stable replay order.
	*/
	private async getSpoolFiles(): Promise<string[]> {
		const baseName = path.basename(this.spoolFilePath);

		try {
			const entries = await fsp.readdir(this.spoolPath);
			const files   = entries.filter(n => n === baseName || n.startsWith(baseName + '.'));

			const rotated = files
				.filter(n => n !== baseName)
				.sort((a, b) => {
					const aTs = Number(a.slice((baseName + '.').length)) || 0;
					const bTs = Number(b.slice((baseName + '.').length)) || 0;
					return aTs - bTs;
				})
				.map(n => path.join(this.spoolPath, n));

			const active = files.includes(baseName) ? [path.join(this.spoolPath, baseName)] : [];
			return [...rotated, ...active];
		} catch {
			return [];
		}
	}
}
