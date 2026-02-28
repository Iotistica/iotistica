/**
 * Customer Model
 */

import { query } from './connection';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import type { DeploymentStatus } from '../types/deployment-status';

export interface Customer {
  id: number;
  customer_id: string;
  email: string;
  company_name?: string;
  full_name?: string;
  password_hash?: string;
  stripe_customer_id?: string;
  api_key_hash?: string;
  api_key_created_at?: Date;
  api_key_last_used?: Date;
  deployment_status?: DeploymentStatus;
  instance_url?: string;
  instance_namespace?: string;
  deployed_at?: Date;
  deployment_error?: string;
  // TigerData database provisioning fields
  db_service_id?: string;
  db_host?: string;
  db_port?: number;
  db_name?: string;
  db_region?: string;
  db_provisioned_at?: Date;
  db_api_response?: any;
  db_initialized?: boolean;
  // 1Password secret management fields
  secret_item_id?: string;
  secret_created_at?: Date;
  // Argo CD retry tracking fields
  argo_retry_count?: number;
  argo_last_retry_at?: Date;
  // Provisioning observability fields
  last_provisioning_step?: string;
  last_provisioning_error?: string;
  provisioning_started_at?: Date;
  provisioning_completed_at?: Date;
  provisioning_retry_count?: number;
  // Cancellation tracking
  is_active?: boolean;
  deleted_at?: Date;
  // Admin bootstrap fields
  initial_admin_password?: string;
  bootstrapped_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export class CustomerModel {
  /**
   * Create new customer
   */
  static async create(data: {
    email: string;
    companyName?: string;
    fullName?: string;
    passwordHash?: string;
  }): Promise<Customer> {
    // Generate clean customer ID (32-char UUID without dashes)
    // This gets hashed to 12-char client ID for namespaces, URLs, etc.
    const customerId = uuidv4().replace(/-/g, '');
    
    const result = await query<Customer>(
      `INSERT INTO customers (customer_id, email, company_name, full_name, password_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [customerId, data.email, data.companyName, data.fullName, data.passwordHash]
    );
    
    return result.rows[0];
  }

  /**
   * Get customer by ID
   */
  static async getById(customerId: string): Promise<Customer | null> {
    const result = await query<Customer>(
      'SELECT * FROM customers WHERE customer_id = $1',
      [customerId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get customer by email
   */
  static async getByEmail(email: string): Promise<Customer | null> {
    const result = await query<Customer>(
      'SELECT * FROM customers WHERE email = $1',
      [email]
    );
    return result.rows[0] || null;
  }

  /**
   * Get customer by Stripe customer ID
   */
  static async getByStripeCustomerId(stripeCustomerId: string): Promise<Customer | null> {
    const result = await query<Customer>(
      'SELECT * FROM customers WHERE stripe_customer_id = $1',
      [stripeCustomerId]
    );
    return result.rows[0] || null;
  }

  /**
   * Update customer
   */
  static async update(
    customerId: string,
    data: Partial<Pick<Customer, 'company_name' | 'stripe_customer_id'>>
  ): Promise<Customer> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined) {
        fields.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    });

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(customerId);

    const result = await query<Customer>(
      `UPDATE customers SET ${fields.join(', ')} WHERE customer_id = $${paramIndex} RETURNING *`,
      values
    );

    return result.rows[0];
  }

  /**
   * List all customers
   */
  static async list(limit: number = 100, offset: number = 0): Promise<Customer[]> {
    const result = await query<Customer>(
      'SELECT * FROM customers ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    return result.rows;
  }

  /**
   * Store API key (hashed) for customer
   */
  static async setApiKey(customerId: string, apiKey: string): Promise<void> {
    const hash = await bcrypt.hash(apiKey, 10);
    
    await query(
      `UPDATE customers 
       SET api_key_hash = $1, api_key_created_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $2`,
      [hash, customerId]
    );
  }

  /**
   * Verify API key for customer
   */
  static async verifyApiKey(apiKey: string): Promise<Customer | null> {
    // Extract customer ID from API key (format: <customer_id>_<secret>)
    const lastUnderscoreIndex = apiKey.lastIndexOf('_');
    if (lastUnderscoreIndex === -1) {
      return null;
    }
    
    const customerId = apiKey.substring(0, lastUnderscoreIndex);
    const customer = await this.getById(customerId);
    
    if (!customer || !customer.api_key_hash) {
      return null;
    }

    // Verify hash
    const isValid = await bcrypt.compare(apiKey, customer.api_key_hash);
    if (!isValid) {
      return null;
    }

    // Update last used timestamp
    await query(
      'UPDATE customers SET api_key_last_used = CURRENT_TIMESTAMP WHERE customer_id = $1',
      [customerId]
    );

    return customer;
  }

  /**
   * Revoke API key (delete hash)
   */
  static async revokeApiKey(customerId: string): Promise<void> {
    await query(
      `UPDATE customers 
       SET api_key_hash = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $1`,
      [customerId]
    );
  }

  /**
   * Verify customer password
   */
  static async verifyPassword(email: string, password: string): Promise<Customer | null> {
    const customer = await this.getByEmail(email);
    
    if (!customer || !customer.password_hash) {
      return null;
    }

    const isValid = await bcrypt.compare(password, customer.password_hash);
    return isValid ? customer : null;
  }

  /**
   * Update password
   */
  static async updatePassword(customerId: string, newPassword: string): Promise<void> {
    const hash = await bcrypt.hash(newPassword, 10);
    
    await query(
      `UPDATE customers 
       SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $2`,
      [hash, customerId]
    );
  }

  /**
   * Update deployment status
   */
  static async updateDeploymentStatus(
    customerId: string,
    status: DeploymentStatus,
    data?: {
      instanceUrl?: string;
      instanceNamespace?: string;
      deploymentError?: string;
      deploymentNote?: string;
      bootstrapError?: string;
      bootstrappedAt?: Date;
    }
  ): Promise<Customer> {
    const fields = ['deployment_status = $1', 'updated_at = CURRENT_TIMESTAMP'];
    const values: any[] = [status];
    let paramIndex = 2;

    if (data?.instanceUrl) {
      fields.push(`instance_url = $${paramIndex}`);
      values.push(data.instanceUrl);
      paramIndex++;
    }

    if (data?.instanceNamespace) {
      fields.push(`instance_namespace = $${paramIndex}`);
      values.push(data.instanceNamespace);
      paramIndex++;
    }

    if (data?.deploymentError) {
      fields.push(`deployment_error = $${paramIndex}`);
      values.push(data.deploymentError);
      paramIndex++;
    }

    if (data?.deploymentNote) {
      fields.push(`last_provisioning_step = $${paramIndex}`);
      values.push(data.deploymentNote);
      paramIndex++;
    }

    if (data?.bootstrapError) {
      fields.push(`last_provisioning_error = $${paramIndex}`);
      values.push(data.bootstrapError);
      paramIndex++;
    }

    if (data?.bootstrappedAt) {
      fields.push(`bootstrapped_at = $${paramIndex}`);
      values.push(data.bootstrappedAt);
      paramIndex++;
    }

    if (status === 'ready') {
      fields.push('deployed_at = CURRENT_TIMESTAMP');
    }

    values.push(customerId);

    const result = await query<Customer>(
      `UPDATE customers SET ${fields.join(', ')} WHERE customer_id = $${paramIndex} RETURNING *`,
      values
    );

    return result.rows[0];
  }

  /**
   * Update provisioning step (for observability and idempotent retries)
   */
  static async updateProvisioningStep(
    customerId: string,
    step: string,
    error?: string
  ): Promise<Customer> {
    const fields = [
      'last_provisioning_step = $1',
      'updated_at = CURRENT_TIMESTAMP'
    ];
    const values: any[] = [step];
    let paramIndex = 2;

    if (error) {
      fields.push(`last_provisioning_error = $${paramIndex}`);
      values.push(error);
      paramIndex++;
    } else {
      // Clear error on successful step
      fields.push('last_provisioning_error = NULL');
    }

    values.push(customerId);

    const result = await query<Customer>(
      `UPDATE customers SET ${fields.join(', ')} WHERE customer_id = $${paramIndex} RETURNING *`,
      values
    );

    return result.rows[0];
  }

  /**
   * Mark provisioning as started
   */
  static async markProvisioningStarted(customerId: string): Promise<Customer> {
    const result = await query<Customer>(
      `UPDATE customers 
       SET provisioning_started_at = CURRENT_TIMESTAMP,
           provisioning_retry_count = COALESCE(provisioning_retry_count, 0) + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $1 
       RETURNING *`,
      [customerId]
    );

    return result.rows[0];
  }

  /**
   * Mark provisioning as completed
   */
  static async markProvisioningCompleted(customerId: string): Promise<Customer> {
    const result = await query<Customer>(
      `UPDATE customers 
       SET provisioning_completed_at = CURRENT_TIMESTAMP,
           deployment_status = 'ready',
           deployed_at = CURRENT_TIMESTAMP,
           last_provisioning_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $1 
       RETURNING *`,
      [customerId]
    );

    return result.rows[0];
  }

  /**
   * Update TigerData database provisioning details
   */
  static async updateTigerDataDetails(
    customerId: string,
    data: {
      db_service_id: string;
      db_host: string;
      db_port: number;
      db_name: string;
      db_region: string;
      db_provisioned_at: Date;
      db_api_response: any;
      db_initialized: boolean;
      deployment_status: string;
    }
  ): Promise<Customer> {
    const result = await query<Customer>(
      `UPDATE customers 
       SET db_service_id = $1, 
           db_host = $2, 
           db_port = $3, 
           db_name = $4, 
           db_region = $5, 
           db_provisioned_at = $6, 
           db_api_response = $7, 
           db_initialized = $8, 
           deployment_status = $9,
           updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $10 
       RETURNING *`,
      [
        data.db_service_id,
        data.db_host,
        data.db_port,
        data.db_name,
        data.db_region,
        data.db_provisioned_at,
        JSON.stringify(data.db_api_response),
        data.db_initialized,
        data.deployment_status,
        customerId,
      ]
    );

    return result.rows[0];
  }

  /**
   * Update 1Password secret details
   */
  static async updateSecretDetails(
    customerId: string,
    data: {
      secret_item_id: string;
      secret_created_at: Date;
      deployment_status: string;
    }
  ): Promise<Customer> {
    const result = await query<Customer>(
      `UPDATE customers 
       SET secret_item_id = $1, 
           secret_created_at = $2, 
           deployment_status = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $4 
       RETURNING *`,
      [
        data.secret_item_id,
        data.secret_created_at,
        data.deployment_status,
        customerId,
      ]
    );

    return result.rows[0];
  }

  /**
   * Increment Argo CD retry count
   */
  static async incrementArgoRetry(customerId: string): Promise<Customer> {
    const result = await query<Customer>(
      `UPDATE customers 
       SET argo_retry_count = COALESCE(argo_retry_count, 0) + 1,
           argo_last_retry_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $1 
       RETURNING *`,
      [customerId]
    );

    return result.rows[0];
  }

  /**
   * Reset Argo CD retry count
   */
  static async resetArgoRetry(customerId: string): Promise<Customer> {
    const result = await query<Customer>(
      `UPDATE customers 
       SET argo_retry_count = 0,
           argo_last_retry_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $1 
       RETURNING *`,
      [customerId]
    );

    return result.rows[0];
  }

  /**
   * Create admin password reset token (SOC2 compliant)
   * Instead of storing plaintext password, creates one-time reset token
   * 
   * @param customerId - Customer ID
   * @param tokenHash - bcrypt hash of reset token (not plaintext)
   * @param expiresAt - When token expires (typically 24 hours)
   */
  static async createAdminPasswordResetToken(
    customerId: string,
    tokenHash: string,
    expiresAt: Date
  ): Promise<Customer> {
    const result = await query<Customer>(
      `UPDATE customers 
       SET admin_reset_token_hash = $1,
           admin_reset_token_expires_at = $2,
           admin_reset_token_sent_at = CURRENT_TIMESTAMP,
           admin_reset_token_used = false,
           updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $3 
       RETURNING *`,
      [tokenHash, expiresAt, customerId]
    );

    return result.rows[0];
  }

  /**
   * Mark admin password reset token as used
   * Called when customer successfully sets their password
   * 
   * @param customerId - Customer ID
   */
  static async markAdminPasswordResetTokenUsed(customerId: string): Promise<Customer> {
    const result = await query<Customer>(
      `UPDATE customers 
       SET admin_reset_token_used = true,
           admin_reset_token_used_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $1 
       RETURNING *`,
      [customerId]
    );

    return result.rows[0];
  }
}
