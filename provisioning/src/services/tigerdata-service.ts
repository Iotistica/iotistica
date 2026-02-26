/**
 * TigerData API Service
 * Handles provisioning and management of TimescaleDB instances via TigerData API
 * API Reference: https://www.tigerdata.com/docs/api/latest/api-reference
 */

import axios, { AxiosInstance } from 'axios';

export interface TigerDataConfig {
  apiUrl: string;
  accessKey: string;
  secretKey: string;
  projectId?: string;
  defaultRegion: string;
  defaultPlan: string;
}

export interface ProvisionDatabaseRequest {
  name: string;
  type: 'timescaledb';
  region: string;
  plan: string;
}

export interface TigerDataDatabase {
  serviceId: string;
  host: string;
  port: number;
  dbName: string;
  username: string;
  password: string;
  region: string;
  status: string;
  fullResponse?: any;
}

export interface DatabaseStatus {
  serviceId: string;
  status: 'provisioning' | 'active' | 'failed' | 'deleted' | 'QUEUED' | 'CONFIGURING' | 'READY' | 'FAILED' | 'DELETED';
  host?: string;
  port?: number;
}

export class TigerDataProvisioningError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: any
  ) {
    super(message);
    this.name = 'TigerDataProvisioningError';
  }
}

export class TigerDataService {
  private client: AxiosInstance;
  private config: TigerDataConfig;
  private simulateMode: boolean;

  constructor(config?: Partial<TigerDataConfig>) {
    this.simulateMode = process.env.SIMULATE_TIGERDATA === 'true';
    this.config = {
      apiUrl: config?.apiUrl || process.env.TIGERDATA_API_URL || 'https://console.cloud.timescale.com/public/api/v1',
      accessKey: config?.accessKey || process.env.TIGERDATA_ACCESS_KEY || '',
      secretKey: config?.secretKey || process.env.TIGERDATA_SECRET_KEY || '',
      projectId: config?.projectId || process.env.TIGERDATA_PROJECT_ID,
      defaultRegion: config?.defaultRegion || process.env.TIGERDATA_DEFAULT_REGION || 'us-east-1',
      defaultPlan: config?.defaultPlan || process.env.TIGERDATA_DEFAULT_PLAN || 'dev',
    };

    // Skip validation and client initialization if in simulation mode
    if (this.simulateMode) {
      console.log('[TigerDataService] ⚠️  SIMULATION MODE ENABLED - Skipping API validation');
      // Create a dummy client that won't be used
      this.client = {} as AxiosInstance;
      return;
    }

    if (!this.config.accessKey || !this.config.secretKey) {
      throw new TigerDataProvisioningError('TigerData access key and secret key are required');
    }

    if (!this.config.projectId) {
      throw new TigerDataProvisioningError('TigerData project ID is required');
    }

    // Create Basic Auth token: base64(accessKey:secretKey)
    const basicAuth = Buffer.from(`${this.config.accessKey}:${this.config.secretKey}`).toString('base64');

    this.client = axios.create({
      baseURL: this.config.apiUrl,
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000, // 30 seconds
    });

    // Response interceptor for error handling
    this.client.interceptors.response.use(
      (response: any) => response,
      (error: any) => {
        if (error.response) {
          throw new TigerDataProvisioningError(
            error.response.data?.message || error.message,
            error.response.status,
            error.response.data
          );
        }
        throw new TigerDataProvisioningError(error.message);
      }
    );
  }

