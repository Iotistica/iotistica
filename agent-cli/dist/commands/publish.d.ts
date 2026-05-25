/**
 * iotctl publish destinations list [--include-disabled]
 */
export declare function publishDestinationsList(): Promise<void>;
/**
 * iotctl publish subscriptions list [--publish-destination-id <id>] [--include-disabled]
 */
export declare function publishSubscriptionsList(): Promise<void>;
/**
 * iotctl publish subscriptions add --publish-destination-id <id>
 *   [--protocols modbus,opcua,mqtt,system] [--payload-format custom|tags|ecp]
 *   [--include-devices d1,d2] [--exclude-devices d3] [--disabled]
 */
export declare function publishSubscriptionsAdd(): Promise<void>;
/**
 * iotctl publish mqtt add --name <name> --broker <mqtt://host:1883>
 *   [--username u] [--password p] [--client-id id] [--topic-template tpl]
 *   [--disabled]
 */
export declare function publishMqttAdd(): Promise<void>;
//# sourceMappingURL=publish.d.ts.map