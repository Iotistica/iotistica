/**
 * CONNECTION MONITOR
 * ==================
 * 
 * Tracks connection health and online/offline state.
 * Emits events when connection state changes.
 * 
 * Used by CloudSync to track API connectivity and trigger
 * graceful degradation when offline for extended periods.
 */

import { EventEmitter } from 'events';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

export interface ConnectionState {
	isOnline: boolean;
	lastSuccessfulPoll: number;
	lastSuccessfulReport: number;
	consecutivePollFailures: number;
	consecutiveReportFailures: number;
	offlineSince?: number;
	totalPollAttempts: number;
	totalReportAttempts: number;
	successfulPolls: number;
	successfulReports: number;
}

export interface ConnectionHealth {
	status: 'online' | 'degraded' | 'offline';
	uptime: number;
	lastPollSuccess: string | null;
	lastReportSuccess: string | null;
	pollSuccessRate: number;
	reportSuccessRate: number;
	offlineDuration: number;
}

interface ConnectionMonitorEvents {
	'online': () => void;
	'offline': () => void;
	'degraded': () => void;
	'state-changed': (state: ConnectionState) => void;
}

export class ConnectionMonitor extends EventEmitter {
	private state: ConnectionState;
	private readonly FAILURE_THRESHOLD = 3; // Mark offline after 3 consecutive failures
	private readonly DEGRADED_THRESHOLD = 2; // Mark degraded after 2 consecutive failures
	private logger?: AgentLogger;
	
	constructor(logger?: AgentLogger) {
		super();
		this.logger = logger;
		this.state = {
			isOnline: true, // Assume online at start
			lastSuccessfulPoll: Date.now(),
			lastSuccessfulReport: Date.now(),
			consecutivePollFailures: 0,
			consecutiveReportFailures: 0,
			totalPollAttempts: 0,
			totalReportAttempts: 0,
			successfulPolls: 0,
			successfulReports: 0,
		};
	}
	
	/**
	 * Mark a successful operation (poll or report)
	 */
	public markSuccess(operation: 'poll' | 'report'): void {
		const now = Date.now();
		const wasOffline = !this.state.isOnline;
		
		// Get the specific failure count for this operation
		const failureCount = operation === 'poll' 
			? this.state.consecutivePollFailures 
			: this.state.consecutiveReportFailures;
		
		// Debug logging
		if (failureCount > 0) {
			this.logger?.debugSync(`${operation} success after ${failureCount} failures`, {
				component: LogComponents.connectionMonitor,
				operation,
				failureCount,
				wasOffline,
			});
		}
		
		// Reset failure counter for this specific operation
		if (operation === 'poll') {
			this.state.consecutivePollFailures = 0;
			this.state.lastSuccessfulPoll = now;
			this.state.totalPollAttempts++;
			this.state.successfulPolls++;
		} else {
			this.state.consecutiveReportFailures = 0;
			this.state.lastSuccessfulReport = now;
			this.state.totalReportAttempts++;
			this.state.successfulReports++;
		}
		
		// Check if we should mark as online (both operations must be successful)
		const bothOperationsHealthy = this.state.consecutivePollFailures === 0 
			&& this.state.consecutiveReportFailures === 0;
		
		if (wasOffline && bothOperationsHealthy) {
			this.state.isOnline = true;
			delete this.state.offlineSince;
			
			if (this.logger) {
				this.logger.infoSync('Connection restored (both poll and report successful)', {
					component: LogComponents.connectionMonitor,
				});
			} 
			
			this.emit('online');
			this.emit('state-changed', this.getState());
		}
	}
	
