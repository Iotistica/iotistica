import { getKnex } from '../connection';

interface EndpointMqttAuthConfig {
  protocol?: string;
  connection?: {
    topic?: string;
  };
  auth?: {
    mqtt?: {
      username?: string;
      passwordHash?: string;
      hashAlgo?: string;
      access?: number;
    };
  };
}

interface DesiredMqttUser {
  username: string;
  password_hash: string;
}

interface DesiredMqttAcl {
  username: string;
  clientid: string;
  topic: string;
  access: number;
  priority: number;
}

export class MqttAuthModel {
  static async syncFromTargetEndpoints(endpoints: EndpointMqttAuthConfig[]): Promise<{ users: number; acls: number }> {
    const knex = getKnex();

    const usersByName = new Map<string, DesiredMqttUser>();
    const acls: DesiredMqttAcl[] = [];

    for (const endpoint of endpoints || []) {
      if (endpoint?.protocol !== 'mqtt') {
        continue;
      }

      const mqttAuth = endpoint.auth?.mqtt;
      const username = mqttAuth?.username?.trim();
      const passwordHash = mqttAuth?.passwordHash?.trim();
      const hashAlgo = mqttAuth?.hashAlgo?.trim().toLowerCase();
      const topic = endpoint.connection?.topic?.trim();
      const access = Number.isInteger(mqttAuth?.access) ? Number(mqttAuth?.access) : 2;

      // Skip incomplete or invalid auth entries.
      if (!username || !passwordHash || !topic) {
        continue;
      }

      // Current manifest supports bcrypt hashes only.
      if (hashAlgo !== 'bcrypt') {
        continue;
      }

      if (![1, 2, 3].includes(access)) {
        continue;
      }

      usersByName.set(username, {
        username,
        password_hash: passwordHash,
      });

      acls.push({
        username,
        clientid: username,
        topic,
        access,
        priority: 0,
      });
    }

    await knex.transaction(async (trx) => {
      await trx('mqtt_acls').delete();
      await trx('mqtt_users').delete();

      const users = Array.from(usersByName.values());
      if (users.length > 0) {
        await trx('mqtt_users').insert(
          users.map((u) => ({
            username: u.username,
            password_hash: u.password_hash,
            is_superuser: false,
            is_active: true,
            created_at: trx.fn.now(),
            updated_at: trx.fn.now(),
          }))
        );
      }

      if (acls.length > 0) {
        await trx('mqtt_acls').insert(
          acls.map((a) => ({
            username: a.username,
            clientid: a.clientid,
            topic: a.topic,
            access: a.access,
            priority: a.priority,
            created_at: trx.fn.now(),
          }))
        );
      }
    });

    return {
      users: usersByName.size,
      acls: acls.length,
    };
  }
}
