/**
 * Subscription handler entry.
 * Supports multiple subscriptions to same or overlapping patterns.
 */
export type SubscriptionHandler = {
	pattern: string;
	handler: (topic: string, payload: Buffer) => void;
};

/**
 * Centralized topic router for inbound MQTT messages.
 * Owns handler registration and wildcard topic matching.
 */
export class MqttRouter {
	private handlers: SubscriptionHandler[] = [];

	public addHandler(pattern: string, handler: (topic: string, payload: Buffer) => void): void {
		this.handlers.push({ pattern, handler });
	}

	public removeHandler(handler: (topic: string, payload: Buffer) => void): void {
		this.handlers = this.handlers.filter((h) => h.handler !== handler);
	}

	public removePattern(pattern: string): void {
		this.handlers = this.handlers.filter((h) => h.pattern !== pattern);
	}

	public hasPattern(pattern: string): boolean {
		return this.handlers.some((h) => h.pattern === pattern);
	}

	public clear(): void {
		this.handlers = [];
	}

	public route(
		topic: string,
		payload: Buffer,
		onHandlerError?: (pattern: string, error: unknown) => void
	): void {
		for (const subscription of this.handlers) {
			if (this.topicMatches(subscription.pattern, topic)) {
				try {
					subscription.handler(topic, payload);
				} catch (error) {
					onHandlerError?.(subscription.pattern, error);
				}
			}
		}
	}

	public topicMatches(pattern: string, topic: string): boolean {
		const patternParts = pattern.split('/');
		const topicParts = topic.split('/');

		if (patternParts.length !== topicParts.length && !pattern.includes('#')) {
			return false;
		}

		for (let i = 0; i < patternParts.length; i++) {
			if (patternParts[i] === '#') {
				return true; // Multi-level wildcard matches everything after
			}
			if (patternParts[i] === '+') {
				continue; // Single-level wildcard matches any value at this level
			}
			if (patternParts[i] !== topicParts[i]) {
				return false;
			}
		}

		return patternParts.length === topicParts.length;
	}
}
