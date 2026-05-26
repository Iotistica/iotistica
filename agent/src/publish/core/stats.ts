import type { DeviceStats, Logger } from '../core/types.js';
import type { CompressionInfo } from './compress.js';

/**
 * Tracks all publish-side metrics for one endpoint.
 * Does not track messagesReceived or reconnectAttempts — those are
 * provided externally by the manager from MessageBatcher.totalReceived
 * and EndpointConnection.attempts respectively.
 */
export class PublishStats {
	readonly data: DeviceStats = {
		messagesReceived: 0,
		messagesPublished: 0,
		bytesReceived: 0,
		bytesPublished: 0,
		reconnectAttempts: 0,
	};

	recordPublish(messageCount: number, batchBytes: number): void {
		this.data.messagesPublished += messageCount;
		this.data.bytesPublished += batchBytes;
		this.data.lastPublishTime = new Date();
	}

	recordError(message: string): void {
		this.data.lastError = message;
		this.data.lastErrorTime = new Date();
	}

	recordConnected(): void {
		this.data.lastConnectedTime = new Date();
		this.data.reconnectAttempts = 0;
	}

	recordHeartbeat(): void {
		this.data.lastHeartbeatTime = new Date();
	}

	logPublishSuccess(
		messageCount: number,
		batchBytes: number,
		info: CompressionInfo,
		deviceName: string,
		logger?: Logger,
		buffered?: boolean,
		extraContext?: Record<string, unknown>,
	): void {
		if (!logger) return;

		const saved = info.originalSize - info.compressedSize;
		const compressionLog: Record<string, unknown> = {
			method: info.method,
			originalSize: info.originalSize,
			compressedSize: info.compressedSize,
			savedBytes: saved,
			savedPercent: `${info.ratio.toFixed(1)}%`,
			compressionMs: info.compressionMs,
			throughputBytesPerMs: info.compressionMs > 0
				? Math.round(info.compressedSize / info.compressionMs)
				: 0,
		};

		if (info.cpuUsage) {
			const { serialization: ser, compression: comp, total } = info.cpuUsage;
			if (ser) {
				compressionLog.serializationMethod = ser.method;
				compressionLog.serializationCpuMs = ((ser.cpu.user + ser.cpu.system) / 1000).toFixed(2);
			}
			if (comp) {
				compressionLog.compressionCpuMethod = comp.method;
				compressionLog.compressionCpuMs = ((comp.cpu.user + comp.cpu.system) / 1000).toFixed(2);
			}
			if (total) {
				compressionLog.totalCpuMs = ((total.user + total.system) / 1000).toFixed(2);
			}
		}

		const verb = buffered ? 'Buffered' : 'Published';
		const label = info.isBaseline
			? `${verb} ${messageCount} messages (no-op baseline)`
			: `${verb} ${messageCount} messages`;

		logger.info(label, {
			messages: messageCount,
			batchBytes,
			compression: compressionLog,
			...(extraContext || {}),
		});
	}
}
