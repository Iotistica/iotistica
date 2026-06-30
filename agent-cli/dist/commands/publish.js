"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishDestinationsList = publishDestinationsList;
exports.publishSubscriptionsList = publishSubscriptionsList;
exports.publishSubscriptionsAdd = publishSubscriptionsAdd;
exports.publishMqttAdd = publishMqttAdd;
const core_1 = require("../core");
function getFlag(name) {
    const args = process.argv;
    const idx = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (idx === -1)
        return undefined;
    if (args[idx].includes('='))
        return args[idx].split('=').slice(1).join('=');
    return args[idx + 1];
}
function hasFlag(name) {
    return process.argv.includes(`--${name}`);
}
function parseCsv(input) {
    if (!input)
        return [];
    return input
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
}
function normalizeTopicsForDisplay(rawTopics) {
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
async function publishDestinationsList() {
    const includeDisabled = hasFlag('include-disabled');
    try {
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/publish/destinations?includeDisabled=${includeDisabled ? 'true' : 'false'}`);
        const publish_destinations = result.destinations || result.publishers || [];
        if (publish_destinations.length === 0) {
            core_1.logger.info('No publish destinations configured');
            return;
        }
        core_1.logger.info(`Found ${publish_destinations.length} publish destinations${publish_destinations.length === 1 ? '' : 's'}`);
        for (const destination of publish_destinations) {
            core_1.logger.info(`Destination ${destination.name || '(unnamed)'}`, {
                id: destination.id,
                type: destination.type,
                enabled: destination.enabled,
            });
        }
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to list publish destinations', 1, {
            error: error.message,
        });
    }
}
/**
 * iotctl publish subscriptions list [--publish-destination-id <id>] [--include-disabled]
 */
async function publishSubscriptionsList() {
    const includeDisabled = hasFlag('include-disabled');
    const publishDestinationIdRaw = getFlag('publish-destination-id');
    let destinationQuery = '';
    if (publishDestinationIdRaw !== undefined) {
        const publishDestinationId = Number(publishDestinationIdRaw);
        if (!Number.isFinite(publishDestinationId)) {
            throw new core_1.CLIError('Invalid --publish-destination-id value', 1, {
                publishDestinationId: publishDestinationIdRaw,
            });
        }
        destinationQuery = `&publish_destination_id=${publishDestinationId}`;
    }
    try {
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/publish/subscriptions?includeDisabled=${includeDisabled ? 'true' : 'false'}${destinationQuery}`);
        const subscriptions = result.subscriptions || [];
        if (subscriptions.length === 0) {
            core_1.logger.info('No subscriptions configured');
            return;
        }
        core_1.logger.info(`Found ${subscriptions.length} subscription${subscriptions.length === 1 ? '' : 's'}`);
        for (const subscription of subscriptions) {
            const routeJson = subscription.route_json && typeof subscription.route_json === 'object'
                ? subscription.route_json
                : null;
            core_1.logger.info(`Subscription ${subscription.id ?? '(unknown)'}`, {
                publish_destination_id: subscription.publish_destination_id,
                protocols: normalizeTopicsForDisplay(subscription.topics),
                payload_format: subscription.payload_format,
                compression: subscription.compression ?? null,
                destination_topic: routeJson?.topic || null,
                enabled: subscription.enabled,
            });
        }
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to list subscriptions', 1, {
            error: error.message,
        });
    }
}
async function resolveDestinationId(input) {
    if (input.publishDestinationIdRaw) {
        const parsed = Number(input.publishDestinationIdRaw);
        if (!Number.isFinite(parsed)) {
            throw new core_1.CLIError('Invalid --publish-destination-id value', 1, {
                publishDestinationId: input.publishDestinationIdRaw,
            });
        }
        return parsed;
    }
    if (!input.publishDestinationName) {
        throw new core_1.CLIError('Either --publish-destination-id or --destination-name is required', 1, {
            usage: 'iotctl publish subscriptions add --publish-destination-id <id> [--destination-name <name>] [--protocols modbus,opcua] [--payload-format custom|tags|ecp] [--include-devices d1,d2] [--exclude-devices d3] [--disabled]',
        });
    }
    const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/publish/destinations?includeDisabled=true`);
    const destinations = result.destinations || result.publishers || [];
    const destination = destinations.find((item) => item.name === input.publishDestinationName);
    if (!destination?.id) {
        throw new core_1.CLIError(`Destination not found: ${input.publishDestinationName}`, 1, {
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
async function publishSubscriptionsAdd() {
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
        throw new core_1.CLIError('Invalid --payload-format value', 1, {
            payloadFormat,
            supported: 'custom, tags, ecp',
        });
    }
    const VALID_COMPRESSIONS = ['json', 'msgpack', 'json+deflate', 'msgpack+deflate'];
    if (compression !== null && !VALID_COMPRESSIONS.includes(compression)) {
        throw new core_1.CLIError('Invalid --compression value', 1, {
            compression,
            supported: VALID_COMPRESSIONS.join(', '),
        });
    }
    const publishDestinationId = await resolveDestinationId({ publishDestinationIdRaw, publishDestinationName: publisherName });
    const routeJson = includeDevices.length > 0 || excludeDevices.length > 0 || destinationTopic.length > 0
        ? {
            ...(destinationTopic.length > 0 ? { topic: destinationTopic } : {}),
            ...(includeDevices.length > 0 ? { includeDevices } : {}),
            ...(excludeDevices.length > 0 ? { excludeDevices } : {}),
        }
        : null;
    if (!destinationTopic) {
        throw new core_1.CLIError('--destination-topic is required', 1, {
            usage: 'iotctl publish subscriptions add --publish-destination-id <id> --destination-topic <topic> [--protocols modbus,opcua] [--payload-format custom|tags|ecp] [--compression json|msgpack|json+deflate|msgpack+deflate]',
        });
    }
    try {
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/publish/subscriptions`, {
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
        core_1.logger.info('Publish subscription created', {
            id: subscription?.id,
            publish_destination_id: subscription?.publish_destination_id,
            payload_format: subscription?.payload_format,
            compression: subscription?.compression ?? null,
            enabled: subscription?.enabled,
            protocols: subscription?.topics,
        });
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to create publish subscription', 1, {
            error: error.message,
        });
    }
}
/**
 * iotctl publish mqtt add --name <name> --broker <mqtt://host:1883>
 *   [--username u] [--password p] [--client-id id] [--topic-template tpl]
 *   [--disabled]
 */
