/**
 * HTTPS server setup with ingress-aware configuration.
 *
 * TLS ARCHITECTURE:
 *
 * Kubernetes/Cloud (RECOMMENDED):
 *   Internet (HTTPS) -> Ingress Controller (TLS terminated) -> Node.js (HTTP only)
 *
 * Edge / Direct:
 *   Client -> Node.js HTTPS (HTTPS_ENABLED=true, HTTPS_BEHIND_INGRESS=false)
 *
 * mTLS: Supported for device-to-API client certificates (HTTPS_MTLS_ENABLED=true)
 */

import https from 'https';
import fs from 'fs';
import crypto from 'crypto';
import type { Application } from 'express';
import logger from '../utils/logger';
import { detectIngressArchitecture } from './ingress';

// ---------------------------------------------------------------------------
// TLS server factory (previously https-server.ts)
// ---------------------------------------------------------------------------

interface TlsConfig {
  port: number;
  certPath: string;
  keyPath: string;
  caCertPath?: string;
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
  isProduction: boolean;
}

function createTlsServer(app: Application, cfg: TlsConfig): https.Server | null {
  // Smart defaults: prod enforces cert validation, dev allows self-signed
  const rejectUnauthorized = cfg.rejectUnauthorized !== undefined
    ? cfg.rejectUnauthorized
    : cfg.isProduction;

  const requestCert = cfg.requestCert ?? false;

  if (requestCert && !rejectUnauthorized && cfg.isProduction) {
    logger.warn('SECURITY WARNING: mTLS enabled but certificate validation disabled in PRODUCTION');
  }

  if (!fs.existsSync(cfg.certPath)) {
    logger.warn(`HTTPS certificate not found: ${cfg.certPath} - HTTPS will not start`);
    return null;
  }
  if (!fs.existsSync(cfg.keyPath)) {
    logger.warn(`HTTPS key not found: ${cfg.keyPath} - HTTPS will not start`);
    return null;
  }

  const cert = fs.readFileSync(cfg.certPath, 'utf8');
  const key = fs.readFileSync(cfg.keyPath, 'utf8');

  let ca: string | undefined;
  if (cfg.caCertPath && fs.existsSync(cfg.caCertPath)) {
    ca = fs.readFileSync(cfg.caCertPath, 'utf8');
    logger.info(`Using CA certificate: ${cfg.caCertPath}`);
  } else if (requestCert && cfg.isProduction) {
    logger.warn('SECURITY WARNING: mTLS enabled in PRODUCTION but no CA certificate provided');
  }

  const httpsOptions: https.ServerOptions = {
    cert,
    key,
    ca,
    requestCert,
    rejectUnauthorized,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    secureOptions:
      crypto.constants.SSL_OP_NO_TLSv1 |
      crypto.constants.SSL_OP_NO_TLSv1_1,
    ciphers: [
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
    ].join(':'),
    honorCipherOrder: true,
  };

  const server = https.createServer(httpsOptions, app);

  server.listen(cfg.port, () => {
    logger.info('='.repeat(80));
    logger.info('[SECURE] Iotistic API HTTPS Server');
    logger.info(`  Environment : ${cfg.isProduction ? 'PRODUCTION' : 'Development'}`);
    logger.info(`  TLS         : TLSv1.2-TLSv1.3, strong ciphers`);
    if (requestCert) {
      logger.info(`  mTLS        : Enabled (rejectUnauthorized=${rejectUnauthorized})`);
    }
    logger.info(`  Listening   : https://localhost:${cfg.port}`);
    logger.info(`  Certificate : ${cfg.certPath}`);
    logger.info('='.repeat(80));
  });

  return server;
}

// ---------------------------------------------------------------------------
// Public API — called by server/lifecycle.ts
// ---------------------------------------------------------------------------

export async function startHttpsServer(
  app: Application,
): Promise<https.Server | null> {
  const HTTPS_ENABLED = process.env.HTTPS_ENABLED === 'true';
  const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3443', 10);
  const IS_PRODUCTION = process.env.NODE_ENV === 'production';

  const arch = detectIngressArchitecture();

  logger.info('='.repeat(80));
  logger.info('DEPLOYMENT ARCHITECTURE:');
  if (arch.isK8s) {
    logger.info(`  Environment      : Kubernetes/AKS`);
    logger.info(`  Gateway          : ${arch.ingressType}`);
    if (arch.gatewayAddress) {
      logger.info(`  Gateway Address  : ${arch.gatewayAddress}`);
    }
    logger.info(`  TLS Termination  : ${arch.tlsTermination}`);
  } else {
    logger.info(`  Environment      : Local/Direct Deployment`);
    logger.info(`  TLS              : ${HTTPS_ENABLED ? 'Direct HTTPS via Node.js' : 'HTTP only'}`);
  }
  logger.info('='.repeat(80));

  if (HTTPS_ENABLED && !arch.behindIngress) {
    try {
      const rejectUnauthorized = process.env.HTTPS_REJECT_UNAUTHORIZED
        ? process.env.HTTPS_REJECT_UNAUTHORIZED === 'true'
        : undefined;

      return createTlsServer(app, {
        port: HTTPS_PORT,
        certPath: process.env.HTTPS_CERT_PATH || './certs/tls.crt',
        keyPath: process.env.HTTPS_KEY_PATH || './certs/tls.key',
        caCertPath: process.env.HTTPS_CA_CERT_PATH || './certs/ca.crt',
        isProduction: IS_PRODUCTION,
        requestCert: process.env.HTTPS_MTLS_ENABLED === 'true',
        rejectUnauthorized,
      });
    } catch (error) {
      logger.warn('Failed to start HTTPS server', { error });
      return null;
    }
  }

  if (arch.behindIngress) {
    logger.info(`[OK] TLS terminated at ${arch.ingressType} - app layer is HTTP only`);
    if (arch.gatewayAddress) {
      logger.info(`     Gateway reachable at: ${arch.gatewayAddress}`);
    }
  } else {
    logger.info('HTTPS disabled - running HTTP only');
  }

  return null;
}
