import * as net from 'net';
import { EventEmitter } from 'events';
import type { DeviceConfig, Logger } from './types.js';
import { DeviceState } from './types.js';

/**
 * Manages the Unix-domain socket lifecycle for one endpoint.
 * Emits:
 *   'connected'    — socket is ready (after subscription ACK received)
 *   'data'         — Buffer received from socket (never includes the subscription ACK)
 *   'error'        — socket error (close follows)
 *   'disconnected' — socket closed (reconnect scheduled internally unless stopped)
 *   'reconnecting' — about to retry (useful for stats tracking)
 */
export class SocketConnection extends EventEmitter {
	private socket: net.Socket | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private stopped = false;
	private _state: DeviceState = DeviceState.DISCONNECTED;
	private _attempts = 0;
	private currentDelay: number;
	private _subscriptionAcked = false;
	private _lineBuffer = '';

	private readonly INITIAL_DELAY_MS = 500;
	private readonly MAX_FAST_DELAY_MS = 8000;
	private readonly FAST_RETRY_THRESHOLD = 5;

	constructor(
    private readonly config: DeviceConfig,
    private readonly logger?: Logger,
	) {
		super();
		this.currentDelay = this.INITIAL_DELAY_MS;
	}

	get state(): DeviceState { return this._state; }
	get attempts(): number { return this._attempts; }

	connect(): void {
		this.stopped = false;
		this._state = DeviceState.CONNECTING;
		this._subscriptionAcked = false;
		this._lineBuffer = '';

		try {
			this.socket = net.createConnection(this.config.addr);
			this.socket.on('connect', () => this.onConnect());
			this.socket.on('data', (buf: Buffer) => this.onData(buf));
			this.socket.on('error', (err: Error) => this.onSocketError(err));
			this.socket.on('close', () => this.onClose());
		} catch (err) {
			this.logger?.error('Failed to create socket connection', err);
			this.scheduleReconnect();
		}
	}

	disconnect(): void {
		this.stopped = true;
		this.clearReconnectTimer();
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.destroy();
			this.socket = null;
		}
		this._state = DeviceState.DISCONNECTED;
	}

	private onConnect(): void {
		this._state = DeviceState.CONNECTED;
		this._attempts = 0;
		this.currentDelay = this.INITIAL_DELAY_MS;

		if (this.socket) {
			const protocol = this.config.protocol || 'unknown';
			const subscriptionMessage = JSON.stringify({ subscribe: [protocol] });
			this.socket.write(subscriptionMessage + '\n', (err) => {
				if (err) {
					this.logger?.error(
						`Failed to send subscription message for '${this.config.name || 'unknown'}': ${err.message}`,
					);
					this.onSocketError(err);
				}
			});
		}
	}

	private onData(buf: Buffer): void {
		if (this._subscriptionAcked) {
			this.emit('data', buf);
			return;
		}

		// Buffer incoming data until we've consumed the subscription ACK line.
		this._lineBuffer += buf.toString('utf8');
		const newlineIdx = this._lineBuffer.indexOf('\n');
		if (newlineIdx === -1) return;

		const line = this._lineBuffer.slice(0, newlineIdx);
		const remaining = this._lineBuffer.slice(newlineIdx + 1);
		this._lineBuffer = '';
		this._subscriptionAcked = true;

		try {
			const parsed = JSON.parse(line);
			if (parsed.ok !== true) {
				this.logger?.error(
					`Unexpected subscription response for '${this.config.name || 'unknown'}': ${line}`,
				);
			}
		} catch {
			// Non-JSON first line — treat it as data
			const passthrough = line + '\n';
			this.emit('connected');
			this.emit('data', Buffer.from(passthrough, 'utf8'));
			if (remaining.length > 0) this.emit('data', Buffer.from(remaining, 'utf8'));
			return;
		}

		this.emit('connected');
		if (remaining.length > 0) this.emit('data', Buffer.from(remaining, 'utf8'));
	}

	private onSocketError(err: Error): void {
		this._state = DeviceState.ERROR;
		// ENOENT means the adapter hasn't created the socket yet — normal transient state.
		const isNotReady = (err as NodeJS.ErrnoException).code === 'ENOENT';
		if (isNotReady) {
			this.logger?.debug(`Socket not ready for endpoint '${this.config.name || 'unknown'}' (adapter not started yet)`);
		} else {
			this.logger?.error(`Socket error for endpoint '${this.config.name || 'unknown'}'`, err);
		}
		this.emit('error', err);
	}

	private onClose(): void {
		this._state = DeviceState.DISCONNECTED;
		this._subscriptionAcked = false;
		this._lineBuffer = '';
		this.socket = null;
		this.logger?.debug(`Connection closed for device '${this.config.name || 'unknown'}'`);
		this.emit('disconnected');
		if (!this.stopped) this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		this.clearReconnectTimer();

		let delay: number;
		if (this._attempts < this.FAST_RETRY_THRESHOLD) {
			delay = Math.min(this.currentDelay, this.MAX_FAST_DELAY_MS);
			this.currentDelay *= 2;
		} else {
			delay = (this.config.addrPollSec ?? 30) * 1000;
		}

		this.reconnectTimer = setTimeout(() => {
			this._attempts++;
			this.emit('reconnecting');
			this.connect();
		}, delay);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}
}
