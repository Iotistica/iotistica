import { EventEmitter } from 'events';
import type { IPublishClient, IPublishPlugin, PublishBatchItem, Logger } from './types.js';

export class BasePublishPlugin extends EventEmitter implements IPublishPlugin {
	protected running = false;

	constructor(
    protected readonly client: IPublishClient,
    protected readonly logger?: Logger,
	) {
		super();
	}

	async start(): Promise<void> {
		if (this.running) {
			return;
		}

		if (this.client.connect && !this.client.isConnected()) {
			await this.client.connect();
		}

		this.running = true;
		this.emit('started');
	}

	async stop(): Promise<void> {
		if (!this.running) {
			return;
		}

		if (this.client.disconnect) {
			await this.client.disconnect();
		}

		this.running = false;
		this.emit('stopped');
	}

	isRunning(): boolean {
		return this.running;
	}

	isConnected(): boolean {
		return this.client.isConnected();
	}

	async publishBatch(batch: PublishBatchItem[]): Promise<void> {
		for (const item of batch) {
			await this.client.publish(item.topic, item.payload, item.options);
		}
	}
}
