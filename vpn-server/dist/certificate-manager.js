"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CertificateManager = void 0;
const forge = __importStar(require("node-forge"));
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
class CertificateManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.certificates = new Map();
    }
    async initialize() {
        try {
            await this.loadCA();
            await this.loadTLSAuthKey();
            await this.loadExistingCertificates();
            this.logger.info('Certificate manager initialized successfully');
        }
        catch (error) {
            this.logger.error('Failed to initialize certificate manager', { error });
            throw error;
        }
    }
    async generateDeviceCertificate(request) {
        if (!this.caCert || !this.caKey) {
            throw new Error('CA not loaded');
        }
        const { deviceId, customerId, validityDays = this.config.certValidityDays } = request;
        const commonName = this.generateCommonName(deviceId, customerId);
        this.logger.info('Generating device certificate', { deviceId, customerId, commonName });
        try {
            const keys = forge.pki.rsa.generateKeyPair(this.config.keySize);
            const cert = forge.pki.createCertificate();
            const serialNumber = this.generateSerialNumber();
            cert.publicKey = keys.publicKey;
            cert.serialNumber = serialNumber;
            cert.validity.notBefore = new Date();
            cert.validity.notAfter = new Date();
            cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + validityDays);
            const attrs = [
                { name: 'commonName', value: commonName },
                { name: 'organizationName', value: `Iotistic-Customer-${customerId}` },
                { name: 'organizationalUnitName', value: 'IoT-Device' },
                { name: 'countryName', value: 'CA' }
            ];
            cert.setSubject(attrs);
            cert.setIssuer(this.caCert.subject.attributes);
            cert.setExtensions([
                {
                    name: 'basicConstraints',
                    cA: false
                },
                {
                    name: 'keyUsage',
                    keyCertSign: false,
                    digitalSignature: true,
                    nonRepudiation: true,
                    keyEncipherment: true,
                    dataEncipherment: true
                },
                {
                    name: 'extKeyUsage',
                    clientAuth: true
                },
                {
                    name: 'subjectAltName',
                    altNames: [
                        {
                            type: 2,
                            value: `device-${deviceId}.iotistic.internal`
                        },
                        {
                            type: 7,
                            ip: '127.0.0.1'
                        }
                    ]
                }
            ]);
            cert.sign(this.caKey, forge.md.sha256.create());
            const certPem = forge.pki.certificateToPem(cert);
            const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
            const caPem = forge.pki.certificateToPem(this.caCert);
            const certInfo = {
                serialNumber,
                commonName,
                deviceId,
                customerId,
                issuedAt: cert.validity.notBefore,
                expiresAt: cert.validity.notAfter,
                revoked: false
            };
            this.certificates.set(serialNumber, certInfo);
            const clientConfig = await this.generateClientConfig(certPem, keyPem, caPem);
            const response = {
                deviceId,
                customerId,
                commonName,
                certificate: certPem,
                privateKey: keyPem,
                caCertificate: caPem,
                tlsAuthKey: this.tlsAuthKey || '',
                clientConfig,
                serialNumber,
                expiresAt: cert.validity.notAfter
            };
            await this.saveCertificateFiles(deviceId, response);
            this.logger.info('Device certificate generated successfully', {
                deviceId,
                customerId,
                serialNumber,
                expiresAt: cert.validity.notAfter
            });
            return response;
        }
        catch (error) {
            this.logger.error('Failed to generate device certificate', { deviceId, customerId, error });
            throw error;
        }
    }
    async revokeCertificate(request) {
        const { serialNumber, deviceId, reason = 'unspecified' } = request;
        let targetSerial = serialNumber;
        if (!targetSerial && deviceId) {
            for (const [serial, cert] of this.certificates.entries()) {
                if (cert.deviceId === deviceId) {
                    targetSerial = serial;
                    break;
                }
            }
        }
        if (!targetSerial) {
            throw new Error('Certificate not found');
        }
        const certInfo = this.certificates.get(targetSerial);
        if (!certInfo) {
            throw new Error('Certificate not found in registry');
        }
        if (certInfo.revoked) {
            this.logger.warn('Certificate already revoked', { serialNumber: targetSerial });
            return;
        }
        this.logger.info('Revoking certificate', {
            serialNumber: targetSerial,
            deviceId: certInfo.deviceId,
            reason
        });
        try {
            certInfo.revoked = true;
            certInfo.revokedAt = new Date();
            await this.updateCRL();
            this.logger.info('Certificate revoked successfully', {
                serialNumber: targetSerial,
                deviceId: certInfo.deviceId
            });
        }
        catch (error) {
            this.logger.error('Failed to revoke certificate', { serialNumber: targetSerial, error });
            throw error;
        }
    }
    getCertificate(serialNumber) {
        return this.certificates.get(serialNumber);
    }
    getCustomerCertificates(customerId) {
        return Array.from(this.certificates.values())
            .filter(cert => cert.customerId === customerId);
    }
    getCertificatesExpiringSoon(days = 30) {
        const threshold = new Date();
        threshold.setDate(threshold.getDate() + days);
        return Array.from(this.certificates.values())
            .filter(cert => !cert.revoked && cert.expiresAt <= threshold);
    }
    async loadCA() {
        try {
            const caCertPem = await fs.readFile(this.config.caCertPath, 'utf8');
            const caKeyPem = await fs.readFile(this.config.caKeyPath, 'utf8');
            this.caCert = forge.pki.certificateFromPem(caCertPem);
            this.caKey = forge.pki.privateKeyFromPem(caKeyPem);
            this.logger.info('CA certificate loaded successfully');
        }
        catch (error) {
            this.logger.error('Failed to load CA certificate', { error });
            throw new Error('Failed to load CA certificate');
        }
    }
    async loadTLSAuthKey() {
        try {
            this.tlsAuthKey = await fs.readFile(this.config.taKeyPath, 'utf8');
            this.logger.info('TLS auth key loaded successfully');
        }
        catch (error) {
            this.logger.error('Failed to load TLS auth key', { error });
            throw new Error('Failed to load TLS auth key');
        }
    }
    async loadExistingCertificates() {
        this.logger.info('Certificate registry initialized (empty)');
    }
    generateCommonName(deviceId, customerId) {
        return `device-${deviceId}-${customerId}`;
    }
    generateSerialNumber() {
        return Math.floor(Math.random() * 1000000000).toString(16).toUpperCase();
    }
    async generateClientConfig(certPem, keyPem, caPem) {
        const template = await fs.readFile(path.join(path.dirname(this.config.caCertPath), '..', 'config', 'client-template.conf'), 'utf8');
        return template
            .replace('VPN_SERVER_HOST', process.env.VPN_SERVER_HOST || 'localhost')
            .replace('VPN_SERVER_PORT', process.env.VPN_SERVER_PORT || '1194')
            .replace('<ca>', caPem.trim())
            .replace('<cert>', certPem.trim())
            .replace('<key>', keyPem.trim())
            .replace('<tls-auth>', (this.tlsAuthKey || '').trim());
    }
    async saveCertificateFiles(deviceId, response) {
        const certDir = path.join(path.dirname(this.config.caCertPath), 'issued');
        const keyDir = path.join(path.dirname(this.config.caCertPath), 'private');
        const configDir = path.join(path.dirname(this.config.caCertPath), 'client-configs');
        await fs.mkdir(certDir, { recursive: true });
        await fs.mkdir(keyDir, { recursive: true });
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(path.join(certDir, `${deviceId}.crt`), response.certificate);
        await fs.writeFile(path.join(keyDir, `${deviceId}.key`), response.privateKey);
        await fs.writeFile(path.join(configDir, `${deviceId}.ovpn`), response.clientConfig);
    }
    async updateCRL() {
        if (!this.caCert || !this.caKey) {
            throw new Error('CA not loaded');
        }
        const revokedCerts = Array.from(this.certificates.values())
            .filter(cert => cert.revoked);
        const crlData = revokedCerts.map(cert => ({
            serialNumber: cert.serialNumber,
            revocationDate: cert.revokedAt || new Date()
        }));
        this.logger.info('CRL updated', { revokedCount: revokedCerts.length });
        await fs.writeFile(this.config.crlPath, JSON.stringify(crlData, null, 2));
    }
}
exports.CertificateManager = CertificateManager;
//# sourceMappingURL=certificate-manager.js.map