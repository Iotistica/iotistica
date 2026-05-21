/**
 * iotctl provision <key> --api <endpoint> [--name <device-name>] [--type <device-type>]
 */
export declare function provisionWithKey(key: string): Promise<void>;
/**
 * iotctl provision status
 */
export declare function provisionStatus(): Promise<void>;
/**
 * iotctl deprovision
 */
export declare function deprovision(): Promise<void>;
/**
 * iotctl mqtt users
 */
export declare function mqttListUsers(): Promise<void>;
/**
 * iotctl factory-reset
 */
export declare function factoryReset(): Promise<void>;
//# sourceMappingURL=provision.d.ts.map