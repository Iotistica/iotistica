/**
 * 1Password SDK Service
 * Manages secrets in 1Password vault for customer database credentials
 * API Reference: https://developer.1password.com/docs/sdks/node/
 */

import { createClient, Client, Item, ItemOverview, ItemCategory, ItemFieldType } from '@1password/sdk';

export interface OnePasswordConfig {
  serviceAccountToken: string;
  vaultId: string;
}

export interface DatabaseCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export interface SecretItem {
  title: string;
  category: ItemCategory;
  fields: Array<{
    id: string;
    title: string;
    fieldType: ItemFieldType;
    value: string;
  }>;
}

export class OnePasswordError extends Error {
  constructor(
    message: string,
    public originalError?: any
  ) {
    super(message);
    this.name = 'OnePasswordError';
  }
}

export class OnePasswordService {
  private clientPromise?: Promise<Client>;
  private vaultId: string;
  private simulateMode: boolean;

  constructor(config?: Partial<OnePasswordConfig>) {
    console.log('[OnePasswordService] Constructor called');
    console.log('[OnePasswordService] SIMULATE_ONEPASSWORD env var:', process.env.SIMULATE_ONEPASSWORD);
    console.log('[OnePasswordService] All env keys:', Object.keys(process.env).filter(k => k.includes('SIMULATE') || k.includes('ONEPASSWORD')));
    
    this.simulateMode = process.env.SIMULATE_ONEPASSWORD === 'true';
    console.log('[OnePasswordService] simulateMode calculated as:', this.simulateMode);
    
    const serviceAccountToken = config?.serviceAccountToken || 
      process.env.ONEPASSWORD_CONNECT_TOKEN || 
      process.env.ONEPASSWORD_SERVICE_ACCOUNT_TOKEN || 
      '';
    
    this.vaultId = config?.vaultId || process.env.ONEPASSWORD_VAULT_ID || 'IOT-CLIENTS';

    // Skip initialization and validation if in simulation mode
    if (this.simulateMode) {
      console.log('[OnePasswordService] ⚠️  SIMULATION MODE ENABLED - Skipping 1Password client initialization');
      // Don't create clientPromise in simulation mode
      return;
    }

    if (!serviceAccountToken) {
      throw new OnePasswordError('1Password service account token is required');
    }

    try {
      this.clientPromise = createClient({
        auth: serviceAccountToken,
        integrationName: 'Iotistica Provisioning',
        integrationVersion: '1.0.0',
      });
      console.log('[OnePasswordService] Client initialization started');
    } catch (error) {
      throw new OnePasswordError(
        `Failed to initialize 1Password client: ${error}`,
        error
      );
    }
  }

  private async getClient(): Promise<Client> {
    if (!this.clientPromise) {
      throw new OnePasswordError('1Password client not initialized (simulation mode enabled?)');
    }
    return await this.clientPromise;
  }

  /**
   * Create a secret item for database credentials
   * @param namespace - Customer namespace (e.g., client-abc123)
   * @param credentials - Database connection credentials
   */
  async createSecretItem(
    namespace: string,
    credentials: DatabaseCredentials
  ): Promise<string> {
    console.log(`[OnePasswordService] Creating secret for namespace: ${namespace}`);

    // Simulation mode - don't actually create
    if (this.simulateMode) {
      const mockItemId = `mock-1pass-item-${namespace}-${Date.now()}`;
      console.log(`[OnePasswordService] ⚠️  SIMULATION MODE - Not actually creating 1Password item`);
      console.log(`[OnePasswordService] ✅ Mock item created: ${mockItemId}`);
      return mockItemId;
    }

    const itemTitle = `sql-credentials-client-${namespace}`;

    try {
      const client = await this.getClient();
      
      // Check if item already exists
      const existingItem = await this.getItemByTitle(itemTitle);
      if (existingItem) {
        console.log(`[OnePasswordService] Item already exists, updating: ${existingItem.id}`);
        await this.updateItem(existingItem.id, credentials);
        return existingItem.id;
      }

      // Create new item using SDK
      const item = await client.items.create({
        vaultId: this.vaultId,
        title: itemTitle,
        category: ItemCategory.Database,
        tags: [namespace],
        fields: [
          {
            id: 'server',
            title: 'Server',
            fieldType: ItemFieldType.Text,
            value: credentials.host,
          },
          {
            id: 'port',
            title: 'Port',
            fieldType: ItemFieldType.Text,
            value: credentials.port.toString(),
          },
          {
            id: 'username',
            title: 'Username',
            fieldType: ItemFieldType.Text,
            value: credentials.username,
          },
          {
            id: 'password',
            title: 'Password',
            fieldType: ItemFieldType.Concealed,
            value: credentials.password,
          },
          {
            id: 'dbname',
            title: 'Database',
            fieldType: ItemFieldType.Text,
            value: credentials.database,
          },
        ],
      });

      console.log(`[OnePasswordService] Secret created successfully: ${item.id}`);
      return item.id;
    } catch (error) {
      console.error(`[OnePasswordService] Failed to create secret:`, error);
      throw new OnePasswordError(`Failed to create secret: ${error}`, error);
    }
  }