  /**
   * Check if a database with the given name already exists
   * @param namespace - Database name to search for
   * @returns Database info if found, null otherwise
   */
  async findDatabaseByName(namespace: string): Promise<TigerDataDatabase | null> {
    try {
      console.log(`[TigerDataService] Checking if database exists: ${namespace}`);
      const databases = await this.listDatabases();
      
      const existing = databases.find((db: any) => 
        db.name === namespace || 
        db.dbName === namespace ||
        db.database === namespace
      );
      
      if (existing) {
        console.log(`[TigerDataService] ✅ Found existing database:`, {
          serviceId: existing.id || existing.serviceId,
          name: existing.name || existing.dbName,
          status: existing.status
        });
        
        return {
          serviceId: existing.id || existing.serviceId || existing.service_id,
          host: existing.endpoint?.host || existing.host || existing.hostname,
          port: existing.endpoint?.port || existing.port || 5432,
          dbName: 'tsdb',
          username: 'tsdbadmin',
          password: existing.password || '', // Password not returned in list
          region: existing.region || this.config.defaultRegion,
          status: existing.status || 'unknown',
          fullResponse: existing,
        };
      }
      
      console.log(`[TigerDataService] No existing database found with name: ${namespace}`);
      return null;
    } catch (error) {
      console.error(`[TigerDataService] Error checking for existing database:`, error);
      // Don't throw - return null if we can't check
      return null;
    }
  }

  /**
   * Provision a new TimescaleDB database instance
   * @param namespace - Customer namespace (e.g., client-abc123)
   * @param options - Optional override for region and plan
   */
  async provisionDatabase(
    namespace: string,
    options?: { region?: string; plan?: string }
  ): Promise<TigerDataDatabase> {
    console.log(`[TigerDataService] Provisioning database for namespace: ${namespace}`);

    // Check if database already exists (idempotency)
    const existing = await this.findDatabaseByName(namespace);
    if (existing) {
      console.log(`[TigerDataService] ℹ️  Database already exists, returning existing database`);
      console.log(`   Service ID: ${existing.serviceId}`);
      console.log(`   Status: ${existing.status}`);
      return existing;
    }

    // Simulation mode - don't actually provision
    if (this.simulateMode) {
      console.log(`[TigerDataService] ⚠️  SIMULATION MODE - Not actually provisioning database`);
      const mockResult: TigerDataDatabase = {
        serviceId: `mock-service-${namespace}`,
        host: `mock-${namespace}.timescaledb.io`,
        port: 5432,
        dbName: namespace,
        username: 'tsdbadmin',
        password: 'mock-password-' + Math.random().toString(36).substring(7),
        region: options?.region || this.config.defaultRegion,
        status: 'active',
        fullResponse: { simulated: true },
      };
      console.log(`[TigerDataService] ✅ Mock database created: ${mockResult.serviceId}`);
      return mockResult;
    }

    const request: ProvisionDatabaseRequest = {
      name: namespace,
      type: 'timescaledb',
      region: options?.region || this.config.defaultRegion,
      plan: options?.plan || this.config.defaultPlan,
    };

    try {
      const response = await this.client.post(`/projects/${this.config.projectId}/services`, request);
      const data = response.data;

      console.log(`[TigerDataService] RAW API Response:`, JSON.stringify(data, null, 2));
      console.log(`[TigerDataService] Response keys:`, Object.keys(data));

      // Extract service ID from various possible locations
      const serviceId = data.id || data.service_id || data.serviceId || data.endpoint?.service_id;
      
      if (!serviceId) {
        // If no service ID in response, try to find by name
        console.warn('[TigerDataService] ⚠️  No service ID in response, attempting to find by name...');
        const databases = await this.listDatabases();
        const existing = databases.find((db: any) => 
          db.name === namespace || db.dbName === namespace
        );
        
        if (existing) {
          console.log(`[TigerDataService] ✅ Found existing database with name: ${namespace}`);
          return {
            serviceId: existing.serviceId || existing.id,
            host: existing.host || existing.endpoint?.host,
            port: existing.port || existing.endpoint?.port || 5432,
            dbName: 'tsdb',
            username: 'tsdbadmin',
            password: data.initial_password || data.password || existing.password,
            region: existing.region || request.region,
            status: existing.status || 'provisioning',
            fullResponse: data,
          };
        }
        
        throw new TigerDataProvisioningError(
          'No service ID in API response and could not find database by name. Response: ' + 
          JSON.stringify(Object.keys(data))
        );
      }

      console.log(`[TigerDataService] Database provisioning initiated: serviceId=${serviceId}`);

      // Handle both nested and flat response structures
      return {
        serviceId: serviceId,
        host: data.endpoint?.host || data.host || data.hostname,
        port: data.endpoint?.port || data.port || 5432,
        dbName: 'tsdb',
        username: 'tsdbadmin',
        password: data.initial_password || data.password,
        region: data.region || request.region,
        status: data.status || 'provisioning',
        fullResponse: data,
      };
    } catch (error) {
      if (error instanceof TigerDataProvisioningError) {
        console.error(`[TigerDataService] Provisioning failed:`, error.message);
        throw error;
      }
      throw new TigerDataProvisioningError(`Failed to provision database: ${error}`);
    }
  }

