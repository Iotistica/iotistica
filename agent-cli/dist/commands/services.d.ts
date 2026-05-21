/**
 * iotctl services list [<appId>]
 */
export declare function servicesList(appId?: string): Promise<void>;
/**
 * iotctl services start <serviceId>
 */
export declare function servicesStart(serviceId: string): Promise<void>;
/**
 * iotctl services stop <serviceId>
 */
export declare function servicesStop(serviceId: string): Promise<void>;
/**
 * iotctl services restart <serviceId>
 */
export declare function servicesRestart(serviceId: string): Promise<void>;
/**
 * iotctl services logs <serviceId> [-f]
 */
export declare function servicesLogs(serviceId: string, follow?: boolean): Promise<void>;
/**
 * iotctl services info <serviceId>
 */
export declare function servicesInfo(serviceId: string): Promise<void>;
//# sourceMappingURL=services.d.ts.map