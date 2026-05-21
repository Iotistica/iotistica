/**
 * iotctl devices list [--protocol <protocol>]
 */
export declare function adaptersList(): Promise<void>;
/**
 * iotctl devices show <name>
 */
export declare function adaptersShow(name?: string): Promise<void>;
/**
 * iotctl devices remove <uuid>
 */
export declare function adaptersRemove(uuid?: string): Promise<void>;
/**
 * iotctl devices enable <uuid>
 */
export declare function adaptersEnable(uuid?: string): Promise<void>;
/**
 * iotctl devices disable <uuid>
 */
export declare function adaptersDisable(uuid?: string): Promise<void>;
/**
 * iotctl devices add-mqtt --name <name> --broker <url>
 *   [--username <user>] [--password <pass>] [--topics <t1,t2>]
 *   [--interval <ms>] [--disabled]
 */
export declare function mqttAdd(): Promise<void>;
/**
 * iotctl devices add-modbus --name <name> --host <ip>
 *   [--port <port>] [--slave <id>] [--interval <ms>] [--disabled]
 */
export declare function modbusAdd(): Promise<void>;
/**
 * iotctl devices add-opcua --name <name> --endpoint opc.tcp://host:4840
 *   [--interval <ms>] [--disabled]
 */
export declare function opcuaAdd(): Promise<void>;
/**
 * iotctl devices add-snmp --name <name> --host <ip>
 *   [--port <port>] [--community <community>] [--interval <ms>] [--disabled]
 */
export declare function snmpAdd(): Promise<void>;
/**
 * iotctl devices add --protocol <protocol> ...
 * Generic dispatcher: routes to the protocol-specific add command.
 */
export declare function adaptersAdd(): Promise<void>;
//# sourceMappingURL=adapters.d.ts.map