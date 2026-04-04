import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { pool } from '../db/connection';
import logger from '../utils/logger';

// Create child logger with Mosquitto Auth context
const authLogger = logger.child({ module: 'MosquittoAuth' });

const router = Router();

/**
 * Mosquitto HTTP Authentication Backend
 * 
 * This router provides HTTP endpoints for Mosquitto MQTT broker authentication
 * using the mosquitto-go-auth plugin's HTTP backend.
 * 
 * Endpoints:
 * - POST /user: Username/password authentication
 * - POST /superuser: Superuser privilege check
 * - POST /acl: Topic access control list check
 * 
 * All endpoints return:
 * - 200 OK: Access granted
 * - 403 Forbidden: Access denied
 * - 500 Internal Server Error: Server error
 */

/**
 * Helper function to match MQTT topics with wildcard patterns
 * 
 * MQTT wildcards:
 * - + : Single-level wildcard (matches exactly one level)
 * - # : Multi-level wildcard (matches zero or more levels, must be last)
 * 
 * 
 * @param topic - The actual MQTT topic to check
 * @param pattern - The pattern with wildcards to match against
 * @returns true if topic matches pattern, false otherwise
 */
function topicMatches(topic: string, pattern: string): boolean {
  // Exact match
  if (topic === pattern) {
    return true;
  }

  // Convert MQTT wildcard pattern to regex
  // + matches exactly one level (no forward slashes)
  // # matches zero or more levels (including forward slashes)
  const regexPattern = pattern
    .replace(/\+/g, '[^/]+')        // + becomes [^/]+ (one or more non-slash chars)
    .replace(/#/g, '.*')             // # becomes .* (zero or more of any char)
    .replace(/\//g, '\\/');          // Escape forward slashes

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(topic);
}

/**
 * POST /user
 * 
 * Authenticate username and password
 * 
 * Request body (JSON or form-encoded):
 * {
 *   "username": "string",
 *   "password": "string"
 * }
 * 
 * Response:
 * - 200 OK: Authentication successful
 * - 403 Forbidden: Invalid credentials or inactive user
 * - 500 Internal Server Error: Database error
 */
router.post('/user', async (req: Request, res: Response) => {
  // Support both JSON body and query parameters (for EMQX compatibility)
  const username = req.body?.username || req.query?.username as string;
  const password = req.body?.password || req.query?.password as string;

  // Log raw request for debugging
  authLogger.info('User authentication request received', {
    hasBody: !!req.body,
    bodyKeys: req.body ? Object.keys(req.body) : [],
    hasQuery: Object.keys(req.query).length > 0,
    queryKeys: Object.keys(req.query),
    contentType: req.get('content-type'),
    username
  });

  if (!username || !password) {
    authLogger.info('Missing credentials in request');
    return res.status(403).json({ result: 'deny', error: 'Missing credentials' });
  }

  authLogger.info('User authentication attempt', { username });

  try {
    // Query user from database
    const result = await pool.query(
      'SELECT password_hash, is_active FROM mqtt_users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      authLogger.info('User not found', { username });
      return res.status(403).json({ result: 'deny', error: 'User not found' });
    }

    const user = result.rows[0];

    // Check if user is active
    if (!user.is_active) {
      authLogger.info('User inactive', { username });
      return res.status(403).json({ result: 'deny', error: 'User inactive' });
    }

    // Verify password using bcrypt
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      authLogger.info('Invalid password for user', { username });
      return res.status(403).json({ result: 'deny', error: 'Invalid password' });
    }

    authLogger.info('User authenticated successfully', { username });
    return res.status(200).json({ result: 'allow', is_superuser: false });

  } catch (error) {
    authLogger.error('Database error during user authentication', { username, error: error instanceof Error ? error.message : String(error) });
    return res.status(500).json({ result: 'deny', error: 'Internal server error' });
  }
});

/**
 * POST /superuser
 * 
 * Check if user has superuser privileges
 * Superusers bypass all ACL checks and have full access
 * 
 * Request body:
 * {
 *   "username": "string"
 * }
 * 
 * Response:
 * - 200 OK: User is a superuser
 * - 403 Forbidden: User is not a superuser or not found
 * - 500 Internal Server Error: Database error
 */
router.post('/superuser', async (req: Request, res: Response) => {
  const { username } = req.body;

  if (!username) {
    authLogger.info('Missing username for superuser check');
    return res.status(403).json({ result: 'deny', error: 'Missing username' });
  }


  try {
    // Query superuser status
    const result = await pool.query(
      'SELECT is_superuser FROM mqtt_users WHERE username = $1 AND is_active = true',
      [username]
    );

    if (result.rows.length === 0) {
      authLogger.info('User not found or inactive', { username });
      return res.status(403).json({ result: 'deny', error: 'User not found or inactive' });
    }

    const isSuperuser = result.rows[0].is_superuser;

    if (isSuperuser) {
      return res.status(200).json({ result: 'allow', is_superuser: true });
    } else {
      return res.status(403).json({ result: 'deny', error: 'Not a superuser' });
    }

  } catch (error) {
    authLogger.error('Database error during superuser check', { username, error: error instanceof Error ? error.message : String(error) });
    return res.status(500).json({ result: 'deny', error: 'Internal server error' });
  }
});

/**
 * POST /acl
 * 
 * Check if user has access to a specific topic
 * 
 * Request body (JSON or form-encoded):
 * {
 *   "username": "string",
 *   "topic": "string",
 *   "acc": number  // 1=read, 2=write
 * }
 * 
 * Response:
 * - 200 OK: Access granted
 * - 403 Forbidden: Access denied
 * - 500 Internal Server Error: Database error
 * 
 * Access codes:
 * - 1: Read access (subscribe)
 * - 2: Write access (publish)
 * 
 * ACL rules support MQTT wildcards in the topic pattern
 */
router.post('/acl', async (req: Request, res: Response) => {
  // Support both JSON body and query parameters (for EMQX compatibility)
  const username = req.body?.username || req.query?.username as string;
  const topic = req.body?.topic || req.query?.topic as string;
  const acc = req.body?.acc || req.query?.acc;
  const action = req.body?.action || req.query?.action as string | undefined;

  // Log raw request for debugging
  authLogger.debug('ACL request received', {
    hasBody: !!req.body,
    bodyKeys: req.body ? Object.keys(req.body) : [],
    hasQuery: Object.keys(req.query).length > 0,
    queryKeys: Object.keys(req.query),
    contentType: req.get('content-type'),
    username,
    topic,
    acc,
    action
  });

  if (!username || !topic || (acc === undefined && !action)) {
    authLogger.debug('Missing ACL parameters');
    return res.status(403).json({ result: 'deny', error: 'Missing parameters' });
  }

  const resolvedAcc = acc !== undefined
    ? acc
    : action === 'publish'
      ? 2
      : 1;
  const accessType = resolvedAcc === 1 || resolvedAcc === '1'
    ? 'READ'
    : resolvedAcc === 2 || resolvedAcc === '2'
      ? 'WRITE'
      : `UNKNOWN(${resolvedAcc})`;
  authLogger.info('ACL check', { username, topic, accessType });

  try {
    // First check if user is a superuser (superusers have full access)
    const superuserResult = await pool.query(
      'SELECT is_superuser FROM mqtt_users WHERE username = $1 AND is_active = true',
      [username]
    );

    if (superuserResult.rows.length > 0 && superuserResult.rows[0].is_superuser) {
      authLogger.info('User is superuser, access GRANTED', { username, topic });
      return res.status(200).json({ result: 'allow' });
    }

    // Check ACL rules for this user
    const aclResult = await pool.query(
      'SELECT topic, access FROM mqtt_acls WHERE username = $1',
      [username]
    );

    if (aclResult.rows.length === 0) {
      authLogger.info('No ACL rules found for user, access DENIED', { username, topic });
      return res.status(403).json({ result: 'deny', error: 'No ACL rules found' });
    }

    // Check each ACL rule to find a match
    for (const rule of aclResult.rows) {
      if (topicMatches(topic, rule.topic)) {
        // Check if the access level includes the requested access
        // access is a bitwise field: 1=read, 2=write, 3=both
        const hasAccess = (rule.access & resolvedAcc) === resolvedAcc;

        if (hasAccess) {
          authLogger.debug('ACL matched pattern, access GRANTED', { username, topic, pattern: rule.topic });
          return res.status(200).json({ result: 'allow' });
        } else {
          authLogger.info('ACL matched pattern but insufficient access level, access DENIED', { username, topic, pattern: rule.topic });
          // Continue checking other rules
        }
      }
    }

    // No matching rule found or all matched rules had insufficient access
    authLogger.info('No matching ACL rule for topic, access DENIED', { username, topic });
    return res.status(403).json({ result: 'deny', error: 'Access denied' });

  } catch (error) {
    authLogger.error('Database error during ACL check', { username, topic, error: error instanceof Error ? error.message : String(error) });
    return res.status(500).json({ result: 'deny', error: 'Internal server error' });
  }
});

export default router;
