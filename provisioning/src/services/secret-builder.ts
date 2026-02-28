/**
 * SecretBuilder - Template-based secret generation for all application components
 * 
 * Flow:
 * 1. preGenerate(apps) - Generate secrets for specified apps using templates
 * 2. addDbCredentials() - Update SQL template with actual DB info after provisioning
 * 3. build() - Return all secrets organized by app
 * 
 * Benefits:
 * - Consistent schema for all secrets
 * - Easy to add new apps (just add template)
 * - Supports passwords, tokens, usernames, and static placeholders
 */

import crypto from 'crypto';

/**
 * Secret field type definitions
 */
export interface SecretTemplateField {
  type: 'username' | 'password' | 'token' | 'static';
  length?: number;        // For password/token generation
  prefix?: string;        // For username prefix
  value?: string;         // For static values
}

/**
 * Secret template schema for each app type
 */
export interface SecretTemplate {
  [key: string]: SecretTemplateField;
}

/**
 * Default secret templates for all supported apps
 * Add new apps here to automatically generate their secrets
 */
export const secretTemplates: Record<string, SecretTemplate> = {
  redis: {
    host: { type: 'static', value: 'redis' },
    password: { type: 'password', length: 32 },
    port_ext: { type: 'static', value: '6379' },
    port: { type: 'static', value: '6379' },
  },
  mqtt: {
    username: { type: 'username', prefix: 'mqtt' },
    password: { type: 'password', length: 32 },
  },
  openai: {
    key: { type: 'token', length: 48 },
  },
  'api-jwt': {
    token: { type: 'token', length: 64 },
  },
  sql: {
    password: { type: 'static', value: 'PENDING' },
    port: { type: 'static', value: '5432' },
    server: { type: 'static', value: 'PENDING' },
    username: { type: 'static', value: 'PENDING' },
    dbname: { type: 'static', value: 'PENDING' },
  },
};

/**
 * SecretBuilder - Generate secrets from templates
 */
export class SecretBuilder {
  private secrets: Record<string, any> = {};

  constructor(private clientId: string) {}

  /**
   * Pre-generate secrets for specified apps using templates
   * 
   * @param apps - Array of app names (must exist in secretTemplates)
   * @returns this (for chaining)
   */
  public preGenerate(apps: string[]): this {
    for (const app of apps) {
      const template = secretTemplates[app];
      if (!template) {
        console.warn(`[SecretBuilder] No template found for app: ${app}`);
        continue;
      }

      this.secrets[app] = {};

      for (const [key, field] of Object.entries(template)) {
        switch (field.type) {
          case 'password':
          case 'token':
            this.secrets[app][key] = this.generateRandom(field.length || 16);
            break;
          case 'username':
            this.secrets[app][key] = `${field.prefix || app}-${this.clientId}`;
            break;
          case 'static':
            this.secrets[app][key] = field.value;
            break;
        }
      }
    }
    return this;
  }

  /**
   * Update SQL credentials with actual DB info after provisioning
   * Maps TigerData fields to SQL secret schema
   * 
   * @param db - Database connection info from TigerData
   * @returns this (for chaining)
   */
  public addDbCredentials(db: {
    user: string;
    password: string;
    host: string;
    port: number | string;
    name: string;
  }): this {
    if (!this.secrets['sql']) {
      this.secrets['sql'] = {};
    }
    
    // Map TigerData fields to SQL secret schema
    this.secrets['sql'].username = db.user;
    this.secrets['sql'].password = db.password;
    this.secrets['sql'].server = db.host;      // host → server
    this.secrets['sql'].port = db.port.toString();
    this.secrets['sql'].dbname = db.name;      // name → dbname
    
    return this;
  }

  /**
   * Add license credentials (customer-specific JWT token only)
   * Public key is shared cluster-wide, not stored per-customer
   * 
   * @param license - JWT license token generated for customer
   * @returns this (for chaining)
   */
  public addLicenseCredentials(license: string): this {
    this.secrets['api-license'] = {
      key: license
    };
    
    return this;
  }

  /**
   * Get secrets for a specific app
   * 
   * @param app - App name (e.g., 'redis', 'mqtt', 'sql')
   * @returns Secret fields for the app
   */
  public getAppSecrets(app: string): Record<string, string> | undefined {
    return this.secrets[app];
  }

  /**
   * Build and return all generated secrets
   * 
   * @returns All secrets organized by app
   */
  public build(): Record<string, any> {
    return this.secrets;
  }

  /**
   * Check if SQL credentials have been added
   */
  public hasDbCredentials(): boolean {
    return !!(
      this.secrets['sql'] &&
      this.secrets['sql'].username !== 'PENDING' &&
      this.secrets['sql'].password !== 'PENDING'
    );
  }

  /**
   * Generate cryptographically secure random string
   * 
   * @param length - Desired length
   * @returns Base64-encoded random string (alphanumeric only)
   */
  private generateRandom(length: number): string {
    return crypto
      .randomBytes(Math.ceil(length * 3 / 4))
      .toString('base64')
      .replace(/[+/=]/g, '') // Remove special chars
      .slice(0, length);
  }
}
