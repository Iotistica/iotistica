/**
 * OFFLINE QUEUE
 * ==============
 * 
 * Persistent queue for operations that fail when offline.
 * Automatically flushes when connection is restored.
 * 
 * Features:
 * - Persists to SQLite database
 * - FIFO ordering
 * - Automatic size limiting (drops oldest when full)
 * - Type-safe generic implementation
 */

import { OfflineQueueModel, type OfflineQueueRecord } from '../db/models';
import type { AgentLogger } from './agent-logger';
import { LogComponents } from './types';

export interface QueueItem<_T> {
	id?: number;
	queueName: string;
	payload: string; // JSON stringified T
	createdAt: number;
	attempts: number;
}

export interface QueueStats {
	queueName: string;
	currentCount: number;
	oldestAgeHours?: number;
}

export class OfflineQueue<T> {
	private queueName: string;
	private maxSize: number;
	private readonly ttlMs?: number;
	private inMemoryQueue: T[] = [];
	private isInitialized = false;
	private logger?: AgentLogger;
	
	/**
	* @param queueName  - Unique name for this queue (used as SQLite partition key)
	* @param maxSize    - Maximum items before oldest is evicted (count-based cap)
	* @param ttlMs      - Optional TTL in ms. Items older than this are pruned on enqueue
	*                     and at flush time. Mirrors EdgeHub CleanupProcessor TTL behaviour.
	* @param logger     - Optional structured logger
	*/
	constructor(queueName: string, maxSize: number = 1000, ttlMs?: number, logger?: AgentLogger) {
		this.queueName = queueName;
		this.maxSize = maxSize;
		this.ttlMs = ttlMs;
		this.logger = logger;
	}

	private getRowsOrdered(): OfflineQueueRecord[] {
		return OfflineQueueModel.getRowsOrdered(this.queueName);
	}
	
	/**
	* Initialize queue (create table if needed, load from disk)
	*/
	public async init(): Promise<void> {
		if (this.isInitialized) {
			return;
		}
		
		try {
			const createdTable = OfflineQueueModel.ensureTable();

			if (createdTable) {
				this.logger?.infoSync('Created offline_queue table', {
					component: LogComponents.offlineQueue
				});
			}
			
			// Load existing items from disk
			await this.loadFromDisk();
			
			this.isInitialized = true;
			this.logger?.infoSync('OfflineQueue initialized', {
				component: LogComponents.offlineQueue,
				queueName: this.queueName,
				itemCount: this.inMemoryQueue.length
			});
		} catch (error) {
			this.logger?.errorSync('Failed to initialize OfflineQueue', error instanceof Error ? error : new Error(String(error)), {
				component: LogComponents.offlineQueue,
				queueName: this.queueName
			});
			throw error;
		}
	}
	
