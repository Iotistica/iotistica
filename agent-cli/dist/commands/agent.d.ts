/**
 * iotctl status
 */
export declare function showStatusEnhanced(): Promise<void>;
/**
 * iotctl buffer-status
 */
export declare function bufferStatus(): Promise<void>;
/**
 * iotctl memory
 */
export declare function memoryDiagnostics(): Promise<void>;
/**
 * iotctl restart
 */
export declare function restart(): Promise<void>;
/**
 * iotctl agent pull
 */
export declare function agentPullTargetState(): Promise<void>;
/**
 * iotctl diagnostics
 */
export declare function runDiagnostics(): Promise<void>;
/**
 * iotctl agent update [<version>] [--force]
 */
export declare function agentUpdate(version?: string): Promise<void>;
//# sourceMappingURL=agent.d.ts.map