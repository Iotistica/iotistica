import type { FastifyPluginAsync } from 'fastify';
import { pool } from '../db/connection';
import logger from '../utils/logger';
import { verifyPassword } from '../utils/secret-hashing';

interface MosquittoAuthBody {
  username?: string;
  password?: string;
  topic?: string;
  acc?: number | string;
  action?: string;
}

interface MosquittoAuthQuerystring {
  username?: string;
  password?: string;
  topic?: string;
  acc?: number | string;
  action?: string;
}

interface MqttUserRow {
  password_hash: string;
  is_active: boolean;
}

interface MqttSuperuserRow {
  is_superuser: boolean;
}

interface MqttAclRow {
  topic: string;
  access: number;
}

const plugin: FastifyPluginAsync = async (fastify) => {
  const authLogger = logger.child({ module: 'MosquittoAuth' });

  function getRequestValue(
    body: MosquittoAuthBody | undefined,
    query: MosquittoAuthQuerystring,
    key: keyof MosquittoAuthBody,
  ): string | number | undefined {
    return body?.[key] ?? query[key];
  }

  function topicMatches(topic: string, pattern: string): boolean {
    if (topic === pattern) {
      return true;
    }

    const regexPattern = pattern
      .replace(/\+/g, '[^/]+')
      .replace(/#/g, '.*')
      .replace(/\//g, '\\/');

    return new RegExp(`^${regexPattern}$`).test(topic);
  }

  fastify.post<{ Body: MosquittoAuthBody; Querystring: MosquittoAuthQuerystring }>('/user', async (req, reply) => {
    const username = getRequestValue(req.body, req.query, 'username');
    const password = getRequestValue(req.body, req.query, 'password');

    authLogger.info('User authentication request received', {
      hasBody: !!req.body,
      bodyKeys: req.body ? Object.keys(req.body) : [],
      hasQuery: Object.keys(req.query).length > 0,
      queryKeys: Object.keys(req.query),
      contentType: req.headers['content-type'],
      username,
    });

    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      authLogger.info('Missing credentials in request');
      return reply.status(403).send({ result: 'deny', error: 'Missing credentials' });
    }

    try {
      const result = await pool.query<MqttUserRow>(
        'SELECT password_hash, is_active FROM mqtt_users WHERE username = $1',
        [username],
      );

      if (result.rows.length === 0) {
        authLogger.info('User not found', { username });
        return reply.status(403).send({ result: 'deny', error: 'User not found' });
      }

      const user = result.rows[0];
      if (!user.is_active) {
        authLogger.info('User inactive', { username });
        return reply.status(403).send({ result: 'deny', error: 'User inactive' });
      }

      const passwordVerification = await verifyPassword(password, user.password_hash);
      if (!passwordVerification.valid) {
        authLogger.info('Invalid password for user', { username });
        return reply.status(403).send({ result: 'deny', error: 'Invalid password' });
      }

      if (passwordVerification.upgradedHash) {
        await pool.query(
          'UPDATE mqtt_users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE username = $2',
          [passwordVerification.upgradedHash, username],
        );
      }

      authLogger.info('User authenticated successfully', { username });
      return reply.status(200).send({ result: 'allow', is_superuser: false });
    } catch (error) {
      authLogger.error('Database error during user authentication', {
        username,
        error: error instanceof Error ? error.message : String(error),
      });
      return reply.status(500).send({ result: 'deny', error: 'Internal server error' });
    }
  });

  fastify.post<{ Body: MosquittoAuthBody }>('/superuser', async (req, reply) => {
    const { username } = req.body;

    if (!username) {
      authLogger.info('Missing username for superuser check');
      return reply.status(403).send({ result: 'deny', error: 'Missing username' });
    }

    try {
      const result = await pool.query<MqttSuperuserRow>(
        'SELECT is_superuser FROM mqtt_users WHERE username = $1 AND is_active = true',
        [username],
      );

      if (result.rows.length === 0) {
        authLogger.info('User not found or inactive', { username });
        return reply.status(403).send({ result: 'deny', error: 'User not found or inactive' });
      }

      return result.rows[0].is_superuser
        ? reply.status(200).send({ result: 'allow', is_superuser: true })
        : reply.status(403).send({ result: 'deny', error: 'Not a superuser' });
    } catch (error) {
      authLogger.error('Database error during superuser check', {
        username,
        error: error instanceof Error ? error.message : String(error),
      });
      return reply.status(500).send({ result: 'deny', error: 'Internal server error' });
    }
  });

  fastify.post<{ Body: MosquittoAuthBody; Querystring: MosquittoAuthQuerystring }>('/acl', async (req, reply) => {
    const username = getRequestValue(req.body, req.query, 'username');
    const topic = getRequestValue(req.body, req.query, 'topic');
    const acc = getRequestValue(req.body, req.query, 'acc');
    const action = getRequestValue(req.body, req.query, 'action');

    authLogger.debug('ACL request received', {
      hasBody: !!req.body,
      bodyKeys: req.body ? Object.keys(req.body) : [],
      hasQuery: Object.keys(req.query).length > 0,
      queryKeys: Object.keys(req.query),
      contentType: req.headers['content-type'],
      username,
      topic,
      acc,
      action,
    });

    if (typeof username !== 'string' || typeof topic !== 'string' || (acc === undefined && typeof action !== 'string')) {
      authLogger.debug('Missing ACL parameters');
      return reply.status(403).send({ result: 'deny', error: 'Missing parameters' });
    }

    const resolvedAcc = acc !== undefined
      ? typeof acc === 'string' ? parseInt(acc, 10) : acc
      : action === 'publish'
        ? 2
        : 1;

    authLogger.debug('ACL check', {
      username,
      topic,
      accessType: resolvedAcc === 1 ? 'READ' : resolvedAcc === 2 ? 'WRITE' : `UNKNOWN(${resolvedAcc})`,
    });

    try {
      const superuserResult = await pool.query<MqttSuperuserRow>(
        'SELECT is_superuser FROM mqtt_users WHERE username = $1 AND is_active = true',
        [username],
      );

      if (superuserResult.rows.length > 0 && superuserResult.rows[0].is_superuser) {
        authLogger.info('User is superuser, access GRANTED', { username, topic });
        return reply.status(200).send({ result: 'allow' });
      }

      const aclResult = await pool.query<MqttAclRow>(
        'SELECT topic, access FROM mqtt_acls WHERE username = $1',
        [username],
      );

      if (aclResult.rows.length === 0) {
        authLogger.info('No ACL rules found for user, access DENIED', { username, topic });
        return reply.status(403).send({ result: 'deny', error: 'No ACL rules found' });
      }

      for (const rule of aclResult.rows) {
        if (!topicMatches(topic, rule.topic)) {
          continue;
        }

        const hasAccess = (rule.access & resolvedAcc) === resolvedAcc;
        if (hasAccess) {
          authLogger.debug('ACL matched pattern, access GRANTED', { username, topic, pattern: rule.topic });
          return reply.status(200).send({ result: 'allow' });
        }

        authLogger.info('ACL matched pattern but insufficient access level, access DENIED', {
          username,
          topic,
          pattern: rule.topic,
        });
      }

      authLogger.info('No matching ACL rule for topic, access DENIED', { username, topic });
      return reply.status(403).send({ result: 'deny', error: 'Access denied' });
    } catch (error) {
      authLogger.error('Database error during ACL check', {
        username,
        topic,
        error: error instanceof Error ? error.message : String(error),
      });
      return reply.status(500).send({ result: 'deny', error: 'Internal server error' });
    }
  });
};

export default plugin;