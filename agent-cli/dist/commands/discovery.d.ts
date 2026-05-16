export declare function discover(protocolArg?: string): Promise<void>;
export declare function devicesList(protocolFilter?: string): Promise<void>;
export declare function endpointsList(protocolFilter?: string): Promise<void>;
export declare function endpointsShow(endpointName?: string): Promise<void>;
/**
 * iotctl endpoints add --name <name> --protocol mqtt --broker <url>
 *   [--username <user>] [--password <pass>] [--topics <t1,t2>]
 *   [--interval <ms>] [--disabled]
 * Also supports: --protocol modbus --host <ip> --port <port> --slave <id>
 */
export declare function endpointsAdd(): Promise<void>;
/**
 * iotctl endpoints remove <uuid>
 */
export declare function endpointsRemove(uuid?: string): Promise<void>;
/**
 * iotctl endpoints clean [--force]
 * Remove ALL endpoints from the agent configuration
 */
export declare function endpointsClean(): Promise<void>;
//# sourceMappingURL=discovery.d.ts.map