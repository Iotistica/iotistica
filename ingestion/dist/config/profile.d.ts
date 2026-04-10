export type IngestionProfile = 'batch' | 'balanced' | 'streaming';
interface AppliedProfileConfig {
    requestedProfile: string;
    resolvedProfile: IngestionProfile;
    appliedDefaults: string[];
}
export declare function applyIngestionProfile(): AppliedProfileConfig;
export {};
//# sourceMappingURL=profile.d.ts.map