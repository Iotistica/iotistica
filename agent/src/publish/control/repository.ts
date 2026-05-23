import { normalizeTarget } from '../core/types.js';
import { PublishersModel, PublishSubscriptionsModel } from '../../db/models/index.js';
import type { PublishPayloadFormat } from '../../db/models/index.js';

export interface EnsureDefaultPublishControlInput {
	targetFromEnv?: string;
	defaultPayloadFormat: PublishPayloadFormat;
}

export class PublishControlRepository {
	public async ensureDefaultFromLegacyEnv(input: EnsureDefaultPublishControlInput): Promise<void> {
		const allPublishers = PublishersModel.getAll(true);
		if (allPublishers.length > 0) {
			return;
		}

		const target = normalizeTarget(input.targetFromEnv);
		const createdPublisher = PublishersModel.create({
			name: `default-${target}`,
			type: target,
			config_json: null,
			enabled: true,
		});

		if (!createdPublisher?.id) {
			return;
		}

		PublishSubscriptionsModel.create({
			publisher_id: createdPublisher.id,
			topics: [],
			route_json: null,
			payload_format: input.defaultPayloadFormat,
			enabled: true,
		});
	}
}
