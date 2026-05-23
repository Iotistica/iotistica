import { PublishersModel, PublishSubscriptionsModel } from '../../db/models/index.js';
import type {
	PublishSubscriptionRecord,
	PublishSubscriptionRoute,
	PublisherRecord,
} from '../../db/models/index.js';
import type {
	IPublishClient,
	PublishDestinationInfo,
	IPublishPlugin,
	IPublishSink,
	Logger,
	PublishBatchItem,
} from '../core/types.js';

interface HostBinding {
	subscription: PublishSubscriptionRecord;
	publisher: PublisherRecord;
	plugin: IPublishPlugin;
}

interface PublisherHostOptions {
	protocol: string;
	endpointName: string;
	defaultClient: IPublishClient;
	logger?: Logger;
	buildPlugin: (target: string, client: IPublishClient, logger?: Logger) => IPublishPlugin;
}

export class PublisherHost implements IPublishSink {
	private running = false;
	private bindings: HostBinding[] = [];

	constructor(private readonly options: PublisherHostOptions) {}

	public async start(): Promise<void> {
		if (this.running) {
			return;
		}

		this.bindings = this.loadBindings();
		if (this.bindings.length === 0) {
			this.options.logger?.warn('No publisher bindings found; using legacy default target');
			this.bindings = this.createLegacyFallbackBinding();
		}

		for (const plugin of this.getUniquePlugins()) {
			await plugin.start();
		}

		this.running = true;
	}

	public async stop(): Promise<void> {
		if (!this.running) {
			return;
		}

		for (const plugin of this.getUniquePlugins()) {
			await plugin.stop();
		}

		this.bindings = [];
		this.running = false;
	}

	public isRunning(): boolean {
		return this.running;
	}

	public isConnected(): boolean {
		const plugins = this.getUniquePlugins();
		if (plugins.length === 0) {
			return false;
		}

		return plugins.some((plugin) => plugin.isConnected());
	}

	public async publishBatch(batch: PublishBatchItem[]): Promise<void> {
		const plugins = this.getUniquePlugins();
		if (plugins.length === 0) {
			throw new Error('No publish destinations configured');
		}

		const results = await Promise.allSettled(plugins.map((plugin) => plugin.publishBatch(batch)));
		const failures = results.filter((result) => result.status === 'rejected') as Array<PromiseRejectedResult>;

		if (failures.length === 0) {
			return;
		}

		if (failures.length === results.length) {
			const first = failures[0]?.reason;
			throw first instanceof Error ? first : new Error(String(first));
		}

		this.options.logger?.warn('Some publish destinations failed while others succeeded', {
			component: 'PublisherHost',
			protocol: this.options.protocol,
			endpoint: this.options.endpointName,
			failedDestinations: failures.length,
			totalDestinations: results.length,
		});
	}

	public getDestinationInfo(): PublishDestinationInfo[] {
		if (this.bindings.length === 0) {
			return [];
		}

		const byPublisher = new Map<number, PublishDestinationInfo>();

		for (const binding of this.bindings) {
			const publisherId = binding.publisher.id ?? -1;
			const existing = byPublisher.get(publisherId);
			if (!existing) {
				byPublisher.set(publisherId, {
					publisherId: binding.publisher.id,
					publisherName: binding.publisher.name,
					publisherType: String(binding.publisher.type),
					subscriptionIds: binding.subscription.id !== undefined ? [binding.subscription.id] : [],
					topics: this.normalizeTopics(binding.subscription.topics),
				});
				continue;
			}

			if (binding.subscription.id !== undefined && !existing.subscriptionIds.includes(binding.subscription.id)) {
				existing.subscriptionIds.push(binding.subscription.id);
			}

			for (const topic of this.normalizeTopics(binding.subscription.topics)) {
				if (!existing.topics.includes(topic)) {
					existing.topics.push(topic);
				}
			}
		}

		for (const destination of byPublisher.values()) {
			destination.subscriptionIds.sort((a, b) => a - b);
			destination.topics.sort();
		}

		return Array.from(byPublisher.values());
	}

	private normalizeTopics(topics: string[] | undefined): string[] {
		if (!Array.isArray(topics) || topics.length === 0) {
			return ['*'];
		}

		const normalized = topics
			.map((topic) => topic.trim())
			.filter((topic) => topic.length > 0);

		return normalized.length > 0 ? normalized : ['*'];
	}

	private createLegacyFallbackBinding(): HostBinding[] {
		const target = (process.env.PUBLISH_TARGET || 'iotistica').trim().toLowerCase() || 'iotistica';
		const plugin = this.options.buildPlugin(target, this.options.defaultClient, this.options.logger);
		return [{
			subscription: {
				publisher_id: -1,
				topics: [],
				payload_format: 'custom',
				enabled: true,
			},
			publisher: {
				id: -1,
				name: `legacy-${target}`,
				type: target,
				enabled: true,
			},
			plugin,
		}];
	}

	private loadBindings(): HostBinding[] {
		const publishers = PublishersModel.getAll(false);
		const subscriptions = PublishSubscriptionsModel.getAll(false);
		if (publishers.length === 0 || subscriptions.length === 0) {
			return [];
		}

		const publishersById = new Map<number, PublisherRecord>();
		for (const publisher of publishers) {
			if (publisher.id !== undefined) {
				publishersById.set(publisher.id, publisher);
			}
		}

		const pluginByPublisherId = new Map<number, IPublishPlugin>();
		const bindings: HostBinding[] = [];

		for (const subscription of subscriptions) {
			const publisher = publishersById.get(subscription.publisher_id);
			if (!publisher) {
				continue;
			}

			if (!this.matchesSubscription(subscription)) {
				continue;
			}

			let plugin = pluginByPublisherId.get(subscription.publisher_id);
			if (!plugin) {
				plugin = this.options.buildPlugin(publisher.type, this.options.defaultClient, this.options.logger);
				pluginByPublisherId.set(subscription.publisher_id, plugin);
			}

			bindings.push({ subscription, publisher, plugin });
		}

		return bindings;
	}

	private getUniquePlugins(): IPublishPlugin[] {
		const deduped = new Set<IPublishPlugin>();
		for (const binding of this.bindings) {
			deduped.add(binding.plugin);
		}
		return Array.from(deduped);
	}

	private matchesSubscription(subscription: PublishSubscriptionRecord): boolean {
		const topics = Array.isArray(subscription.topics) ? subscription.topics : [];
		if (topics.length > 0 && !topics.includes(this.options.protocol)) {
			return false;
		}

		const route = subscription.route_json as PublishSubscriptionRoute | null;
		if (!route) {
			return true;
		}

		if (Array.isArray(route.includeDevices) && route.includeDevices.length > 0) {
			if (!route.includeDevices.includes(this.options.endpointName)) {
				return false;
			}
		}

		if (Array.isArray(route.excludeDevices) && route.excludeDevices.length > 0) {
			if (route.excludeDevices.includes(this.options.endpointName)) {
				return false;
			}
		}

		return true;
	}
}
