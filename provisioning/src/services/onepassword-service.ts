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
  private clientPromise: Promise<Client>;
  private vaultId: string;
  private simulateMode: boolean;

  constructor(config?: Partial<OnePasswordConfig>) {
    this.simulateMode = process.env.SIMULATE_ONEPASSWORD === 'true';
    
    const serviceAccountToken = config?.serviceAccountToken || 
      process.env.ONEPASSWORD_CONNECT_TOKEN || 
      process.env.ONEPASSWORD_SERVICE_ACCOUNT_TOKEN || 
      '';
    
    this.vaultId = config?.vaultId || process.env.ONEPASSWORD_VAULT_ID || 'IOT-CLIENTS';

    if (!serviceAccountToken) {
      throw new OnePasswordError('1Password service account token is required');
    }

    try {
      this.clientPromise = createClient({
        auth: serviceAccountToken,
        integrationName: 'Iotistic Provisioning',
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

    const itemTitle = `sql-credentials-${namespace}`;

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
        tags: ['iotistic', 'database', 'customer', namespace],
        fields: [
          {
            id: 'host',
            title: 'Host',
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
            id: 'database',
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
          case 'host':
            return { ...field, value: credentials.host };
          case 'port':
            return { ...field, value: credentials.port.toString() };
          case 'username':
            return { ...field, value: credentials.username };
          case 'password':
            return { ...field, value: credentials.password };
          case 'database':
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
   * Delete a secret item
   * @param itemId - 1Password item ID
   */
  async deleteItem(itemId: string): Promise<void> {
    console.log(`[OnePasswordService] Deleting item: ${itemId}`);

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
