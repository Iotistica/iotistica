/**
 * iotctl db backup [<name>]
 */
export declare function dbBackup(nameArg?: string): Promise<void>;
/**
 * iotctl db backups list
 */
export declare function dbList(): Promise<void>;
/**
 * iotctl db stats
 */
export declare function dbStats(): Promise<void>;
/**
 * iotctl db verify [<target>]
 */
export declare function dbVerify(targetArg?: string): Promise<void>;
/**
 * iotctl db restore [<target>]
 */
export declare function dbRestore(targetArg?: string): Promise<void>;
/**
 * iotctl db prune [--keep <count>]
 */
export declare function dbPrune(keepArg?: string): Promise<void>;
//# sourceMappingURL=db.d.ts.map