  /**
   * Wait until database is ready (polling)
   * @param serviceId - TigerData service ID
   * @param maxRetries - Maximum number of status checks (default: 30)
   * @param delayMs - Delay between checks in milliseconds (default: 10000)
   */
  async waitUntilReady(
    serviceId: string,
    maxRetries: number = 30,
    delayMs: number = 10000
  ): Promise<void> {
    if (!serviceId || serviceId === 'undefined') {
      throw new TigerDataProvisioningError(
        'Cannot wait for database: serviceId is missing or undefined. ' +
        'Database may have been created but service ID was not returned by API.'
      );
    }

    console.log(`[TigerDataService] Waiting for database ${serviceId} to become ready...`);

    // In simulation mode, mock databases are always ready
    if (this.simulateMode) {
      console.log(`[TigerDataService] ⚠️  SIMULATION MODE - Mock database is instantly ready`);
      return;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const status = await this.getDatabaseStatus(serviceId);

      console.log(
        `[TigerDataService] Status check ${attempt}/${maxRetries}: ${status.status}`
      );

      // TigerData API returns 'READY' (uppercase), some APIs return 'active'
      if (status.status === 'READY' || status.status === 'active') {
        console.log(`[TigerDataService] Database ${serviceId} is ready!`);
        return;
      }

      if (status.status === 'failed' || status.status === 'FAILED') {
        throw new TigerDataProvisioningError(
          `Database provisioning failed for service ${serviceId}`
        );
      }

      // Wait before next check
      if (attempt < maxRetries) {
        await this.delay(delayMs);
      }
    }

    throw new TigerDataProvisioningError(
      `Database ${serviceId} did not become ready after ${maxRetries} attempts`
    );
  }

  /**
   * Get database status
   * @param serviceId - TigerData service ID
   */
  async getDatabaseStatus(serviceId: string): Promise<DatabaseStatus> {
    try {
      const response = await this.client.get(`/projects/${this.config.projectId}/services/${serviceId}`);
      const data = response.data;

      return {
        serviceId: data.id,
        status: data.status,
        host: data.host || data.hostname,
        port: data.port,
      };
    } catch (error) {
      if (error instanceof TigerDataProvisioningError) {
        throw error;
      }
      throw new TigerDataProvisioningError(
        `Failed to get database status: ${error}`
      );
    }
  }

  /**
   * Delete a database instance
   * @param serviceId - TigerData service ID
   */
  async deleteDatabase(serviceId: string): Promise<void> {
    console.log(`[TigerDataService] Deleting database: ${serviceId}`);

    try {
      await this.client.delete(`/projects/${this.config.projectId}/services/${serviceId}`);
      console.log(`[TigerDataService] Database ${serviceId} deleted successfully`);
    } catch (error) {
      if (error instanceof TigerDataProvisioningError) {
        console.error(`[TigerDataService] Delete failed:`, error.message);
        throw error;
      }
      throw new TigerDataProvisioningError(`Failed to delete database: ${error}`);
    }
  }

  /**
   * List all databases for the project
   * Returns raw API response with varying property names
   */
  async listDatabases(): Promise<any[]> {
    try {
      const response = await this.client.get(`/projects/${this.config.projectId}/services`);
      return response.data.services || response.data || [];
    } catch (error) {
      if (error instanceof TigerDataProvisioningError) {
        throw error;
      }
      throw new TigerDataProvisioningError(`Failed to list databases: ${error}`);
    }
  }

  /**
   * Delay helper for polling
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
