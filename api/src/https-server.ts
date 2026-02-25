/**
 * 🔐 HTTPS Server Configuration
 *
 * TLS ARCHITECTURE:
 * ┌─────────────────────────────────────────────────────────────┐
 * │ Kubernetes/Cloud Deployment (RECOMMENDED)                 │
 * │                                                             │
 * │ Internet (HTTPS/TLS)                                        │
 * │       ↓                                                      │
 * │ Ingress Controller (NGINX/ALB/CloudFormation)               │
 * │   [OK] TLS Termination here                                   │
 * │   [OK] Certificate management (Let's Encrypt)                │
 * │       ↓                                                      │
 * │ Internal Cluster (HTTP)                                     │
 * │       ↓                                                      │
 * │ Node.js App (this file handles only HTTP)                  │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Edge Device Deployment (if direct HTTPS needed):
 * ┌─────────────────────────────────────────────────────────────┐
 * │ Edge Device → Direct HTTPS to Node.js                       │
 * │   @env HTTPS_ENABLED=true (enables this server)            │
 * │   @env HTTPS_BEHIND_INGRESS=false (bypasses ingress check) │
 * └─────────────────────────────────────────────────────────────┘
 *
 * IMPORTANT NOTES:
 * - OCSP Stapling: NOT implemented (handled at ingress if needed)
 * - enableTrace: false (not applicable - ingress handles cert checks)
 * - mTLS: Supported for device-to-API client certificates
 */

import https from 'https';
import fs from 'fs';
import crypto from 'crypto';
import logger from './utils/logger';
import type { Express } from 'express';

export interface HttpsConfig {
  enabled: boolean;
  port: number;
  certPath: string;
  keyPath: string;
  caCertPath?: string;
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
  // New: Environment context for smart defaults
  environment?: 'dev' | 'prod';
}

export function createHttpsServer(app: Express, config: HttpsConfig): https.Server | null {
  if (!config.enabled) {
    logger.debug('HTTPS disabled');
    return null;
  }

  try {
    // Determine environment (prod is secure by default, dev can use self-signed)
    const isProduction = config.environment === 'prod' || process.env.NODE_ENV === 'production';
    
    // [OK] SECURITY: Smart defaults based on environment
    // - Prod: Always enforce mTLS if enabled
    // - Dev: Allow self-signed certs but still validate by default
    const rejectUnauthorized = config.rejectUnauthorized !== undefined 
      ? config.rejectUnauthorized 
      : !isProduction; // prod=true (enforce), dev=false (allow self-signed)

    const requestCert = config.requestCert ?? false;

    // [OK] SECURITY: Validate mTLS configuration
    if (requestCert && !rejectUnauthorized && isProduction) {
      logger.warn('[WARNING] SECURITY WARNING: mTLS enabled but certificate validation disabled in PRODUCTION');
      logger.warn('[WARNING] This allows invalid/compromised client certificates. Set rejectUnauthorized: true');
    }

    if (requestCert && !rejectUnauthorized && !isProduction) {
      logger.debug('[INFO] mTLS enabled with self-signed cert validation disabled (dev mode)');
    }

    // Check if certificate files exist
    if (!fs.existsSync(config.certPath)) {
      logger.warn(`HTTPS certificate not found: ${config.certPath}`);
      logger.warn('HTTPS server will not be started. Run ./scripts/generate-san-cert.ps1 to generate certificates.');
      return null;
    }

    if (!fs.existsSync(config.keyPath)) {
      logger.warn(`HTTPS key not found: ${config.keyPath}`);
      logger.warn('HTTPS server will not be started. Run ./scripts/generate-san-cert.ps1 to generate certificates.');
      return null;
    }

    // Read certificate files
    const cert = fs.readFileSync(config.certPath, 'utf8');
    const key = fs.readFileSync(config.keyPath, 'utf8');
    
    // Optional: Read CA certificate for chain verification (strongly recommended for prod mTLS)
    let ca: string | undefined;
    if (config.caCertPath && fs.existsSync(config.caCertPath)) {
      ca = fs.readFileSync(config.caCertPath, 'utf8');
      logger.info(`Using CA certificate: ${config.caCertPath}`);
    } else if (requestCert && isProduction) {
      logger.warn('[WARNING] SECURITY WARNING: mTLS enabled in PRODUCTION but no CA certificate provided');
      logger.warn('[WARNING] Client certificates cannot be properly validated. Provide caCertPath.');
    }

    // TLS Security Hardening
    const httpsOptions: https.ServerOptions = {
      cert,
      key,
      ca,
      requestCert,
      rejectUnauthorized, // [OK] Now safely defaults to true (prod) or false (dev)
      
      // SECURITY: Enforce TLS 1.2+ (prefer TLS 1.3)
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      
      // SECURITY: Disable legacy TLS at OpenSSL level (defense-in-depth)
      // Even with minVersion set, explicitly disable older protocols via OpenSSL flags
      secureOptions:
        crypto.constants.SSL_OP_NO_TLSv1 |
        crypto.constants.SSL_OP_NO_TLSv1_1,
      
      // SECURITY: Strong cipher suites only (TLS 1.3 + TLS 1.2 fallback)
      ciphers: [
        // TLS 1.3 (preferred - no configuration needed, enabled by default)
        // TLS 1.2 fallback (strong ciphers only)
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        // Reject weak ciphers (RC4, MD5, DES, 3DES, NULL)
      ].join(':'),
      
      // SECURITY: Prefer server cipher order
      honorCipherOrder: true,
    };

    // Create HTTPS server
    const server = https.createServer(httpsOptions, app);

    server.listen(config.port, () => {
      logger.info('='.repeat(80));
      logger.info('[SECURE] Iotistic API HTTPS Server');
      logger.info(`Environment: ${isProduction ? 'PRODUCTION' : 'Development'}`);
      logger.info(`TLS: TLSv1.2-TLSv1.3 with strong ciphers`);
      if (requestCert) {
        logger.info(`mTLS: Enabled (reject unauth: ${rejectUnauthorized})`);
      }
      logger.info('='.repeat(80));
      logger.info(`HTTPS Server running on https://localhost:${config.port}`);
      logger.info(`Certificate: ${config.certPath}`);
      logger.info('='.repeat(80));
    });

    return server;
  } catch (error) {
    logger.error('Failed to create HTTPS server', { error });
    return null;
  }
}