  /**
   * Get an item by title
   * @param title - Item title
   */
  private async getItemByTitle(title: string): Promise<ItemOverview | null> {
    try {
      const client = await this.getClient();
      const items = await client.items.list(this.vaultId);
      const item = items.find((i) => i.title === title);
      return item || null;
    } catch (error) {
      console.error(`[OnePasswordService] Error finding item by title:`, error);
      return null;
    }
  }

  /**
   * Update an existing item with new credentials
   * @param itemId - 1Password item ID
   * @param credentials - New database credentials
   */
  async updateItem(itemId: string, credentials: DatabaseCredentials): Promise<void> {
    console.log(`[OnePasswordService] Updating item: ${itemId}`);

    try {
      const client = await this.getClient();
      
      // Get current item first (full item with all fields)
      const currentItem = await client.items.get(this.vaultId, itemId);

      // Update field values
      const updatedFields = currentItem.fields.map((field) => {
        switch (field.id) {
          case 'server':
            return { ...field, value: credentials.host };
          case 'port':
            return { ...field, value: credentials.port.toString() };
          case 'username':
            return { ...field, value: credentials.username };
          case 'password':
            return { ...field, value: credentials.password };
          case 'dbname':
            return { ...field, value: credentials.database };
          default:
            return field;
        }
      });

      // Put updated item
      await client.items.put({
        ...currentItem,
        fields: updatedFields,
      });

      console.log(`[OnePasswordService] Item updated successfully: ${itemId}`);
    } catch (error) {
      console.error(`[OnePasswordService] Failed to update item:`, error);
      throw new OnePasswordError(`Failed to update item: ${error}`, error);
    }
  }

  /**
   * Create a generic secret item (flexible for any secret type)
   * @param clientId - Client identifier
   * @param secretType - Type of secret (sql, redis, mqtt, openai, api-jwt)
   * @param fields - Key-value pairs for the secret fields
   * @returns Item ID
   */
  async createGenericSecretItem(
    clientId: string,
    secretType: string,
    fields: Record<string, string>
  ): Promise<string> {
    // Special naming for api-jwt: no "credentials" in the name
    const itemTitle = secretType === 'api-jwt' 
      ? `api-jwt-client-${clientId}`
      : `${secretType}-credentials-client-${clientId}`;
    console.log(`[OnePasswordService] Creating ${secretType} secret: ${itemTitle}`);

    // Simulation mode - don't actually create
    if (this.simulateMode) {
      const mockItemId = `mock-1pass-${secretType}-${clientId}-${Date.now()}`;
      console.log(`[OnePasswordService] ⚠️  SIMULATION MODE - Mock item: ${mockItemId}`);
      return mockItemId;
    }

    try {
      const client = await this.getClient();
      
      // Check if item already exists
      const existingItem = await this.getItemByTitle(itemTitle);
      if (existingItem) {
        console.log(`[OnePasswordService] Item exists, updating: ${existingItem.id}`);
        await this.updateGenericItem(existingItem.id, fields);
        return existingItem.id;
      }

      // Determine category based on secret type
      const category = secretType === 'sql' ? ItemCategory.Database : ItemCategory.Password;

      // Convert fields to 1Password field format
      // Use exact field names from secretTemplates schema (no capitalization)
      const itemFields = Object.entries(fields).map(([key, value]) => ({
        id: key,
        title: key, // Use exact field name from schema
        fieldType: key.includes('password') || key.includes('secret') || key.includes('key') || key === 'token'
          ? ItemFieldType.Concealed
          : ItemFieldType.Text,
        value: value || 'PLACEHOLDER', // Use placeholder if value is empty
      }));

      // Create new item
      const item = await client.items.create({
        vaultId: this.vaultId,
        title: itemTitle,
        category,
        tags: [`client-${clientId}`, secretType],
        fields: itemFields,
      });

      console.log(`[OnePasswordService] ✅ ${secretType} secret created: ${item.id}`);
      return item.id;
    } catch (error) {
      console.error(`[OnePasswordService] Failed to create ${secretType} secret:`, error);
      throw new OnePasswordError(`Failed to create ${secretType} secret: ${error}`, error);
    }
  }

