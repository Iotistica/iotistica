/**
 * MQTT File-Based Auth Reconciler
 *
 * Generates native mosquitto passwd and ACL files from target endpoint manifests.
 * Writes files atomically and signals the broker to reload via SIGHUP (Docker API).
 *
 * Password hash format: $7$101$<base64-salt>$<base64-key>
 * This is the PBKDF2-SHA512 format produced by mosquitto_passwd -H sha512-pbkdf2,
 * implemented here in pure Node.js so no binary dependency is required.
 *
 * Reload behaviour:
 *   - SHA-256 content hash guards against unnecessary writes + SIGHUP.
 *   - Files are written atomically (tmp → rename) to avoid partial reads.
 *   - SIGHUP is sent via Docker API; failures are logged and swallowed so a
 *     missing container (systemd mode, or broker not yet started) is non-fatal.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';

// Minimal interface so the reconciler doesn't take a hard dep on DockerManager.
export interface ContainerManager {
  findContainerByName(name: string): Promise<{ kill(opts: { signal: string }): Promise<void> } | null>;
}

// ----- interfaces -----------------------------------------------------------

export interface EndpointMqttAuth {
  protocol?: string;
  connection?: { topic?: string };
  auth?: {
    mqtt?: {
      username?: string;
      passwordPlaintext?: string;  // plaintext available for file-hash generation
      passwordFileHash?: string;   // native mosquitto password-file hash from target state
      access?: number;
    };
  };
}

export interface FileAuthOptions {
  /** Directory where passwd and acl files are written. */
  authDir: string;
  /** Container name to send SIGHUP to after a file change. */
  containerName?: string;
  /** DockerManager (or compatible) for sending SIGHUP. Optional: no reload if absent. */
  dockerManager?: ContainerManager;
}

export interface ReconcileResult {
  changed: boolean;
  users: number;
  acls: number;
}

// ----- PBKDF2-SHA512 hash generation ----------------------------------------

/**
 * Generate a mosquitto-compatible password hash.
 * Format: $7$<iterations>$<base64-salt>$<base64-key>
 * Matches the output of mosquitto_passwd -H sha512-pbkdf2.
 */