	/**
	 * Mark a failed operation (poll or report)
	 */
	public markFailure(operation: 'poll' | 'report', error?: Error): void {
		const wasOnline = this.state.isOnline;
		
		// Update counters for the specific operation
		if (operation === 'poll') {
			this.state.consecutivePollFailures++;
			this.state.totalPollAttempts++;
		} else {
			this.state.consecutiveReportFailures++;
			this.state.totalReportAttempts++;
		}
		
		// Get max failures across both operations
		const maxFailures = Math.max(
			this.state.consecutivePollFailures,
			this.state.consecutiveReportFailures
		);
		
		// Debug logging
		if (this.logger) {
			this.logger.debugSync(`${operation} failure`, {
				component: LogComponents.connectionMonitor,
				operation,
				attemptNumber: operation === 'poll' ? this.state.consecutivePollFailures : this.state.consecutiveReportFailures,
				pollFailures: this.state.consecutivePollFailures,
				reportFailures: this.state.consecutiveReportFailures,
				maxFailures,
				wasOnline,
			});
		} 
		
		// Check if we should mark as degraded (2+ failures on any operation)
		if (maxFailures >= this.DEGRADED_THRESHOLD && 
		    maxFailures < this.FAILURE_THRESHOLD && 
		    wasOnline) {
			this.logger?.warnSync('Connection degraded', {
				component: LogComponents.connectionMonitor,
				consecutiveFailures: maxFailures,
			});
			
			this.emit('degraded');
			this.emit('state-changed', this.getState());
		}
		
		// Check if we should mark as offline (3+ failures on any operation)
		if (maxFailures >= this.FAILURE_THRESHOLD && wasOnline) {
			this.state.isOnline = false;
			this.state.offlineSince = Date.now();
			
			this.logger?.errorSync('Connection lost', undefined, {
				component: LogComponents.connectionMonitor,
				consecutiveFailures: maxFailures,
				lastSuccessfulPoll: this.formatTimestamp(this.state.lastSuccessfulPoll),
				lastSuccessfulReport: this.formatTimestamp(this.state.lastSuccessfulReport),
			});
			
			this.emit('offline');
			this.emit('state-changed', this.getState());
		}
	}
	
	/**
	 * Check if currently online
	 */
	public isOnline(): boolean {
		return this.state.isOnline;
	}
	
	/**
	 * Get offline duration in milliseconds
	 */
	public getOfflineDuration(): number {
		return this.state.offlineSince 
			? Date.now() - this.state.offlineSince 
			: 0;
	}
	
	/**
	 * Get current connection state
	 */
	public getState(): ConnectionState {
		return { ...this.state };
	}
	
	/**
	 * Get connection health summary
	 */
	public getHealth(): ConnectionHealth {
		const pollSuccessRate = this.state.totalPollAttempts > 0
			? (this.state.successfulPolls / this.state.totalPollAttempts) * 100
			: 100;
		
		const reportSuccessRate = this.state.totalReportAttempts > 0
			? (this.state.successfulReports / this.state.totalReportAttempts) * 100
			: 100;
		
		const maxFailures = Math.max(
			this.state.consecutivePollFailures,
			this.state.consecutiveReportFailures
		);
		
		let status: 'online' | 'degraded' | 'offline';
		if (!this.state.isOnline) {
			status = 'offline';
		} else if (maxFailures >= this.DEGRADED_THRESHOLD) {
			status = 'degraded';
		} else {
			status = 'online';
		}
		
		return {
			status,
			uptime: Date.now() - this.state.lastSuccessfulPoll,
			lastPollSuccess: this.state.lastSuccessfulPoll 
				? new Date(this.state.lastSuccessfulPoll).toISOString() 
				: null,
			lastReportSuccess: this.state.lastSuccessfulReport 
				? new Date(this.state.lastSuccessfulReport).toISOString() 
				: null,
			pollSuccessRate: Math.round(pollSuccessRate * 100) / 100,
			reportSuccessRate: Math.round(reportSuccessRate * 100) / 100,
			offlineDuration: this.getOfflineDuration(),
		};
	}
	
	/**
	 * Format timestamp for logging
	 */
	private formatTimestamp(timestamp: number): string {
		const now = Date.now();
		const diff = now - timestamp;
		const seconds = Math.floor(diff / 1000);
		
		if (seconds < 60) {
			return `${seconds}s ago`;
		} else if (seconds < 3600) {
			return `${Math.floor(seconds / 60)}m ago`;
		} else {
			return `${Math.floor(seconds / 3600)}h ago`;
		}
	}
	
	// Typed event emitter methods
	public on<K extends keyof ConnectionMonitorEvents>(
		event: K,
		listener: ConnectionMonitorEvents[K],
	): this {
		return super.on(event, listener as any);
	}

	public emit<K extends keyof ConnectionMonitorEvents>(
		event: K,
		...args: Parameters<ConnectionMonitorEvents[K]>
	): boolean {
		return super.emit(event, ...args);
	}
}
