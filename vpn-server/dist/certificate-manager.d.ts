import { CertificateInfo, DeviceCertificateRequest, DeviceCertificateResponse, CertificateRevocationRequest, PKIConfig, Logger } from './types';
export declare class CertificateManager {
    private config;
    private logger;
    private caCert?;
    private caKey?;
    private tlsAuthKey?;
    private certificates;
    constructor(config: PKIConfig, logger: Logger);
    initialize(): Promise<void>;
    generateDeviceCertificate(request: DeviceCertificateRequest): Promise<DeviceCertificateResponse>;
    revokeCertificate(request: CertificateRevocationRequest): Promise<void>;
    getCertificate(serialNumber: string): CertificateInfo | undefined;
    getCustomerCertificates(customerId: string): CertificateInfo[];
    getCertificatesExpiringSoon(days?: number): CertificateInfo[];
    private loadCA;
    private loadTLSAuthKey;
    private loadExistingCertificates;
    private generateCommonName;
    private generateSerialNumber;
    private generateClientConfig;
    private saveCertificateFiles;
    private updateCRL;
}
//# sourceMappingURL=certificate-manager.d.ts.map