export function generateMosquittoHash(password: string): string {
  const iterations = 101;
  const salt = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512');
  return `$7$${iterations}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// ----- file generators ------------------------------------------------------

interface UserEntry {
  username: string;
  passwordPlaintext?: string;
  passwordFileHash?: string;
  isSuperuser: boolean;
}

interface AclEntry {
  username: string;
  topic: string;
  access: number; // 1=read, 2=write, 3=readwrite
}

function buildPasswdContent(users: UserEntry[]): string {
  const managed = users.map(u => `${u.username}:${u.passwordFileHash || generateMosquittoHash(u.passwordPlaintext || '')}`);
  return managed.join('\n') + '\n';
}

function buildAclContent(users: UserEntry[], acls: AclEntry[]): string {
  const lines: string[] = [
    '# Mosquitto ACL file — managed by agent file-auth reconciler.',
    '# Do not edit by hand. Reload via SIGHUP to iotistic-mosquitto-agent.',
    '',
  ];

  // Superusers first with unrestricted access
  for (const u of users.filter(u => u.isSuperuser)) {
    lines.push(`user ${u.username}`, 'topic readwrite #', '');
  }

  // Per-user topic ACLs
  for (const a of acls) {
    const rw = a.access === 1 ? 'read' : a.access === 2 ? 'write' : 'readwrite';
    lines.push(`user ${a.username}`, `topic ${rw} ${a.topic}`, '');
  }

  return lines.join('\n');
}

// ----- atomic write helper --------------------------------------------------

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function readExistingHash(filePath: string): string {
  try {
    const existing = fs.readFileSync(filePath, 'utf8');
    return contentHash(existing);
  } catch {
    return '';
  }
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ----- main class -----------------------------------------------------------

export class MqttFileAuthReconciler {
  private readonly logger?: AgentLogger;

  constructor(logger?: AgentLogger) {
    this.logger = logger;
  }

  /**
   * Reconcile passwd and ACL files from the current endpoint manifest.
   *
   * Always includes a bootstrap superuser from MQTT_USERNAME / MQTT_PASSWORD
   * env vars so the agent's own MQTT client can authenticate.
   *
  * Endpoint users require either auth.mqtt.passwordFileHash or
  * auth.mqtt.passwordPlaintext to be present.
  * Bcrypt-only entries from the legacy cloud path are skipped because they
  * cannot be converted into mosquitto native password-file hashes.
   */
  async reconcile(endpoints: EndpointMqttAuth[], options: FileAuthOptions): Promise<ReconcileResult> {
    const users: UserEntry[] = [];
    const acls: AclEntry[] = [];

    // Bootstrap superuser from env vars
    const bootstrapUsername = process.env.MQTT_USERNAME?.trim();
    const bootstrapPassword = process.env.MQTT_PASSWORD?.trim();
    if (bootstrapUsername && bootstrapPassword) {
      users.push({ username: bootstrapUsername, passwordPlaintext: bootstrapPassword, isSuperuser: true });
    }

    // Endpoint users (need plaintext password for PBKDF2 hash generation)
    for (const ep of endpoints || []) {
      if (ep?.protocol !== 'mqtt') continue;

      const mqttAuth = ep.auth?.mqtt;
      const username = mqttAuth?.username?.trim();
      const plaintext = mqttAuth?.passwordPlaintext?.trim();
      const passwordFileHash = mqttAuth?.passwordFileHash?.trim();
      const rawTopic = ep.connection?.topic?.trim();
      const access = Number.isInteger(mqttAuth?.access) ? Number(mqttAuth?.access) : 2;

      if (!username || (!plaintext && !passwordFileHash) || !rawTopic) continue;
      if (![1, 2, 3].includes(access)) continue;
      if (bootstrapUsername && username === bootstrapUsername) continue;

      // Append /# to match base topic and any subtopics (e.g. .../d/<id>/temperature)
      const topic = rawTopic.endsWith('/#') ? rawTopic : `${rawTopic}/#`;

      users.push({ username, passwordPlaintext: plaintext, passwordFileHash, isSuperuser: false });
      acls.push({ username, topic, access });
    }

    if (users.length === 0) {
      this.logger?.warnSync('File auth reconciliation skipped: no users to write (MQTT_USERNAME/MQTT_PASSWORD not set?)', {
        component: LogComponents.configManager,
        operation: 'reconcileMqttFileAuth',
      });
      return { changed: false, users: 0, acls: 0 };
    }

    const passwdPath = path.join(options.authDir, 'passwd');
    const aclPath = path.join(options.authDir, 'acl');

    const newPasswd = buildPasswdContent(users);
    const newAcl = buildAclContent(users, acls);

    const passwdChanged = contentHash(newPasswd) !== readExistingHash(passwdPath);
    const aclChanged = contentHash(newAcl) !== readExistingHash(aclPath);
    const changed = passwdChanged || aclChanged;

    if (!changed) {
      this.logger?.infoSync('MQTT file auth unchanged, skipping write and reload', {
        component: LogComponents.configManager,
        operation: 'reconcileMqttFileAuth',
        users: users.length,
        acls: acls.length,
      });
      return { changed: false, users: users.length, acls: acls.length };
    }

    if (passwdChanged) writeAtomic(passwdPath, newPasswd);
    if (aclChanged) writeAtomic(aclPath, newAcl);

    this.logger?.infoSync('MQTT file auth updated', {
      component: LogComponents.configManager,
      operation: 'reconcileMqttFileAuth',
      users: users.length,
      acls: acls.length,
      passwdChanged,
      aclChanged,
    });

    await this.signalMosquittoReload(options);

    return { changed: true, users: users.length, acls: acls.length };
  }

  /**
   * Send SIGHUP to the mosquitto container so it reloads passwd and ACL files
   * without restarting or dropping existing connections.
   */
  private async signalMosquittoReload(options: FileAuthOptions): Promise<void> {
    if (!options.dockerManager || !options.containerName) return;

    try {
      const container = await options.dockerManager.findContainerByName(
        options.containerName
      );
      if (!container) {
        this.logger?.warnSync(`Mosquitto container '${options.containerName}' not found — skipping SIGHUP`, {
          component: LogComponents.configManager,
          operation: 'signalMosquittoReload',
        });
        return;
      }
      await container.kill({ signal: 'SIGHUP' });
      this.logger?.debugSync(`Sent SIGHUP to '${options.containerName}' — broker reloading auth files`, {
        component: LogComponents.configManager,
        operation: 'signalMosquittoReload',
      });
    } catch (err) {
      // Non-fatal: broker may not be running (systemd mode, cold start, etc.)
      this.logger?.warnSync(`Failed to send SIGHUP to mosquitto: ${(err as Error).message}`, {
        component: LogComponents.configManager,
        operation: 'signalMosquittoReload',
      });
    }
  }
}

// ----- auth dir resolution --------------------------------------------------

/**
 * Resolve the directory where mosquitto auth files should be written.
 *
 * Priority:
 *   1. MQTT_AUTH_DIR env var (explicit override)
 *   2. Docker mode  → /app/data/mosquitto-auth  (bind-mounted into broker container)
 *   3. Local dev    → <workspace>/mosquitto-agent/auth
 */
export function resolveMosquittoAuthDir(): string {
  if (process.env.MQTT_AUTH_DIR) return process.env.MQTT_AUTH_DIR;
  if (process.env.DEPLOYMENT_TYPE === 'docker') return '/app/data/mosquitto-auth';
  // Local dev: resolve relative to the module's location (agent/src/mqtt/ → workspace root)
  return path.resolve(__dirname, '../../../mosquitto-agent/auth');
}
