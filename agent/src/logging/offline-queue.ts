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

import * as db from '../db/connection';
import type { AgentLogger } from './agent-logger';
import { LogComponents } from './types';

export interface QueueItem<T> {
	id?: number;
	queueName: string;
	payload: string; // JSON stringified T
	createdAt: number;
	attempts: number;
}

export class OfflineQueue<T> {
	private queueName: string;
	private maxSize: number;
	private inMemoryQueue: T[] = [];
	private isInitialized = false;
	private logger?: AgentLogger;
	
	constructor(queueName: string, maxSize: number = 1000, logger?: AgentLogger) {
		this.queueName = queueName;
		this.maxSize = maxSize;
		this.logger = logger;
	}
	
	/**
	 * Initialize queue (create table if needed, load from disk)
	 */
	public async init(): Promise<void> {
		if (this.isInitialized) {
			return;
		}
		
		try {
			// Create queue table if it doesn't exist
			const knex = db.getKnex();
			const tableExists = await knex.schema.hasTable('offline_queue');
			
			if (!tableExists) {
				await knex.schema.createTable('offline_queue', (table) => {
					table.increments('id').primary();
					table.string('queueName').notNullable();
					table.text('payload').notNullable();
					table.bigInteger('createdAt').notNullable();
					table.integer('attempts').defaultTo(0);
					table.index(['queueName', 'createdAt']);
				});
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
			// Add to in-memory queue
			this.inMemoryQueue.push(item);
			
			// Enforce size limit (drop oldest)
			if (this.inMemoryQueue.length > this.maxSize) {
				const dropped = this.inMemoryQueue.shift();
				this.logger?.warnSync('Queue full, dropped oldest item', {
					component: LogComponents.offlineQueue,
					queueName: this.queueName,
					maxSize: this.maxSize
				});
				
				// Remove from disk too
				const oldestInDb = await db.models('offline_queue')
					.where({ queueName: this.queueName })
					.orderBy('createdAt', 'asc')
					.first();
				
				if (oldestInDb) {
					await db.models('offline_queue')
						.where({ id: oldestInDb.id })
						.delete();
				}
			}
			
			// Persist to disk
			await db.models('offline_queue').insert({
				queueName: this.queueName,
				payload: JSON.stringify(item),
				createdAt: Date.now(),
				attempts: 0,
			});
			
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
	 * Clear queue
	 */
	public async clear(): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}
		
		this.inMemoryQueue = [];
		
		await db.models('offline_queue')
			.where({ queueName: this.queueName })
			.delete();
		
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
			const items = await db.models('offline_queue')
				.where({ queueName: this.queueName })
				.orderBy('createdAt', 'asc')
				.select('payload');
			
			this.inMemoryQueue = items.map((item: any) => JSON.parse(item.payload) as T);
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
		const oldest = await db.models('offline_queue')
			.where({ queueName: this.queueName })
			.orderBy('createdAt', 'asc')
			.first();
		
		if (oldest) {
			await db.models('offline_queue')
				.where({ id: oldest.id })
				.delete();
		}
	}
	
	/**
	 * Increment attempts counter for item at index
	 */
	private async incrementAttempts(index: number): Promise<void> {
		const items = await db.models('offline_queue')
			.where({ queueName: this.queueName })
			.orderBy('createdAt', 'asc')
			.select('id', 'attempts');
		
		if (items[index]) {
			await db.models('offline_queue')
				.where({ id: items[index].id })
				.update({ attempts: items[index].attempts + 1 });
		}
	}
	
	/**
	 * Get attempts count for item at index
	 */
	private async getAttempts(index: number): Promise<number> {
		const items = await db.models('offline_queue')
			.where({ queueName: this.queueName })
			.orderBy('createdAt', 'asc')
			.select('attempts');
		
		return items[index]?.attempts || 0;
	}
}
