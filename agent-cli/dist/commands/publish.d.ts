/**
 * iotctl publish publishers list [--include-disabled]
 */
export declare function publishPublishersList(): Promise<void>;
/**
 * iotctl publish subscriptions list [--publisher-id <id>] [--include-disabled]
 */
export declare function publishSubscriptionsList(): Promise<void>;
/**
 * iotctl publish subscriptions add --publisher-id <id>
 *   [--topics modbus,opcua,mqtt,system] [--payload-format custom|tags|ecp]
 *   [--include-devices d1,d2] [--exclude-devices d3] [--disabled]
 */
export declare function publishSubscriptionsAdd(): Promise<void>;
/**
 * iotctl publish mqtt add --name <name> --broker <mqtt://host:1883>
 *   [--username u] [--password p] [--client-id id] [--topic-template tpl]
 *   [--topics modbus,opcua,mqtt,system] [--payload-format custom|tags|ecp]
 *   [--include-devices d1,d2] [--exclude-devices d3] [--disabled]
 */
export declare function publishMqttAdd(): Promise<void>;
//# sourceMappingURL=publish.d.ts.map