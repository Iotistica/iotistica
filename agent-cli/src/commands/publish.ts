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
 * iotctl publish publishers list [--include-disabled]
 */
export async function publishDestinationsList(): Promise<void> {
  const includeDisabled = hasFlag('include-disabled');

  try {
    const result = await apiRequest(
      `${DEVICE_API_V1}/publish/destinations?includeDisabled=${includeDisabled ? 'true' : 'false'}`,
    );
    const publish_destinations: Array<Record<string, any>> = result.publishers || [];

    if (publish_destinations.length === 0) {
      logger.info('No publishers configured');
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
 * iotctl publish subscriptions list [--publisher-id <id>] [--include-disabled]
 */
export async function publishSubscriptionsList(): Promise<void> {
  const includeDisabled = hasFlag('include-disabled');
  const publisherIdRaw = getFlag('publisher-id');
  let publisherQuery = '';

  if (publisherIdRaw !== undefined) {
    const publisherId = Number(publisherIdRaw);
    if (!Number.isFinite(publisherId)) {
      throw new CLIError('Invalid --publisher-id value', 1, {
        publisherId: publisherIdRaw,
      });
    }

    publisherQuery = `&publisher_id=${publisherId}`;
  }

  try {
    const result = await apiRequest(
      `${DEVICE_API_V1}/publish/subscriptions?includeDisabled=${includeDisabled ? 'true' : 'false'}${publisherQuery}`,
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
        publisher_id: subscription.publisher_id,
        topics: normalizeTopicsForDisplay(subscription.topics),
        payload_format: subscription.payload_format,
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
    throw new CLIError('Either --publisher-id or --publisher-name is required', 1, {
      usage: 'iotctl publish subscriptions add --publisher-id <id> [--topics modbus,opcua] [--payload-format custom|tags|ecp] [--include-devices d1,d2] [--exclude-devices d3] [--disabled]',
    });
  }

  const result = await apiRequest(`${DEVICE_API_V1}/publish/destinations?includeDisabled=true`);
  const destinations: Array<{ id?: number; name?: string }> = result.publishers || [];
  const destination = destinations.find((item) => item.name === input.publishDestinationName);

  if (!destination?.id) {
    throw new CLIError(`Destination not found: ${input.publishDestinationName}`, 1, {
      hint: 'Use API GET /v1/publish/destinations or provide --publisher-id directly.',
    });
  }

  return destination.id;
}

/**
 * iotctl publish subscriptions add --publisher-id <id>
 *   [--topics modbus,opcua,mqtt,system] [--payload-format custom|tags|ecp]
 *   [--include-devices d1,d2] [--exclude-devices d3] [--disabled]
 */
export async function publishSubscriptionsAdd(): Promise<void> {
  const publisherIdRaw = getFlag('publisher-id');
  const publisherName = getFlag('publisher-name');
  const topics = parseCsv(getFlag('topics'));
  const includeDevices = parseCsv(getFlag('include-devices'));
  const excludeDevices = parseCsv(getFlag('exclude-devices'));
  const destinationTopic = (getFlag('destination-topic') || '').trim();
  const payloadFormat = (getFlag('payload-format') || 'custom').trim().toLowerCase();
  const enabled = !hasFlag('disabled');

  if (!['custom', 'tags', 'ecp'].includes(payloadFormat)) {
    throw new CLIError('Invalid --payload-format value', 1, {
      payloadFormat,
      supported: 'custom, tags, ecp',
    });
  }

  const publisherId = await resolveDestinationId({ publishDestinationIdRaw: publisherIdRaw, publishDestinationName: publisherName });

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
      usage: 'iotctl publish subscriptions add --publisher-id <id> --destination-topic <topic> [--topics modbus,opcua] [--payload-format custom|tags|ecp]',
    });
  }

  try {
    const result = await apiRequest(`${DEVICE_API_V1}/publish/subscriptions`, {
      method: 'POST',
      body: JSON.stringify({
        publisher_id: publisherId,
        topics,
        payload_format: payloadFormat,
        route_json: routeJson,
        enabled,
      }),
    });

    const subscription = result.subscription;
    logger.info('Publish subscription created', {
      id: subscription?.id,
      publisher_id: subscription?.publisher_id,
      payload_format: subscription?.payload_format,
      enabled: subscription?.enabled,
      topics: subscription?.topics,
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
 *   [--topics modbus,opcua,mqtt,system] [--payload-format custom|tags|ecp]
 *   [--include-devices d1,d2] [--exclude-devices d3] [--disabled]
 */
export async function publishMqttAdd(): Promise<void> {
  const name = getFlag('name');
  const broker = getFlag('broker');
  const username = getFlag('username');
  const password = getFlag('password');
  const clientId = getFlag('client-id');
  const topicTemplate = getFlag('topic-template') || '{topic}';
  const destinationTopic = (getFlag('destination-topic') || '').trim();
  const topics = parseCsv(getFlag('topics'));
  const includeDevices = parseCsv(getFlag('include-devices'));
  const excludeDevices = parseCsv(getFlag('exclude-devices'));
  const payloadFormat = (getFlag('payload-format') || 'custom').trim().toLowerCase();
  const enabled = !hasFlag('disabled');

  if (!name) {
    throw new CLIError('--name is required', 1, {
      usage: 'iotctl publish mqtt add --name <name> --broker mqtt://host:1883 [--topics modbus,opcua,mqtt,system]',
    });
  }

  if (!broker) {
    throw new CLIError('--broker is required', 1, {
      usage: 'iotctl publish mqtt add --name <name> --broker mqtt://host:1883',
    });
  }

  if (!['custom', 'tags', 'ecp'].includes(payloadFormat)) {
    throw new CLIError('Invalid --payload-format value', 1, {
      payloadFormat,
      supported: 'custom, tags, ecp',
    });
  }

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
      usage: 'iotctl publish mqtt add --name <name> --broker mqtt://host:1883 --destination-topic <topic> [--topics modbus,opcua,mqtt,system] [--payload-format custom|tags|ecp]',
    });
  }

  try {
    const publisherResult = await apiRequest(`${DEVICE_API_V1}/publish/publishers`, {
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

    const subscriptionResult = await apiRequest(`${DEVICE_API_V1}/publish/subscriptions`, {
      method: 'POST',
      body: JSON.stringify({
        publisher_id: publisher.id,
        topics,
        payload_format: payloadFormat,
        route_json: routeJson,
        enabled,
      }),
    });

    const subscription = subscriptionResult.subscription;

    logger.info('MQTT publish destination created', {
      publisher_id: publisher.id,
      publisher_name: publisher.name,
      subscription_id: subscription?.id,
      topics: subscription?.topics,
      payload_format: subscription?.payload_format,
      enabled,
    });

    logger.info('MQTT publisher configuration stored in database and will be used at runtime', {
      brokerUrl: broker,
      clientId: clientId || '(auto-generated)',
      topicTemplate: topicTemplate,
    });
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to create MQTT publish destination', 1, {
      error: (error as Error).message,
    });
  }
}