	/**
	* Add item to queue
	*/
	public async enqueue(item: T): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}
		
		try {
			// Prune expired items first (TTL-based), same as EdgeHub CleanupProcessor.
			// This means TTL eviction is preferred over count-based LRU eviction.
			if (this.ttlMs !== undefined) {
				this.pruneExpired();
			}

			// Add to in-memory queue
			this.inMemoryQueue.push(item);
			
			// Enforce size limit (drop oldest) as last resort
			if (this.inMemoryQueue.length > this.maxSize) {
				const _dropped = this.inMemoryQueue.shift();
				this.logger?.warnSync('Queue full, dropped oldest item', {
					component: LogComponents.offlineQueue,
					queueName: this.queueName,
					maxSize: this.maxSize
				});

				const oldestInDb = OfflineQueueModel.getOldest(this.queueName);

				if (typeof oldestInDb?.id === 'number') {
					OfflineQueueModel.deleteById(oldestInDb.id);
				}
			}
			
			// Persist to disk
			OfflineQueueModel.insert(this.queueName, JSON.stringify(item), Date.now(), 0);
			
		} catch (error) {
			this.logger?.errorSync('Failed to enqueue item', error instanceof Error ? error : new Error(String(error)), {
				component: LogComponents.offlineQueue,
				queueName: this.queueName
			});
			throw error;
		}
	}
	
	/**
	* Dequeue (remove and return oldest item from queue)
	* Returns null if queue is empty
	*/
	public async dequeue(): Promise<T | null> {
		if (!this.isInitialized) {
			await this.init();
		}
		
		if (this.inMemoryQueue.length === 0) {
			return null;
		}
		
		try {
			// Remove from in-memory queue (FIFO)
			const item = this.inMemoryQueue.shift();
			
			// Remove from disk
			await this.removeOldestFromDisk();
			
			return item || null;
		} catch (error) {
			this.logger?.errorSync('Failed to dequeue item', error instanceof Error ? error : new Error(String(error)), {
				component: LogComponents.offlineQueue,
				queueName: this.queueName
			});
			throw error;
		}
	}
	
	/**
	* Flush queue (send all items)
	* Returns number of successfully sent items
	*/
	public async flush(
		sendFn: (item: T) => Promise<void>,
		options?: { maxRetries?: number; continueOnError?: boolean }
	): Promise<number> {
		if (!this.isInitialized) {
			await this.init();
		}
		
		const maxRetries = options?.maxRetries ?? 3;
		const continueOnError = options?.continueOnError ?? true;
		
		if (this.inMemoryQueue.length === 0) {
			return 0;
		}
		
		this.logger?.infoSync('Flushing queue', {
			component: LogComponents.offlineQueue,
			queueName: this.queueName,
			itemCount: this.inMemoryQueue.length
		});
		
		let successCount = 0;
		const itemsToProcess = [...this.inMemoryQueue]; // Copy to avoid modification during iteration
		
		for (let i = 0; i < itemsToProcess.length; i++) {
			const item = itemsToProcess[i];
			
			try {
				await sendFn(item);
				
				// Success - remove from queue
				this.inMemoryQueue.shift(); // Remove first item (FIFO)
				
				// Remove from disk
				await this.removeOldestFromDisk();
				
				successCount++;
			} catch (error: any) {
				this.logger?.errorSync('Failed to flush item', error instanceof Error ? error : new Error(error.message), {
					component: LogComponents.offlineQueue,
					queueName: this.queueName,
					itemNumber: i + 1,
					totalItems: itemsToProcess.length
				});
				
				// Update attempts counter
				await this.incrementAttempts(i);
				
				if (!continueOnError) {
					this.logger?.infoSync('Stopping flush', {
						component: LogComponents.offlineQueue,
						queueName: this.queueName,
						successCount
					});
					break;
				}
				
				// Check if max retries exceeded
				const attempts = await this.getAttempts(i);
				if (attempts >= maxRetries) {
					this.logger?.warnSync('Max retries exceeded, dropping item', {
						component: LogComponents.offlineQueue,
						queueName: this.queueName,
						maxRetries,
						attempts
					});
					this.inMemoryQueue.shift();
					await this.removeOldestFromDisk();
				} else {
					// Keep in queue for next flush
					break; // Stop processing, this item blocks the queue
				}
			}
		}
		
		if (successCount > 0) {
			this.logger?.infoSync('Queue flush completed', {
				component: LogComponents.offlineQueue,
				queueName: this.queueName,
				successCount,
				totalItems: itemsToProcess.length
			});
		}
		
		return successCount;
	}
	
	/**
	* Prune items older than ttlMs from both in-memory queue and SQLite.
	* Mirrors EdgeHub's CleanupProcessor TTL eviction:
	*   - Called automatically on enqueue (when ttlMs is set)
	*   - Can also be called explicitly before a flush
	* Returns the number of items pruned.
	*/
	public pruneExpired(ttlMs?: number): number {
		const effectiveTtl = ttlMs ?? this.ttlMs;
		if (effectiveTtl === undefined) return 0;

		const cutoff = Date.now() - effectiveTtl;
		const deleted = OfflineQueueModel.deleteOlderThan(this.queueName, cutoff);

		if (deleted > 0) {
			// Reload in-memory queue to stay in sync with SQLite
			try {
				const rows = OfflineQueueModel.getPayloads(this.queueName);
				this.inMemoryQueue = rows.map(r => JSON.parse(r.payload) as T);
			} catch {
				this.inMemoryQueue = [];
			}
			this.logger?.warnSync('Pruned expired items from offline queue', {
				component: LogComponents.offlineQueue,
				queueName: this.queueName,
				deleted,
				cutoffAgeMs: effectiveTtl,
			});
		}

		return deleted;
	}

	/**
	* Get queue size
	*/
	public size(): number {
		return this.inMemoryQueue.length;
	}
	
	/**
	* Check if queue is empty
	*/
	public isEmpty(): boolean {
		return this.inMemoryQueue.length === 0;
	}

	/**
	* Get queue statistics from persisted storage.
	*/
	public async getStats(): Promise<QueueStats> {
		if (!this.isInitialized) {
			await this.init();
		}


		const count = OfflineQueueModel.getCount(this.queueName);
		const oldestCreatedAt = OfflineQueueModel.getOldestCreatedAt(this.queueName);

		let oldestAgeHours: number | undefined;
		if (oldestCreatedAt !== undefined && oldestCreatedAt !== null) {
			oldestAgeHours = Math.floor((Date.now() - oldestCreatedAt) / (1000 * 60 * 60));
		}

		return {
			queueName: this.queueName,
			currentCount: count,
			oldestAgeHours,
		};
	}
	
	/**
	* Clear queue
	*/
	public async clear(): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}
		
		this.inMemoryQueue = [];

		OfflineQueueModel.deleteByQueueName(this.queueName);
		
		this.logger?.infoSync('Queue cleared', {
			component: LogComponents.offlineQueue,
			queueName: this.queueName
		});
	}
	
	/**
	* Load queue from disk
	*/
	private async loadFromDisk(): Promise<void> {
		try {
			const items = OfflineQueueModel.getPayloads(this.queueName);

			this.inMemoryQueue = items.map((item) => JSON.parse(item.payload) as T);
		} catch (error) {
			this.logger?.errorSync('Failed to load queue from disk', error instanceof Error ? error : new Error(String(error)), {
				component: LogComponents.offlineQueue,
				queueName: this.queueName
			});
			this.inMemoryQueue = [];
		}
	}
	
	/**
	* Remove oldest item from disk
	*/
	private async removeOldestFromDisk(): Promise<void> {
		const oldest = OfflineQueueModel.getOldest(this.queueName);

		if (typeof oldest?.id === 'number') {
			OfflineQueueModel.deleteById(oldest.id);
		}
	}
	
	/**
	* Increment attempts counter for item at index
	*/
	private async incrementAttempts(index: number): Promise<void> {
		const items = this.getRowsOrdered();

		if (items[index]) {
			OfflineQueueModel.updateAttempts(items[index].id, items[index].attempts + 1);
		}
	}
	
	/**
	* Get attempts count for item at index
	*/
	private async getAttempts(index: number): Promise<number> {
		const items = this.getRowsOrdered();
		return items[index]?.attempts || 0;
	}
}
