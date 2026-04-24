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

    return {
      created: result.created,
      passwordSetupEmailSent: true,
    };
  }
}