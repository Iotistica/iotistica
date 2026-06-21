import { EventEmitter } from 'events';
import { InfluxDB, Point, WriteApi } from '@influxdata/influxdb-client';
import type { IPublishPlugin, IPublishClient, PublishBatchItem, Logger } from '../core/types.js';

interface InfluxDbConfig {
	url: string;
	org: string;
	bucket: string;
	token: string;
	precision?: 'ms' | 's' | 'us' | 'ns';
	batchSize?: number;
	flushInterval?: number;
	timeout?: number;
	rejectUnauthorized?: boolean;
}

interface TagsPayload {
	timestamp?: number;
	node?: string;
	group?: string;
	tags?: Array<{ name: string; value: unknown; error?: unknown }>;
}

interface CustomPayload {
	timestamp?: string | number;
	protocol?: string;
	messages?: Array<Record<string, unknown>>;
}

function isTagsPayload(obj: unknown): obj is TagsPayload {
	return typeof obj === 'object' && obj !== null && 'tags' in obj && Array.isArray((obj as TagsPayload).tags);
}

function loadConfig(raw: Record<string, unknown> | null): InfluxDbConfig {
	if (!raw) throw new Error('InfluxDB destination requires configuration');

	const url = typeof raw.url === 'string' ? raw.url.trim() : '';
	const org = typeof raw.org === 'string' ? raw.org.trim() : '';
	const bucket = typeof raw.bucket === 'string' ? raw.bucket.trim() : '';
	const token = typeof raw.token === 'string' ? raw.token.trim() : '';

	if (!url) throw new Error('InfluxDB config missing required field: url');
	if (!org) throw new Error('InfluxDB config missing required field: org');
	if (!bucket) throw new Error('InfluxDB config missing required field: bucket');
	if (!token) throw new Error('InfluxDB config missing required field: token');

	const precisionRaw = typeof raw.precision === 'string' ? raw.precision : 'ms';
	const precision = ['ms', 's', 'us', 'ns'].includes(precisionRaw)
		? (precisionRaw as InfluxDbConfig['precision'])
		: 'ms';

	return {
		url,
		org,
		bucket,
		token,
		precision,
		batchSize: typeof raw.batchSize === 'number' && raw.batchSize > 0 ? raw.batchSize : 1000,
		flushInterval: typeof raw.flushInterval === 'number' && raw.flushInterval > 0 ? raw.flushInterval : 10000,
		timeout: typeof raw.timeout === 'number' && raw.timeout > 0 ? raw.timeout : 10000,
		rejectUnauthorized: raw.rejectUnauthorized !== false,
	};
}

function applyNumericField(point: Point, name: string, value: number): void {
	point.floatField(name, value);
}

export class InfluxDbPublishPlugin extends EventEmitter implements IPublishPlugin {
	private running = false;
	private writeApi: WriteApi | null = null;
	private lastSuccessTime = 0;
	private readonly config: InfluxDbConfig;
	private readonly logger?: Logger;

	constructor(config: InfluxDbConfig, logger?: Logger) {
		super();
		this.config = config;
		this.logger = logger;
	}

	static fromConfig(raw: Record<string, unknown> | null, logger?: Logger): InfluxDbPublishPlugin {
		const config = loadConfig(raw);
		return new InfluxDbPublishPlugin(config, logger);
	}

	async start(): Promise<void> {
		if (this.running) return;

		const { url, token, org, bucket, precision, batchSize, flushInterval, timeout, rejectUnauthorized } = this.config;

		const client = new InfluxDB({
			url,
			token,
			timeout,
			transportOptions: { rejectUnauthorized },
		});

		this.writeApi = client.getWriteApi(org, bucket, precision, {
			batchSize,
			flushInterval,
			writeFailed: (error, lines, attempt, expires) => {
				this.logger?.error(
					`InfluxDB write failed (attempt ${attempt}, expires ${expires}): ${(error as Error).message}`,
					{ lines: lines.length }
				);
			},
			writeSuccess: (lines) => {
				this.lastSuccessTime = Date.now();
				this.logger?.debug(`InfluxDB flushed ${lines.length} line(s) to ${this.config.bucket}`);
			},
		});

		this.running = true;
		this.emit('started');
		this.logger?.info(`InfluxDB plugin started — ${url} / ${org} / ${bucket}`);
	}

