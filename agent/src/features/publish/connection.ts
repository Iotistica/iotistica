import * as net from 'net';
import { EventEmitter } from 'events';
import type { DeviceConfig, Logger } from './types.js';
import { DeviceState } from './types.js';

/**
 * Manages the Unix-domain socket lifecycle for one endpoint.
 * Emits:
 *   'connected'    — socket is ready
 *   'data'         — Buffer received from socket
 *   'error'        — socket error (close follows)
 *   'disconnected' — socket closed (reconnect scheduled internally unless stopped)
 *   'reconnecting' — about to retry (useful for stats tracking)
 */
export class DeviceConnection extends EventEmitter {
  private socket: net.Socket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private _state: DeviceState = DeviceState.DISCONNECTED;
  private _attempts = 0;
  private currentDelay: number;

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
    const name = this.config.name || 'unknown';

    try {
      this.socket = net.createConnection(this.config.addr);
      this.socket.on('connect', () => this.onConnect());
      this.socket.on('data', (buf: Buffer) => this.emit('data', buf));
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
    this.logger?.info(`Connected to device '${this.config.name || 'unknown'}'`);
    this.emit('connected');
  }

  private onSocketError(err: Error): void {
    this._state = DeviceState.ERROR;
    this.logger?.error(`Socket error for endpoint '${this.config.name || 'unknown'}'`, err);
    this.emit('error', err);
  }

  private onClose(): void {
    this._state = DeviceState.DISCONNECTED;
    this.socket = null;
    this.logger?.info(`Connection closed for device '${this.config.name || 'unknown'}'`);
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
