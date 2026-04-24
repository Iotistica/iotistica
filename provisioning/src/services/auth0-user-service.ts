import crypto from 'crypto';
import axios from 'axios';
import { logger } from '../utils/logger';

interface Auth0Config {
  domain: string;
  clientId: string;
  connection: string;
}

export interface Auth0UserProvisionResult {
  created: boolean;
  passwordSetupEmailSent: boolean;
  auth0Sub?: string;
}

interface Auth0ManagementConfig {
  domain: string;
  clientId: string;
  clientSecret: string;
  audience: string;
}

export class Auth0UserService {
  private static getConfig(): Auth0Config {
    const domain = process.env.AUTH0_DOMAIN;
    const clientId = process.env.AUTH0_CLIENT_ID;
    const connection = process.env.AUTH0_DB_CONNECTION || 'Username-Password-Authentication';

    if (!domain || !clientId) {
      throw new Error('Auth0 is not configured for database user provisioning');
    }

    return { domain, clientId, connection };
  }

  private static generateTemporaryPassword(): string {
    return `${crypto.randomBytes(24).toString('base64url')}Aa1!`;
  }

  private static getManagementConfig(): Auth0ManagementConfig | null {
    const domain = process.env.AUTH0_DOMAIN;
    const clientId = process.env.AUTH0_M2M_CLIENT_ID || process.env.AUTH0_CLIENT_ID;
    const clientSecret = process.env.AUTH0_M2M_CLIENT_SECRET || process.env.AUTH0_CLIENT_SECRET;

    if (!domain || !clientId || !clientSecret) {
      return null;
    }

    return {
      domain,
      clientId,
      clientSecret,
      audience: `https://${domain}/api/v2/`,
    };
  }

  private static async getManagementApiToken(config: Auth0ManagementConfig): Promise<string> {
    const response = await axios.post(
      `https://${config.domain}/oauth/token`,
      {
        grant_type: 'client_credentials',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        audience: config.audience,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    return response.data.access_token as string;
  }

  static async resolveAuth0SubByEmail(email: string): Promise<string | null> {
    const config = this.getManagementConfig();
    if (!config) {
      logger.warn('[Auth0UserService] Management API config missing, skipping auth0_sub resolve', {
        email,
        hasDomain: Boolean(process.env.AUTH0_DOMAIN),
        hasClientId: Boolean(process.env.AUTH0_M2M_CLIENT_ID || process.env.AUTH0_CLIENT_ID),
        hasClientSecret: Boolean(process.env.AUTH0_M2M_CLIENT_SECRET || process.env.AUTH0_CLIENT_SECRET),
      });
      return null;
    }

    try {
      const token = await this.getManagementApiToken(config);
      const response = await axios.get(
        `https://${config.domain}/api/v2/users-by-email`,
        {
          params: { email },
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );

      const users = response.data as Array<{ user_id?: string }>;
      const userId = users.find((user) => typeof user.user_id === 'string' && user.user_id.length > 0)?.user_id;

      return userId || null;
    } catch (error) {
      logger.warn('[Auth0UserService] Failed to resolve auth0_sub by email', {
        email,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  static async ensureDatabaseUser(data: {
    email: string;
    fullName?: string;
    username?: string;
  }): Promise<{ created: boolean }> {
    const config = this.getConfig();

    try {
      await axios.post(
        `https://${config.domain}/dbconnections/signup`,
        {
          client_id: config.clientId,
          email: data.email,
          password: this.generateTemporaryPassword(),
          connection: config.connection,
          user_metadata: {
            fullName: data.fullName || '',
            username: data.username || '',
          },
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      return { created: true };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 400) {
        const auth0Error = error.response.data as { code?: string; description?: string; error_description?: string } | undefined;
        const description = auth0Error?.description || auth0Error?.error_description || error.message;
        const descriptionLower = description.toLowerCase();
        const isExistingUser =
          auth0Error?.code === 'invalid_signup' ||
          descriptionLower.includes('already') ||
          descriptionLower.includes('exists') ||
          descriptionLower.includes('in use');

        if (isExistingUser) {
          return { created: false };
        }
      }

      logger.error('[Auth0UserService] Failed to ensure Auth0 user', {
        email: data.email,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  static async sendPasswordSetupEmail(email: string): Promise<void> {
    const config = this.getConfig();

    await axios.post(
      `https://${config.domain}/dbconnections/change_password`,
      {
        client_id: config.clientId,
        email,
        connection: config.connection,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
  }

  static async ensureUserAndSendPasswordSetup(data: {
    email: string;
    fullName?: string;
    username?: string;
  }): Promise<Auth0UserProvisionResult> {
    const result = await this.ensureDatabaseUser(data);
    await this.sendPasswordSetupEmail(data.email);
    const auth0Sub = await this.resolveAuth0SubByEmail(data.email);

    return {
      created: result.created,
      passwordSetupEmailSent: true,
      auth0Sub: auth0Sub || undefined,
    };
  }
}