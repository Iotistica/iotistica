
/**
 * Owns the raw socket read buffer (frame reassembly) and the parsed message
 * batch.  Emits:
 *   'flush'         — batch should be published immediately
 *   'message-added' — one parsed message was accepted into the batch
 */

import { EventEmitter } from 'events';
import type { DeviceConfig, Logger } from './types.js';

export class MessageBatcher extends EventEmitter {
	// Raw socket buffer — accumulates partial frames until a delimiter is seen
	private readBuffer: Buffer = Buffer.alloc(0);

	// Parsed-object batch
	private _messages: any[] = [];
	private _totalBytes = 0;
	private _firstMessageTime = Date.now();
	private _totalReceived = 0;  // lifetime counter (never reset)

	private readonly delimiterRegex: RegExp;
	private readonly delimiterLiteral?: string;
	private readonly delimiterLiteralBytes?: Buffer;

	constructor(
    private readonly config: DeviceConfig,
    private readonly maxMessages: number,
    private readonly maxBytes: number,
    private readonly logger?: Logger,
	) {
		super();
		if (!this.isAsciiSafe(config.eomDelimiter)) {
			throw new Error(`Invalid eom_delimiter: ${config.eomDelimiter}. Delimiter must be ASCII-safe.`);
		}
		if (config.eomDelimiter.length === 0) {
			throw new Error('Invalid eom_delimiter: delimiter must not be empty.');
		}
		if (this.isPlainDelimiter(config.eomDelimiter)) {
			this.delimiterLiteral = config.eomDelimiter;
			this.delimiterLiteralBytes = Buffer.from(config.eomDelimiter, 'ascii');
		}
		try {
			this.delimiterRegex = new RegExp(config.eomDelimiter);
		} catch {
			throw new Error(`Invalid eom_delimiter regex: ${config.eomDelimiter}`);
		}
	}

	get messages(): any[] { return this._messages; }
	get totalBytes(): number { return this._totalBytes; }
	get firstMessageTime(): number { return this._firstMessageTime; }
	get messageCount(): number { return this._messages.length; }
	get totalReceived(): number { return this._totalReceived; }


	/** Called by EndpointConnection whenever data arrives on the socket. */
	appendData(data: Buffer): void {
		const deviceName = this.config.name || 'unknown';

		if (this.readBuffer.length + data.length > this.config.bufferCapacity) {
			this.logger?.error(
				`Buffer capacity exceeded for '${deviceName}' ` +
        `(current: ${this.readBuffer.length}, incoming: ${data.length}, max: ${this.config.bufferCapacity}). ` +
        `Discarding buffer — check delimiter or message size.`,
			);
			// Drop accumulated partial state, then treat incoming bytes as a fresh segment.
			this.readBuffer = Buffer.alloc(0);
			if (data.length > this.config.bufferCapacity) {
				this.logger?.error(`Single chunk exceeds capacity (${data.length}), discarding`);
				return;
			}
			this.readBuffer = data;
			this.parseFrames();
			return;
		}

		if (this.readBuffer.length === 0) {
			this.readBuffer = data;
		} else {
			const merged = Buffer.allocUnsafe(this.readBuffer.length + data.length);
			this.readBuffer.copy(merged, 0);
			data.copy(merged, this.readBuffer.length);
			this.readBuffer = merged;
		}

		this.parseFrames();
	}

	reset(): void {
		this._messages.length = 0;
		this._totalBytes = 0;
		this._firstMessageTime = Date.now();
	}


	private isPlainDelimiter(pattern: string): boolean {
		// Fast-path only literal delimiters with no regex metacharacters.
		return !/[\\^$.*+?()[\]{}|]/.test(pattern);
	}

	private isAsciiSafe(value: string): boolean {
		for (let i = 0; i < value.length; i += 1) {
			if (value.charCodeAt(i) > 0x7f) {
				return false;
			}
		}
		return true;
	}

	private parseFrames(): void {
		if (this.delimiterLiteralBytes) {
			this.parseFramesWithLiteralDelimiter(this.delimiterLiteralBytes);
			return;
		}

		const str = this.readBuffer.toString('utf8');

		const parts = str.split(this.delimiterRegex);
		const tail = parts.length > 0 ? parts[parts.length - 1] : str;
		if (Buffer.byteLength(tail, 'utf8') > this.config.bufferCapacity) {
			this.logger?.error(
				`Incomplete frame exceeds capacity for '${this.config.name || 'unknown'}'. Discarding.`,
			);
			this.readBuffer = Buffer.alloc(0);
		} else {
			this.readBuffer = Buffer.from(tail, 'utf8');
		}

		for (let i = 0; i < parts.length - 1; i++) {
			if (parts[i].length > 0) this.addMessage(parts[i]);
		}
	}

	private parseFramesWithLiteralDelimiter(delimiter: Buffer): void {
		let scanIndex = 0;
		let delimIndex = this.readBuffer.indexOf(delimiter, scanIndex);

		while (delimIndex !== -1) {
			const frameBytes = this.readBuffer.subarray(scanIndex, delimIndex);
			if (frameBytes.length > 0) this.addMessage(frameBytes.toString('utf8'));
			scanIndex = delimIndex + delimiter.length;
			delimIndex = this.readBuffer.indexOf(delimiter, scanIndex);
		}

		// No delimiter found: keep buffered bytes untouched.
		if (scanIndex === 0) return;

		const tail = this.readBuffer.subarray(scanIndex);
		if (tail.length > this.config.bufferCapacity) {
			this.logger?.error(
				`Incomplete frame exceeds capacity for '${this.config.name || 'unknown'}'. Discarding.`,
			);
			this.readBuffer = Buffer.alloc(0);
			return;
		}

		// Copy tail to avoid retaining references to already-processed bytes.
		this.readBuffer = tail.length > 0 ? Buffer.from(tail) : Buffer.alloc(0);
	}

	private addMessage(raw: string): void {
		const deviceName = this.config.name || 'unknown';
		const byteLen = Buffer.byteLength(raw, 'utf8');

		if (byteLen > this.config.bufferCapacity) {
			this.logger?.error(`Message size exceeds capacity for '${deviceName}', discarding`);
			return;
		}

		let parsed: any;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			this.logger?.warn(
				`JSON parse failed for '${deviceName}': ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		if (this._messages.length === 0) this._firstMessageTime = Date.now();
		this._messages.push(parsed);
		this._totalBytes += byteLen;
		this._totalReceived++;
		this.emit('message-added');

		// Safety: force flush if batch grows past hard limits
		if (this._messages.length >= this.maxMessages || this._totalBytes >= this.maxBytes) {
			this.logger?.warn(
				`Batch safety limit reached for '${deviceName}' ` +
        `(${this._messages.length} msgs / ${(this._totalBytes / (1024 * 1024)).toFixed(1)} MB). Force flushing.`,
			);
			this.emit('flush');
			return;
		}

		const bufferSize = this.config.bufferSize ?? 0;
		const bufferTimeMs = this.config.bufferTimeMs ?? 0;

		// No buffering configured → publish immediately
		if (bufferSize <= 0 && bufferTimeMs <= 0) {
			this.emit('flush');
			return;
		}

		// Size-based flush (timer-based flush is driven by the manager's interval)
		if (bufferSize > 0 && this._messages.length >= bufferSize) {
			this.emit('flush');
		}
	}
}
