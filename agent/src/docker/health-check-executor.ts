/**
 * Health Check Executor
 * 
 * Executes HTTP, TCP, and Exec health checks against containers.
 */

import http from 'http';
import https from 'https';
import net from 'net';
import Docker from 'dockerode';
import {
  HealthCheck,
  HealthCheckResult,
  HttpHealthCheck,
  TcpHealthCheck,
  ExecHealthCheck,
} from './types/health-check';

export class HealthCheckExecutor {
  private docker: Docker;

  constructor(docker: Docker) {
    this.docker = docker;
  }

  /**
   * Execute a health check against a container
   */
  async execute(
    containerId: string,
    check: HealthCheck,
    timeoutMs: number = 1000
  ): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      let success: boolean;
      let message: string | undefined;

      switch (check.type) {
        case 'http':
          ({ success, message } = await this.executeHttpCheck(containerId, check, timeoutMs));
          break;
        case 'tcp':
          ({ success, message } = await this.executeTcpCheck(containerId, check, timeoutMs));
          break;
        case 'exec':
          ({ success, message } = await this.executeExecCheck(containerId, check, timeoutMs));
          break;
        default:
          throw new Error(`Unknown health check type: ${(check as any).type}`);
      }

      return {
        success,
        message,
        timestamp: startTime,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
        timestamp: startTime,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute HTTP health check
   */
  private async executeHttpCheck(
    containerId: string,
    check: HttpHealthCheck,
    timeoutMs: number
  ): Promise<{ success: boolean; message?: string }> {
    // Get container IP address
    const container = this.docker.getContainer(containerId);
    const inspectData = await container.inspect();
    
    const networks = inspectData.NetworkSettings.Networks;
    const networkName = Object.keys(networks)[0];
    if (!networkName) {
      throw new Error('Container has no network');
    }
    
    const ipAddress = networks[networkName].IPAddress;
    if (!ipAddress) {
      throw new Error('Container has no IP address');
    }

    const scheme = check.scheme || 'http';
    const expectedStatus = check.expectedStatus || this.getDefaultStatusCodes();
    
    const url = `${scheme}://${ipAddress}:${check.port}${check.path}`;
    
    return new Promise((resolve, reject) => {
      const client = scheme === 'https' ? https : http;
      
      const req = client.get(url, {
        headers: check.headers || {},
        timeout: timeoutMs,
      }, (res) => {
        // Check if status code is in expected range
        const statusOk = expectedStatus.includes(res.statusCode || 0);
        
        if (statusOk) {
          resolve({
            success: true,
            message: `HTTP ${res.statusCode}`,
          });
        } else {
          resolve({
            success: false,
            message: `Unexpected status: ${res.statusCode}`,
          });
        }
        
        // Drain response to free up socket
        res.resume();
      });

      req.on('error', (error) => {
        resolve({
          success: false,
          message: `HTTP error: ${error.message}`,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          message: 'HTTP timeout',
        });
      });
    });
  }

  /**
   * Execute TCP socket health check
   */
  private async executeTcpCheck(
    containerId: string,
    check: TcpHealthCheck,
    timeoutMs: number
  ): Promise<{ success: boolean; message?: string }> {
    // Get container IP address
    const container = this.docker.getContainer(containerId);
    const inspectData = await container.inspect();
    
    const networks = inspectData.NetworkSettings.Networks;
    const networkName = Object.keys(networks)[0];
    if (!networkName) {
      throw new Error('Container has no network');
    }
    
    const ipAddress = networks[networkName].IPAddress;
    if (!ipAddress) {
      throw new Error('Container has no IP address');
    }

    return new Promise((resolve) => {
      const socket = new net.Socket();
      
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({
          success: false,
          message: 'TCP timeout',
        });
      }, timeoutMs);

      socket.connect(check.port, ipAddress, () => {
        clearTimeout(timer);
        socket.end();
        resolve({
          success: true,
          message: 'TCP connected',
        });
      });

      socket.on('error', (error) => {
        clearTimeout(timer);
        resolve({
          success: false,
          message: `TCP error: ${error.message}`,
        });
      });
    });
  }

  /**
   * Execute command inside container
   */
  private async executeExecCheck(
    containerId: string,
    check: ExecHealthCheck,
    timeoutMs: number
  ): Promise<{ success: boolean; message?: string }> {
    const container = this.docker.getContainer(containerId);
    
    // Create exec instance
    const exec = await container.exec({
      Cmd: check.command,
      AttachStdout: true,
      AttachStderr: true,
    });

    // Start execution with timeout
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          success: false,
          message: 'Exec timeout',
        });
      }, timeoutMs);

      exec.start({ Detach: false }, async (err, stream) => {
        if (err) {
          clearTimeout(timer);
          resolve({
            success: false,
            message: `Exec error: ${err.message}`,
          });
          return;
        }

        let output = '';
        
        stream?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });

        stream?.on('end', async () => {
          clearTimeout(timer);
          
          try {
            const inspectData = await exec.inspect();
            const exitCode = inspectData.ExitCode;
            
            resolve({
              success: exitCode === 0,
              message: exitCode === 0 ? 'Command succeeded' : `Exit code: ${exitCode}`,
            });
          } catch (error) {
            resolve({
              success: false,
              message: `Inspect error: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        });

        stream?.on('error', (error) => {
          clearTimeout(timer);
          resolve({
            success: false,
            message: `Stream error: ${error.message}`,
          });
        });
      });
    });
  }

  /**
   * Get default HTTP status codes considered successful (200-399)
   */
  private getDefaultStatusCodes(): number[] {
    const codes: number[] = [];
    for (let i = 200; i < 400; i++) {
      codes.push(i);
    }
    return codes;
  }
}