  /**
   * Update a generic secret item
   * @param itemId - 1Password item ID
   * @param fields - New field values
   */
  async updateGenericItem(itemId: string, fields: Record<string, string>): Promise<void> {
    console.log(`[OnePasswordService] Updating item: ${itemId}`);

    // Simulation mode - don't actually update
    if (this.simulateMode) {
      console.log(`[OnePasswordService] ⚠️  SIMULATION MODE - Skipping update`);
      return;
    }

    try {
      const client = await this.getClient();
      const currentItem = await client.items.get(this.vaultId, itemId);

      // Update field values
      const updatedFields = currentItem.fields.map((field) => {
        if (fields[field.id]) {
          return { ...field, value: fields[field.id] };
        }
        return field;
      });

      // Add new fields if they don't exist
      // Use exact field names from secretTemplates schema (no capitalization)
      Object.entries(fields).forEach(([key, value]) => {
        const fieldExists = currentItem.fields.some((f) => f.id === key);
        if (!fieldExists) {
          updatedFields.push({
            id: key,
            title: key, // Use exact field name from schema
            fieldType: key.includes('password') || key.includes('secret') || key.includes('key') || key === 'token'
              ? ItemFieldType.Concealed
              : ItemFieldType.Text,
            value,
          });
        }
      });

      // Put updated item
      await client.items.put({
        ...currentItem,
        fields: updatedFields,
      });

      console.log(`[OnePasswordService] ✅ Item updated: ${itemId}`);
    } catch (error) {
      console.error(`[OnePasswordService] Failed to update item:`, error);
      throw new OnePasswordError(`Failed to update item: ${error}`, error);
    }
  }

  /**
   * Delete a secret item
   * @param itemId - 1Password item ID
   */
  async deleteItem(itemId: string): Promise<void> {
    console.log(`[OnePasswordService] Deleting item: ${itemId}`);

    // Simulation mode - don't actually delete
    if (this.simulateMode) {
      console.log(`[OnePasswordService] ⚠️  SIMULATION MODE - Not actually deleting 1Password item: ${itemId}`);
      return;
    }

    try {
      const client = await this.getClient();
      await client.items.delete(this.vaultId, itemId);
      console.log(`[OnePasswordService] Item deleted successfully: ${itemId}`);
    } catch (error) {
      console.error(`[OnePasswordService] Failed to delete item:`, error);
      throw new OnePasswordError(`Failed to delete item: ${error}`, error);
    }
  }

  /**
   * Get item by ID
   * @param itemId - 1Password item ID
   */
  async getItem(itemId: string): Promise<Item> {
    try {
      const client = await this.getClient();
      const item = await client.items.get(this.vaultId, itemId);
      return item;
    } catch (error) {
      throw new OnePasswordError(`Failed to get item: ${error}`, error);
    }
  }

  /**
   * List all items in the vault
   */
  async listItems(): Promise<ItemOverview[]> {
    try {
      const client = await this.getClient();
      const items = await client.items.list(this.vaultId);
      return items;
    } catch (error) {
      throw new OnePasswordError(`Failed to list items: ${error}`, error);
    }
  }
}
