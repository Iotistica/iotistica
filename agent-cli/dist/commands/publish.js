"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishPublishersList = publishPublishersList;
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
/**
 * iotctl publish publishers list [--include-disabled]
 */
async function publishPublishersList() {
    const includeDisabled = hasFlag('include-disabled');
    try {
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/publish/publishers?includeDisabled=${includeDisabled ? 'true' : 'false'}`);
        const publishers = result.publishers || [];
        if (publishers.length === 0) {
            core_1.logger.info('No publishers configured');
            return;
        }
        core_1.logger.info(`Found ${publishers.length} publisher${publishers.length === 1 ? '' : 's'}`);
        for (const publisher of publishers) {
            core_1.logger.info(`Publisher ${publisher.name || '(unnamed)'}`, {
                id: publisher.id,
                type: publisher.type,
                enabled: publisher.enabled,
            });
        }
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to list publishers', 1, {
            error: error.message,
        });
    }
}
/**
 * iotctl publish subscriptions list [--publisher-id <id>] [--include-disabled]
 */
async function publishSubscriptionsList() {
    const includeDisabled = hasFlag('include-disabled');
    const publisherIdRaw = getFlag('publisher-id');
    let publisherQuery = '';
    if (publisherIdRaw !== undefined) {
        const publisherId = Number(publisherIdRaw);
        if (!Number.isFinite(publisherId)) {
            throw new core_1.CLIError('Invalid --publisher-id value', 1, {
                publisherId: publisherIdRaw,
            });
        }
        publisherQuery = `&publisher_id=${publisherId}`;
    }
    try {
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/publish/subscriptions?includeDisabled=${includeDisabled ? 'true' : 'false'}${publisherQuery}`);
        const subscriptions = result.subscriptions || [];
        if (subscriptions.length === 0) {
            core_1.logger.info('No subscriptions configured');
            return;
        }
        core_1.logger.info(`Found ${subscriptions.length} subscription${subscriptions.length === 1 ? '' : 's'}`);
        for (const subscription of subscriptions) {
            core_1.logger.info(`Subscription ${subscription.id ?? '(unknown)'}`, {
                publisher_id: subscription.publisher_id,
                topics: subscription.topics,
                payload_format: subscription.payload_format,
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
async function resolvePublisherId(input) {
    if (input.publisherIdRaw) {
        const parsed = Number(input.publisherIdRaw);
        if (!Number.isFinite(parsed)) {
            throw new core_1.CLIError('Invalid --publisher-id value', 1, {
                publisherId: input.publisherIdRaw,
            });
        }
        return parsed;
    }
    if (!input.publisherName) {
        throw new core_1.CLIError('Either --publisher-id or --publisher-name is required', 1, {
            usage: 'iotctl publish subscriptions add --publisher-id <id> [--topics modbus,opcua] [--payload-format custom|tags|ecp] [--include-devices d1,d2] [--exclude-devices d3] [--disabled]',
        });
    }
    const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/publish/publishers?includeDisabled=true`);
    const publishers = result.publishers || [];
    const publisher = publishers.find((item) => item.name === input.publisherName);
    if (!publisher?.id) {
        throw new core_1.CLIError(`Publisher not found: ${input.publisherName}`, 1, {
            hint: 'Use API GET /v1/publish/publishers or provide --publisher-id directly.',
        });
    }
    return publisher.id;
}
/**
 * iotctl publish subscriptions add --publisher-id <id>
 *   [--topics modbus,opcua,mqtt,system] [--payload-format custom|tags|ecp]
 *   [--include-devices d1,d2] [--exclude-devices d3] [--disabled]
 */
async function publishSubscriptionsAdd() {
    const publisherIdRaw = getFlag('publisher-id');
    const publisherName = getFlag('publisher-name');
    const topics = parseCsv(getFlag('topics'));
    const includeDevices = parseCsv(getFlag('include-devices'));
    const excludeDevices = parseCsv(getFlag('exclude-devices'));
    const payloadFormat = (getFlag('payload-format') || 'custom').trim().toLowerCase();
    const enabled = !hasFlag('disabled');
    if (!['custom', 'tags', 'ecp'].includes(payloadFormat)) {
        throw new core_1.CLIError('Invalid --payload-format value', 1, {
            payloadFormat,
            supported: 'custom, tags, ecp',
        });
    }
    const publisherId = await resolvePublisherId({ publisherIdRaw, publisherName });
    const routeJson = includeDevices.length > 0 || excludeDevices.length > 0
        ? {
            ...(includeDevices.length > 0 ? { includeDevices } : {}),
            ...(excludeDevices.length > 0 ? { excludeDevices } : {}),
        }
        : null;
    try {
        const result = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/publish/subscriptions`, {
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
        core_1.logger.info('Publish subscription created', {
            id: subscription?.id,
            publisher_id: subscription?.publisher_id,
            payload_format: subscription?.payload_format,
            enabled: subscription?.enabled,
            topics: subscription?.topics,
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
 *   [--topics modbus,opcua,mqtt,system] [--payload-format custom|tags|ecp]
 *   [--include-devices d1,d2] [--exclude-devices d3] [--disabled]
 */
async function publishMqttAdd() {
    const name = getFlag('name');
    const broker = getFlag('broker');
    const username = getFlag('username');
    const password = getFlag('password');
    const clientId = getFlag('client-id');
    const topicTemplate = getFlag('topic-template') || '{topic}';
    const topics = parseCsv(getFlag('topics'));
    const includeDevices = parseCsv(getFlag('include-devices'));
    const excludeDevices = parseCsv(getFlag('exclude-devices'));
    const payloadFormat = (getFlag('payload-format') || 'custom').trim().toLowerCase();
    const enabled = !hasFlag('disabled');
    if (!name) {
        throw new core_1.CLIError('--name is required', 1, {
            usage: 'iotctl publish mqtt add --name <name> --broker mqtt://host:1883 [--topics modbus,opcua,mqtt,system]',
        });
    }
    if (!broker) {
        throw new core_1.CLIError('--broker is required', 1, {
            usage: 'iotctl publish mqtt add --name <name> --broker mqtt://host:1883',
        });
    }
    if (!['custom', 'tags', 'ecp'].includes(payloadFormat)) {
        throw new core_1.CLIError('Invalid --payload-format value', 1, {
            payloadFormat,
            supported: 'custom, tags, ecp',
        });
    }
    const routeJson = includeDevices.length > 0 || excludeDevices.length > 0
        ? {
            ...(includeDevices.length > 0 ? { includeDevices } : {}),
            ...(excludeDevices.length > 0 ? { excludeDevices } : {}),
        }
        : null;
    try {
        const publisherResult = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/publish/publishers`, {
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
        const subscriptionResult = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/publish/subscriptions`, {
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
        core_1.logger.info('MQTT publish destination created', {
            publisher_id: publisher.id,
            publisher_name: publisher.name,
            subscription_id: subscription?.id,
            topics: subscription?.topics,
            payload_format: subscription?.payload_format,
            enabled,
        });
        core_1.logger.warn('Note: mqtt publisher runtime currently reads broker settings from environment variables.', {
            expectedEnv: 'EXTERNAL_MQTT_BROKER_URL, EXTERNAL_MQTT_USERNAME, EXTERNAL_MQTT_PASSWORD, EXTERNAL_MQTT_CLIENT_ID, EXTERNAL_MQTT_TOPIC_TEMPLATE',
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