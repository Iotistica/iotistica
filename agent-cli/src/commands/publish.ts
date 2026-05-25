import { DEVICE_API_V1, CLIError, apiRequest, logger } from '../core';

function getFlag(name: string): string | undefined {
  const args = process.argv;
  const idx = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (idx === -1) return undefined;
  if (args[idx].includes('=')) return args[idx].split('=').slice(1).join('=');
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseCsv(input?: string): string[] {
  if (!input) return [];
  return input
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeTopicsForDisplay(rawTopics: unknown): string[] | string {
  if (!Array.isArray(rawTopics) || rawTopics.length === 0) {
    return '(all protocols)';
  }

  const topics = rawTopics
    .map((value) => String(value).trim())
    .filter(Boolean);

  return topics.length > 0 ? topics : '(all protocols)';
}

/**
 * iotctl publish destinations list [--include-disabled]
 */
export async function publishDestinationsList(): Promise<void> {
  const includeDisabled = hasFlag('include-disabled');

  try {
    const result = await apiRequest(
      `${DEVICE_API_V1}/publish/destinations?includeDisabled=${includeDisabled ? 'true' : 'false'}`,
    );
    const publish_destinations: Array<Record<string, any>> = result.destinations || result.publishers || [];

    if (publish_destinations.length === 0) {
      logger.info('No publish destinations configured');
      return;
    }

    logger.info(`Found ${publish_destinations.length} publish destinations${publish_destinations.length === 1 ? '' : 's'}`);
    for (const destination of publish_destinations) {
      logger.info(`Destination ${destination.name || '(unnamed)'}`, {
        id: destination.id,
        type: destination.type,
        enabled: destination.enabled,
      });
    }
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to list publish destinations', 1, {
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl publish subscriptions list [--publish-destination-id <id>] [--include-disabled]
 */
export async function publishSubscriptionsList(): Promise<void> {
  const includeDisabled = hasFlag('include-disabled');
  const publishDestinationIdRaw = getFlag('publish-destination-id');
  let destinationQuery = '';

  if (publishDestinationIdRaw !== undefined) {
    const publishDestinationId = Number(publishDestinationIdRaw);
    if (!Number.isFinite(publishDestinationId)) {
      throw new CLIError('Invalid --publish-destination-id value', 1, {
        publishDestinationId: publishDestinationIdRaw,
      });
    }

    destinationQuery = `&publish_destination_id=${publishDestinationId}`;
  }

  try {
    const result = await apiRequest(
      `${DEVICE_API_V1}/publish/subscriptions?includeDisabled=${includeDisabled ? 'true' : 'false'}${destinationQuery}`,
    );
    const subscriptions: Array<Record<string, any>> = result.subscriptions || [];

    if (subscriptions.length === 0) {
      logger.info('No subscriptions configured');
      return;
    }

    logger.info(`Found ${subscriptions.length} subscription${subscriptions.length === 1 ? '' : 's'}`);
    for (const subscription of subscriptions) {
      const routeJson = subscription.route_json && typeof subscription.route_json === 'object'
        ? subscription.route_json as Record<string, any>
        : null;
      logger.info(`Subscription ${subscription.id ?? '(unknown)'}`, {
        publish_destination_id: subscription.publish_destination_id,
        protocols: normalizeTopicsForDisplay(subscription.topics),
        payload_format: subscription.payload_format,
        compression: subscription.compression ?? null,
        destination_topic: routeJson?.topic || null,
        enabled: subscription.enabled,
      });
    }
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to list subscriptions', 1, {
      error: (error as Error).message,
    });
  }
}

async function resolveDestinationId(input: {
  publishDestinationIdRaw?: string;
  publishDestinationName?: string;
}): Promise<number> {
  if (input.publishDestinationIdRaw) {
    const parsed = Number(input.publishDestinationIdRaw);
    if (!Number.isFinite(parsed)) {
      throw new CLIError('Invalid --publish-destination-id value', 1, {
        publishDestinationId: input.publishDestinationIdRaw,
      });
    }

    return parsed;
  }

  if (!input.publishDestinationName) {
    throw new CLIError('Either --publish-destination-id or --destination-name is required', 1, {
      usage: 'iotctl publish subscriptions add --publish-destination-id <id> [--destination-name <name>] [--protocols modbus,opcua] [--payload-format custom|tags|ecp] [--include-devices d1,d2] [--exclude-devices d3] [--disabled]',
    });
  }

  const result = await apiRequest(`${DEVICE_API_V1}/publish/destinations?includeDisabled=true`);
  const destinations: Array<{ id?: number; name?: string }> = result.destinations || result.publishers || [];
  const destination = destinations.find((item) => item.name === input.publishDestinationName);

  if (!destination?.id) {
    throw new CLIError(`Destination not found: ${input.publishDestinationName}`, 1, {
      hint: 'Use API GET /v1/publish/destinations or provide --publish-destination-id directly.',
    });
  }

  return destination.id;
}

/**
 * iotctl publish subscriptions add --publish-destination-id <id>
 *   [--protocols modbus,opcua,mqtt,system] [--payload-format custom|tags|ecp]
 *   [--include-devices d1,d2] [--exclude-devices d3] [--disabled]
 */
export async function publishSubscriptionsAdd(): Promise<void> {
  const publishDestinationIdRaw = getFlag('publish-destination-id');
  const publisherName = getFlag('publisher-name') || getFlag('destination-name');
  const topics = parseCsv(getFlag('protocols') || getFlag('topics')); // --topics kept as alias
  const includeDevices = parseCsv(getFlag('include-devices'));
  const excludeDevices = parseCsv(getFlag('exclude-devices'));
  const destinationTopic = (getFlag('destination-topic') || '').trim();
  const payloadFormat = (getFlag('payload-format') || 'custom').trim().toLowerCase();
  const compressionRaw = (getFlag('compression') || '').trim().toLowerCase();
  const compression = compressionRaw || null;
  const enabled = !hasFlag('disabled');

  if (!['custom', 'tags', 'ecp'].includes(payloadFormat)) {
    throw new CLIError('Invalid --payload-format value', 1, {
      payloadFormat,
      supported: 'custom, tags, ecp',
    });
  }

  const VALID_COMPRESSIONS = ['json', 'msgpack', 'json+deflate', 'msgpack+deflate'];
  if (compression !== null && !VALID_COMPRESSIONS.includes(compression)) {
    throw new CLIError('Invalid --compression value', 1, {
      compression,
      supported: VALID_COMPRESSIONS.join(', '),
    });
  }

  const publishDestinationId = await resolveDestinationId({ publishDestinationIdRaw, publishDestinationName: publisherName });

  const routeJson: Record<string, unknown> | null =
    includeDevices.length > 0 || excludeDevices.length > 0 || destinationTopic.length > 0
      ? {
          ...(destinationTopic.length > 0 ? { topic: destinationTopic } : {}),
          ...(includeDevices.length > 0 ? { includeDevices } : {}),
          ...(excludeDevices.length > 0 ? { excludeDevices } : {}),
        }
      : null;

  if (!destinationTopic) {
    throw new CLIError('--destination-topic is required', 1, {
      usage: 'iotctl publish subscriptions add --publish-destination-id <id> --destination-topic <topic> [--protocols modbus,opcua] [--payload-format custom|tags|ecp] [--compression json|msgpack|json+deflate|msgpack+deflate]',
    });
  }

  try {
    const result = await apiRequest(`${DEVICE_API_V1}/publish/subscriptions`, {
      method: 'POST',
      body: JSON.stringify({
        publish_destination_id: publishDestinationId,
        topics,
        payload_format: payloadFormat,
        compression,
        route_json: routeJson,
        enabled,
      }),
    });

    const subscription = result.subscription;
    logger.info('Publish subscription created', {
      id: subscription?.id,
      publish_destination_id: subscription?.publish_destination_id,
      payload_format: subscription?.payload_format,
      compression: subscription?.compression ?? null,
      enabled: subscription?.enabled,
      protocols: subscription?.topics,
    });
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to create publish subscription', 1, {
      error: (error as Error).message,
    });
  }
}

