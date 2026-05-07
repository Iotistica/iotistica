/**
 * Local Log Backend
 * 
 * Stores logs in memory with optional file-based persistence.
 * Implements log rotation and automatic cleanup.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { LogMessage, LogFilter, LogBackend } from './types';

export interface LocalLogBackendOptions {
	/** Maximum number of logs to keep in memory */
	maxLogs?: number;
	/** Auto-cleanup logs older than this (ms) */
	maxAge?: number;
	/** Enable file-based persistence */
	enableFilePersistence?: boolean;
	/** Directory for log files */
	logDir?: string;
	/** Rotate log file when it reaches this size (bytes) */
	maxFileSize?: number;
}

export class LocalLogBackend implements LogBackend {
	private logs: LogMessage[] = [];
	private logIdCounter = 0;
	private options: Required<LocalLogBackendOptions>;
	private currentLogFile: string | null = null;
	private currentLogFileSize = 0;

	constructor(options: LocalLogBackendOptions = {}) {
		this.options = {
			maxLogs: options.maxLogs ?? 1000, // Reduced from 10000 to prevent survivor space leak from buffered compression logs
			maxAge: options.maxAge ?? 24 * 60 * 60 * 1000, // 24 hours
			enableFilePersistence: options.enableFilePersistence ?? false,
			logDir: options.logDir ?? `${process.env.DATA_DIR || '/app/data'}/logs`,
			maxFileSize: options.maxFileSize ?? 10 * 1024 * 1024, // 10MB
		};
	}

	/**
	* Initialize the log backend (create directories, etc.)
	*/
	public async initialize(): Promise<void> {
		if (this.options.enableFilePersistence) {
			await fs.mkdir(this.options.logDir, { recursive: true });
			this.currentLogFile = path.join(
				this.options.logDir,
				`container-manager-${Date.now()}.log`,
			);
		}

		// Start periodic cleanup
		this.startPeriodicCleanup();
	}

	/**
	* Store a log message
	*/
	public async log(message: LogMessage): Promise<void> {
		// Assign ID and ensure timestamp
		const logEntry: LogMessage = {
			...message,
			id: message.id ?? `log-${++this.logIdCounter}`,
			timestamp: message.timestamp ?? Date.now(),
		};

		// Add to in-memory storage
		this.logs.push(logEntry);

		// Trim if we exceed max logs
		if (this.logs.length > this.options.maxLogs) {
			this.logs.shift();
		}

		// Write to file if persistence enabled
		if (this.options.enableFilePersistence && this.currentLogFile) {
			await this.writeToFile(logEntry);
		}
	}

	/**
	* Retrieve logs matching filter
	*/
	public async getLogs(filter?: LogFilter): Promise<LogMessage[]> {
		let filtered = [...this.logs];

		if (!filter) {
			return filtered;
		}

		// Apply filters
		if (filter.serviceId !== undefined) {
			filtered = filtered.filter((log) => log.serviceId === filter.serviceId);
		}

		if (filter.serviceName !== undefined) {
			filtered = filtered.filter(
				(log) => log.serviceName === filter.serviceName,
			);
		}

		if (filter.containerId !== undefined) {
			filtered = filtered.filter(
				(log) => log.containerId === filter.containerId,
			);
		}

		if (filter.level !== undefined) {
			filtered = filtered.filter((log) => log.level === filter.level);
		}

		if (filter.sourceType !== undefined) {
			filtered = filtered.filter(
				(log) => log.source.type === filter.sourceType,
			);
		}

		if (filter.since !== undefined) {
			filtered = filtered.filter((log) => log.timestamp >= filter.since!);
		}

		if (filter.until !== undefined) {
			filtered = filtered.filter((log) => log.timestamp <= filter.until!);
		}

		if (filter.includeStderr === false) {
			filtered = filtered.filter((log) => !log.isStdErr);
		}

		if (filter.includeStdout === false) {
			filtered = filtered.filter((log) => log.isStdErr === true);
		}

		// Apply limit
		if (filter.limit !== undefined && filter.limit > 0) {
			filtered = filtered.slice(-filter.limit);
		}

		return filtered;
	}

	/**
	* Clear logs older than specified time
	*/
	public async cleanup(olderThanMs: number): Promise<number> {
		const cutoffTime = Date.now() - olderThanMs;
		const initialCount = this.logs.length;

		this.logs = this.logs.filter((log) => log.timestamp >= cutoffTime);

		const removedCount = initialCount - this.logs.length;

		// Also cleanup old log files if persistence enabled
		if (this.options.enableFilePersistence) {
			await this.cleanupOldLogFiles(cutoffTime);
		}

		return removedCount;
	}

	/**
	* Get total number of stored logs
	*/
	public async getLogCount(): Promise<number> {
		return this.logs.length;
	}

	/**
	* Write log entry to file
	*/
	private async writeToFile(logEntry: LogMessage): Promise<void> {
		if (!this.currentLogFile) {
			return;
		}

		const logLine = JSON.stringify(logEntry) + '\n';
		const lineSize = Buffer.byteLength(logLine, 'utf-8');

		// Check if we need to rotate the log file
		if (this.currentLogFileSize + lineSize > this.options.maxFileSize) {
			await this.rotateLogFile();
		}

		try {
			await fs.appendFile(this.currentLogFile, logLine, 'utf-8');
			this.currentLogFileSize += lineSize;
		} catch (error) {
			console.error('Failed to write log to file:', error);
		}
	}

	/**
	* Rotate log file (create new one)
	*/
	private async rotateLogFile(): Promise<void> {
		this.currentLogFile = path.join(
			this.options.logDir,
			`container-manager-${Date.now()}.log`,
		);
		this.currentLogFileSize = 0;
	}

	/**
	* Cleanup old log files
	*/
	private async cleanupOldLogFiles(cutoffTime: number): Promise<void> {
		try {
			const files = await fs.readdir(this.options.logDir);

			for (const file of files) {
				if (!file.endsWith('.log')) {
					continue;
				}

				const filePath = path.join(this.options.logDir, file);
				const stats = await fs.stat(filePath);

				// Delete files older than cutoff time
				if (stats.mtimeMs < cutoffTime) {
					await fs.unlink(filePath);
				}
			}
		} catch (error) {
			console.error('Failed to cleanup old log files:', error);
		}
	}

	/**
	* Start periodic cleanup task
	*/
	private startPeriodicCleanup(): void {
		// Run cleanup every hour
		setInterval(async () => {
			const removed = await this.cleanup(this.options.maxAge);
			if (removed > 0) {
				console.log(`[LogBackend] Cleaned up ${removed} old log entries`);
			}
		}, 60 * 60 * 1000); // 1 hour
	}
}
