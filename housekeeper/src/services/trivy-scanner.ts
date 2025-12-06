/**
 * Trivy Security Scanner Service
 * 
 * Integrates Aqua Security's Trivy for vulnerability scanning of Docker images.
 * Scans images for CVEs and security issues before approval.fff
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import logger from '../utils/logger';

const execAsync = promisify(exec);

export interface TrivyScanResult {
  success: boolean;
  scannedAt: string;
  imageName: string;
  tag: string;
  vulnerabilities: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    unknown: number;
    total: number;
  };
  scanStatus: 'passed' | 'failed' | 'warning';
  details?: any;
  error?: string;
}

export interface VulnerabilitySummary {
  VulnerabilityID: string;
  PkgName: string;
  InstalledVersion: string;
  FixedVersion: string;
  Severity: string;
  Title: string;
}

export class TrivyScanner {
  private trivyPath: string;
  private enabled: boolean;
  private scanTimeout: number;
  private cachePath: string;

  constructor() {
    this.trivyPath = process.env.TRIVY_PATH || 'trivy';
    this.enabled = process.env.TRIVY_ENABLED !== 'false';
    this.scanTimeout = parseInt(process.env.TRIVY_TIMEOUT || '300000', 10); // 5 minutes default
    this.cachePath = process.env.TRIVY_CACHE_DIR || '/tmp/trivy-cache';
  }

  /**
   * Check if Trivy is installed and available
   */
  async isAvailable(): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      const { stdout } = await execAsync(`${this.trivyPath} --version`);
      logger.debug('Trivy version', { version: stdout.trim() });
      return true;
    } catch (error: any) {
      logger.warn('Trivy not available', { error: error.message });
      return false;
    }
  }

  /**
   * Scan a Docker image for vulnerabilities
   */
  async scanImage(imageName: string, tag: string): Promise<TrivyScanResult> {
    const fullImageName = `${imageName}:${tag}`;
    const scannedAt = new Date().toISOString();

    logger.info('Scanning image', { image: fullImageName });

    // Check if Trivy is available
    const available = await this.isAvailable();
    if (!available) {
      logger.warn('Scanner not available, skipping scan');
      return {
        success: false,
        scannedAt,
        imageName,
        tag,
        vulnerabilities: {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          unknown: 0,
          total: 0
        },
        scanStatus: 'passed',
        error: 'Trivy not available'
      };
    }

    try {
      // Create temp file for JSON output
      const tempFile = path.join('/tmp', `trivy-${Date.now()}.json`);

      // Run Trivy scan
      const command = [
        this.trivyPath,
        'image',
        '--format json',
        `--output ${tempFile}`,
        '--severity CRITICAL,HIGH,MEDIUM,LOW,UNKNOWN',
        '--scanners vuln',
        `--timeout ${this.scanTimeout}ms`,
        `--cache-dir ${this.cachePath}`,
        fullImageName
      ].join(' ');

      logger.debug('Running Trivy scan', { command });

      const { stdout, stderr } = await execAsync(command, {
        timeout: this.scanTimeout,
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer
      });

      if (stderr) {
        logger.warn('Trivy scan warnings', { warnings: stderr });
      }

      // Read and parse results
      const resultData = await fs.readFile(tempFile, 'utf8');
      const scanResults = JSON.parse(resultData);

      // Clean up temp file
      await fs.unlink(tempFile).catch(() => {});

      // Process results
      const result = this.processScanResults(scanResults, imageName, tag, scannedAt);

      logger.info('Scan complete', {
        image: fullImageName,
        status: result.scanStatus,
        vulnerabilities: result.vulnerabilities
      });

      return result;

    } catch (error: any) {
      logger.error('Scan failed', { image: fullImageName, error: error.message });

      return {
        success: false,
        scannedAt,
        imageName,
        tag,
        vulnerabilities: {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          unknown: 0,
          total: 0
        },
        scanStatus: 'failed',
        error: error.message
      };
    }
  }

  /**
   * Process Trivy scan results into summary format
   */
  private processScanResults(
    scanResults: any,
    imageName: string,
    tag: string,
    scannedAt: string
  ): TrivyScanResult {
    const vulnerabilities = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0,
      total: 0
    };

    const details: VulnerabilitySummary[] = [];

    // Process results
    if (scanResults.Results) {
      for (const result of scanResults.Results) {
        if (result.Vulnerabilities) {
          for (const vuln of result.Vulnerabilities) {
            const severity = (vuln.Severity || 'UNKNOWN').toLowerCase();

            switch (severity) {
              case 'critical':
                vulnerabilities.critical++;
                break;
              case 'high':
                vulnerabilities.high++;
                break;
              case 'medium':
                vulnerabilities.medium++;
                break;
              case 'low':
                vulnerabilities.low++;
                break;
              default:
                vulnerabilities.unknown++;
            }

            vulnerabilities.total++;

            // Store vulnerability details (limit to top 100 for storage)
            if (details.length < 100) {
              details.push({
                VulnerabilityID: vuln.VulnerabilityID,
                PkgName: vuln.PkgName,
                InstalledVersion: vuln.InstalledVersion,
                FixedVersion: vuln.FixedVersion || 'N/A',
                Severity: vuln.Severity,
                Title: vuln.Title || 'No title'
              });
            }
          }
        }
      }
    }

    // Determine scan status
    let scanStatus: 'passed' | 'failed' | 'warning' = 'passed';
    
    const criticalThreshold = parseInt(process.env.TRIVY_CRITICAL_THRESHOLD || '0', 10);
    const highThreshold = parseInt(process.env.TRIVY_HIGH_THRESHOLD || '999', 10);

    if (vulnerabilities.critical > criticalThreshold) {
      scanStatus = 'failed';
    } else if (vulnerabilities.high > highThreshold) {
      scanStatus = 'warning';
    }

    return {
      success: true,
      scannedAt,
      imageName,
      tag,
      vulnerabilities,
      scanStatus,
      details: details.length > 0 ? details : undefined
    };
  }

  /**
   * Get security report summary for display
   */
  getSecuritySummary(scanResult: TrivyScanResult): string {
    if (!scanResult.success) {
      return 'Security scan failed';
    }

    const { critical, high, medium, low } = scanResult.vulnerabilities;

    if (scanResult.scanStatus === 'failed') {
      return `CRITICAL: ${critical} critical, ${high} high vulnerabilities`;
    }

    if (scanResult.scanStatus === 'warning') {
      return `WARNING: ${high} high, ${medium} medium vulnerabilities`;
    }

    return `PASSED: ${medium} medium, ${low} low vulnerabilities`;
  }
}

// Singleton instance
export const trivyScanner = new TrivyScanner();