/**
 * iotctl publish mqtt add --name <name> --broker <mqtt://host:1883>
 *   [--username u] [--password p] [--client-id id] [--topic-template tpl]
 *   [--disabled]
 */
export async function publishMqttAdd(): Promise<void> {
  const name = getFlag('name');
  const broker = getFlag('broker');
  const username = getFlag('username');
  const password = getFlag('password');
  const clientId = getFlag('client-id');
  const topicTemplate = getFlag('topic-template') || '{topic}';
  const enabled = !hasFlag('disabled');

  if (!name) {
    throw new CLIError('--name is required', 1, {
      usage: 'iotctl publish mqtt add --name <name> --broker mqtt://host:1883',
    });
  }

  if (!broker) {
    throw new CLIError('--broker is required', 1, {
      usage: 'iotctl publish mqtt add --name <name> --broker mqtt://host:1883',
    });
  }

  try {
    const publisherResult = await apiRequest(`${DEVICE_API_V1}/publish/destinations`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        type: 'mqtt',
        enabled,
        config_json: {
          brokerUrl: broker,
          ...(username ? { username } : {}),
          ...(password ? { password } : {}),
          ...(clientId ? { clientId } : {}),
          ...(topicTemplate ? { topicTemplate } : {}),
        },
      }),
    });

    const publisher = publisherResult.publisher;
    if (!publisher?.id) {
      throw new Error('Publisher create did not return id');
    }

    logger.info('MQTT publish destination created', {
      publish_destination_id: publisher.id,
      publisher_name: publisher.name,
      enabled,
    });

    logger.info('MQTT publisher configuration stored in database and will be used at runtime', {
      brokerUrl: broker,
      clientId: clientId || '(auto-generated)',
      topicTemplate: topicTemplate,
    });

    logger.info('No subscription was created automatically. Add one with:', {
      example: `iotctl publish subscriptions add --publish-destination-id ${publisher.id} --destination-topic <topic>`,
    });
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to create MQTT publish destination', 1, {
      error: (error as Error).message,
    });
  }
}