async function publishMqttAdd() {
    const name = getFlag('name');
    const broker = getFlag('broker');
    const username = getFlag('username');
    const password = getFlag('password');
    const clientId = getFlag('client-id');
    const topicTemplate = getFlag('topic-template') || '{topic}';
    const enabled = !hasFlag('disabled');
    if (!name) {
        throw new core_1.CLIError('--name is required', 1, {
            usage: 'iotctl publish mqtt add --name <name> --broker mqtt://host:1883',
        });
    }
    if (!broker) {
        throw new core_1.CLIError('--broker is required', 1, {
            usage: 'iotctl publish mqtt add --name <name> --broker mqtt://host:1883',
        });
    }
    try {
        const publisherResult = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/publish/destinations`, {
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
        core_1.logger.info('MQTT publish destination created', {
            publish_destination_id: publisher.id,
            publisher_name: publisher.name,
            enabled,
        });
        core_1.logger.info('MQTT publisher configuration stored in database and will be used at runtime', {
            brokerUrl: broker,
            clientId: clientId || '(auto-generated)',
            topicTemplate: topicTemplate,
        });
        core_1.logger.info('No subscription was created automatically. Add one with:', {
            example: `iotctl publish subscriptions add --publish-destination-id ${publisher.id} --destination-topic <topic>`,
        });
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to create MQTT publish destination', 1, {
            error: error.message,
        });
    }
}
//# sourceMappingURL=publish.js.map