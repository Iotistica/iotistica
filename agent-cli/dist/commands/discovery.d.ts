/**
 * iotctl discover [<protocol>] [--validate]
 */
export declare function discover(protocolArg?: string): Promise<void>;
/**
 * iotctl devices list [--protocol <protocol>]
 */
export declare function devicesList(protocolFilter?: string): Promise<void>;
/**
 * iotctl devices clean [--force]
 * Remove ALL devices from the agent configuration
 */
export declare function endpointsClean(): Promise<void>;
//# sourceMappingURL=discovery.d.ts.map