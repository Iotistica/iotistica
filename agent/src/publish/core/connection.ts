import { BasePublishPlugin } from './base-plugin.js';
import type { IPublishClient, Logger } from './types.js';

export class ConnectionPublishPlugin extends BasePublishPlugin {
	constructor(client: IPublishClient, logger?: Logger) {
		super(client, logger);
	}

	async start(): Promise<void> {
		if (this.running) {
			return;
		}

		this.running = true;
		this.emit('started');
	}

	async stop(): Promise<void> {
		if (!this.running) {
			return;
		}

		this.running = false;
		this.emit('stopped');
	}
}
