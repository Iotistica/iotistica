export declare function adaptersList(): Promise<void>;
export declare function adaptersShow(name?: string): Promise<void>;
export declare function adaptersRemove(uuid?: string): Promise<void>;
export declare function adaptersEnable(uuid?: string): Promise<void>;
export declare function adaptersDisable(uuid?: string): Promise<void>;
/**
 * iotctl adapters add-mqtt --name <name> --broker <url>
 *   [--username <user>] [--password <pass>] [--topics <t1,t2>]
 *   [--interval <ms>] [--disabled]
 */
export declare function mqttAdd(): Promise<void>;
/**
 * iotctl adapters add-modbus --name <name> --host <ip>
 *   [--port <port>] [--slave <id>] [--interval <ms>] [--disabled]
 */
export declare function modbusAdd(): Promise<void>;
/**
 * iotctl adapters add-opcua --name <name> --endpoint opc.tcp://host:4840
 *   [--interval <ms>] [--disabled]
 */
export declare function opcuaAdd(): Promise<void>;
/**
 * iotctl adapters add-snmp --name <name> --host <ip>
 *   [--port <port>] [--community <community>] [--interval <ms>] [--disabled]
 */
export declare function snmpAdd(): Promise<void>;
/**
 * iotctl adapters add --protocol <protocol> ...
 * Generic dispatcher: routes to the protocol-specific add command.
 */
export declare function adaptersAdd(): Promise<void>;
//# sourceMappingURL=adapters.d.ts.map