	async stop(): Promise<void> {
		if (!this.running || !this.writeApi) return;

		try {
			await this.writeApi.flush(true);
			await this.writeApi.close();
		} catch (err) {
			this.logger?.error('InfluxDB flush/close error on stop', err as Error);
		} finally {
			this.writeApi = null;
			this.running = false;
			this.emit('stopped');
		}
	}

	isRunning(): boolean {
		return this.running;
	}

	isConnected(): boolean {
		const { flushInterval = 10000 } = this.config;
		return this.running && (this.lastSuccessTime === 0 || Date.now() - this.lastSuccessTime < flushInterval * 2);
	}

	async publishBatch(batch: PublishBatchItem[]): Promise<void> {
		if (!this.running || !this.writeApi) return;

		let queued = 0;
		for (const item of batch) {
			try {
				const text = Buffer.isBuffer(item.payload)
					? item.payload.toString('utf-8')
					: item.payload as string;
				const raw = JSON.parse(text);

				const measurement = item.options?.destinationTopic?.trim() || 'metrics';
				const point = isTagsPayload(raw)
					? this.buildPointFromTagsPayload(raw, measurement)
					: this.buildPointFromCustomPayload(raw, item.topic, measurement);

				if (point) {
					this.writeApi.writePoint(point);
					queued++;
				}
			} catch (err) {
				this.logger?.error(`InfluxDB: failed to process batch item on topic '${item.topic}'`, err as Error);
			}
		}
		if (queued > 0) {
			this.logger?.debug(`InfluxDB: queued ${queued} point(s) → ${this.config.org}/${this.config.bucket}`);
		} else if (batch.length > 0) {
			const sample = batch[0];
			const text = Buffer.isBuffer(sample.payload) ? sample.payload.toString('utf-8') : sample.payload as string;
			const raw = JSON.parse(text);
			const isTagsFmt = isTagsPayload(raw);
			const firstTags = isTagsFmt ? (raw as { tags?: unknown[] }).tags?.slice(0, 2) : null;
			this.logger?.warn(`InfluxDB: 0 points from ${batch.length} item(s) — isTagsPayload=${isTagsFmt} firstTags=${JSON.stringify(firstTags)}`);
		}
	}

	private buildPointFromTagsPayload(payload: TagsPayload, measurement: string): Point | null {
		const point = new Point(measurement);

		if (payload.node) point.tag('device', payload.node);
		if (payload.group) point.tag('group', payload.group);
		if (typeof payload.timestamp === 'number') point.timestamp(payload.timestamp);

		let hasFields = false;
		for (const tag of payload.tags ?? []) {
			if (tag.error !== undefined || tag.value === null || tag.value === undefined) continue;

			const name = String(tag.name);
			const value = tag.value;

			if (typeof value === 'number' && isFinite(value)) {
				applyNumericField(point, name, value);
				hasFields = true;
			} else if (typeof value === 'boolean') {
				point.booleanField(name, value);
				hasFields = true;
			} else if (typeof value === 'string') {
				point.stringField(name, value);
				hasFields = true;
			}
		}

		return hasFields ? point : null;
	}

	private buildPointFromCustomPayload(payload: CustomPayload, topic: string, measurement: string): Point | null {
		const point = new Point(measurement);

		const deviceTag = topic.split('/').filter(Boolean).pop() ?? 'unknown';
		point.tag('device', deviceTag);

		if (typeof payload.timestamp === 'number') {
			point.timestamp(payload.timestamp);
		} else if (typeof payload.timestamp === 'string') {
			point.timestamp(new Date(payload.timestamp).getTime());
		}

		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		let hasFields = false;

		for (const msg of messages) {
			const name = String(msg.metric ?? msg.metric_name ?? msg.name ?? msg.tag ?? 'value');
			const value = msg.value ?? msg.v;

			if (typeof value === 'number' && isFinite(value)) {
				applyNumericField(point, name, value);
				hasFields = true;
			} else if (typeof value === 'boolean') {
				point.booleanField(name, value);
				hasFields = true;
			} else if (typeof value === 'string') {
				point.stringField(name, value);
				hasFields = true;
			}
		}

		return hasFields ? point : null;
	}

	getDestinationInfo() {
		return [{
			destinationName: `influxdb:${this.config.org}/${this.config.bucket}`,
			destinationType: 'influxdb',
			subscriptionIds: [],
			topics: [],
		}];
	}
}

// Satisfy IPublishPlugin — the base client wrapper is unused for InfluxDB (HTTP, not MQTT)
export class InfluxDbNoopClient {
	async publish(_topic: string, _payload: string | Buffer): Promise<void> {}
	isConnected(): boolean { return true; }
}
