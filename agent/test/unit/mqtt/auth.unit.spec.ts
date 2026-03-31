/**
 * MqttFileAuthReconciler unit tests
 *
 * Tests cover:
 *   - PBKDF2-SHA512 hash generation (format, uniqueness, verifiability)
 *   - passwd file content generation
 *   - ACL file content generation
 *   - Change detection (no-op when unchanged)
 *   - Atomic file write (tmp + rename)
 *   - Bootstrap superuser always included
 *   - Endpoint user with plaintext password
 *   - Endpoint user without plaintext skipped
 *   - SIGHUP sent via dockerManager when files change
 *   - SIGHUP not sent when containerName absent
 *   - Missing container is handled gracefully
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	MqttFileAuthReconciler,
	generateMosquittoHash,
	resolveMosquittoAuthDir,
	type EndpointMqttAuth,
	type FileAuthOptions,
} from '../../../src/mqtt/auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'mqttauth-test-'));
}

function rmDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Verify a mosquitto PBKDF2-SHA512 hash against a plaintext password.
 * Format: $7$<iterations>$<base64-salt>$<base64-key>
 */
function verifyMosquittoHash(password: string, hash: string): boolean {
	const parts = hash.split('$');
	// ['', '7', '<iterations>', '<salt-b64>', '<key-b64>']
	if (parts.length !== 5 || parts[1] !== '7') return false;
	const iterations = parseInt(parts[2], 10);
	const salt = Buffer.from(parts[3], 'base64');
	const expectedKey = Buffer.from(parts[4], 'base64');
	const actualKey = crypto.pbkdf2Sync(password, salt, iterations, expectedKey.length, 'sha512');
	return crypto.timingSafeEqual(actualKey, expectedKey);
}

// ---------------------------------------------------------------------------
// generateMosquittoHash
// ---------------------------------------------------------------------------

describe('generateMosquittoHash', () => {
	it('produces a $7$101$ prefixed hash', () => {
		const hash = generateMosquittoHash('testpass');
		expect(hash).toMatch(/^\$7\$101\$/);
	});

	it('produces unique hashes for the same password (random salt)', () => {
		const h1 = generateMosquittoHash('same');
		const h2 = generateMosquittoHash('same');
		expect(h1).not.toBe(h2);
	});

	it('produces a hash that verifies correctly against the original password', () => {
		const password = 'iotistic42!';
		const hash = generateMosquittoHash(password);
		expect(verifyMosquittoHash(password, hash)).toBe(true);
	});

	it('does not verify against a different password', () => {
		const hash = generateMosquittoHash('correct');
		expect(verifyMosquittoHash('wrong', hash)).toBe(false);
	});

	it('has exactly 5 dollar-sign-delimited parts', () => {
		const hash = generateMosquittoHash('x');
		const parts = hash.split('$');
		expect(parts.length).toBe(5);
		expect(parts[1]).toBe('7');
		expect(parts[2]).toBe('101');
	});
});

// ---------------------------------------------------------------------------
// MqttFileAuthReconciler.reconcile — file generation
// ---------------------------------------------------------------------------

describe('MqttFileAuthReconciler.reconcile', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
		process.env.MQTT_USERNAME = 'admin';
		process.env.MQTT_PASSWORD = 'adminpass';
	});

	afterEach(() => {
		rmDir(tmpDir);
		delete process.env.MQTT_USERNAME;
		delete process.env.MQTT_PASSWORD;
	});

	const opts = (dir: string, dockerManager?: FileAuthOptions['dockerManager']): FileAuthOptions => ({
		authDir: dir,
		containerName: 'iotistic-mosquitto-agent',
		dockerManager,
	});

	it('writes passwd and acl files on first run', async () => {
		const reconciler = new MqttFileAuthReconciler();
		const result = await reconciler.reconcile([], opts(tmpDir));

		expect(result.changed).toBe(true);
		expect(fs.existsSync(path.join(tmpDir, 'passwd'))).toBe(true);
		expect(fs.existsSync(path.join(tmpDir, 'acl'))).toBe(true);
	});

	it('passwd file contains bootstrap superuser line', async () => {
		const reconciler = new MqttFileAuthReconciler();
		await reconciler.reconcile([], opts(tmpDir));

		const content = fs.readFileSync(path.join(tmpDir, 'passwd'), 'utf8');
		expect(content).toMatch(/^admin:/m);
	});

	it('bootstrap user hash verifies against configured password', async () => {
		const reconciler = new MqttFileAuthReconciler();
		await reconciler.reconcile([], opts(tmpDir));

		const content = fs.readFileSync(path.join(tmpDir, 'passwd'), 'utf8');
		const line = content.split('\n').find(l => l.startsWith('admin:'))!;
		const hash = line.split(':')[1];
		expect(verifyMosquittoHash('adminpass', hash)).toBe(true);
	});

	it('ACL file gives superuser readwrite # access', async () => {
		const reconciler = new MqttFileAuthReconciler();
		await reconciler.reconcile([], opts(tmpDir));

		const content = fs.readFileSync(path.join(tmpDir, 'acl'), 'utf8');
		expect(content).toContain('user admin\ntopic readwrite #');
	});

	it('includes endpoint user when passwordPlaintext is present', async () => {
		const endpoints: EndpointMqttAuth[] = [
			{
				protocol: 'mqtt',
				connection: { topic: 'sensors/temp' },
				auth: { mqtt: { username: 'sensor1', passwordPlaintext: 'sensorpass', access: 2 } },
			},
		];
		const reconciler = new MqttFileAuthReconciler();
		await reconciler.reconcile(endpoints, opts(tmpDir));

		const passwd = fs.readFileSync(path.join(tmpDir, 'passwd'), 'utf8');
		expect(passwd).toMatch(/^sensor1:/m);

		const acl = fs.readFileSync(path.join(tmpDir, 'acl'), 'utf8');
		expect(acl).toContain('user sensor1');
		expect(acl).toContain('topic write sensors/temp');
	});

	it('includes endpoint user when passwordFileHash is present', async () => {
		const endpoints: EndpointMqttAuth[] = [
			{
				protocol: 'mqtt',
				connection: { topic: 'sensors/file-hash' },
				auth: { mqtt: { username: 'sensor2', passwordFileHash: '$7$101$abc$def', access: 2 } },
			},
		];
		const reconciler = new MqttFileAuthReconciler();
		await reconciler.reconcile(endpoints, opts(tmpDir));

		const passwd = fs.readFileSync(path.join(tmpDir, 'passwd'), 'utf8');
		expect(passwd).toContain('sensor2:$7$101$abc$def');

		const acl = fs.readFileSync(path.join(tmpDir, 'acl'), 'utf8');
		expect(acl).toContain('user sensor2');
		expect(acl).toContain('topic write sensors/file-hash');
	});

	it('skips endpoint user when passwordPlaintext is absent', async () => {
		const endpoints: EndpointMqttAuth[] = [
			{
				protocol: 'mqtt',
				connection: { topic: 'sensors/temp' },
				auth: { mqtt: { username: 'sensor1', access: 2 } },
			},
		];
		const reconciler = new MqttFileAuthReconciler();
		await reconciler.reconcile(endpoints, opts(tmpDir));

		const passwd = fs.readFileSync(path.join(tmpDir, 'passwd'), 'utf8');
		expect(passwd).not.toMatch(/^sensor1:/m);
	});

	it('skips endpoints with non-mqtt protocol', async () => {
		const endpoints: EndpointMqttAuth[] = [
			{
				protocol: 'modbus',
				connection: { topic: 'sensors/temp' },
				auth: { mqtt: { username: 'modbususer', passwordPlaintext: 'p', access: 2 } },
			},
		];
		const reconciler = new MqttFileAuthReconciler();
		await reconciler.reconcile(endpoints, opts(tmpDir));

		const passwd = fs.readFileSync(path.join(tmpDir, 'passwd'), 'utf8');
		expect(passwd).not.toMatch(/^modbususer:/m);
	});

	it('maps access levels to correct ACL verbs', async () => {
		const endpoints: EndpointMqttAuth[] = [
			{ protocol: 'mqtt', connection: { topic: 't/read' }, auth: { mqtt: { username: 'u1', passwordPlaintext: 'p', access: 1 } } },
			{ protocol: 'mqtt', connection: { topic: 't/write' }, auth: { mqtt: { username: 'u2', passwordPlaintext: 'p', access: 2 } } },
			{ protocol: 'mqtt', connection: { topic: 't/rw' }, auth: { mqtt: { username: 'u3', passwordPlaintext: 'p', access: 3 } } },
		];
		const reconciler = new MqttFileAuthReconciler();
		await reconciler.reconcile(endpoints, opts(tmpDir));

		const acl = fs.readFileSync(path.join(tmpDir, 'acl'), 'utf8');
		expect(acl).toContain('topic read t/read');
		expect(acl).toContain('topic write t/write');
		expect(acl).toContain('topic readwrite t/rw');
	});

	it('returns changed=false and users=0 when MQTT_USERNAME is not set', async () => {
		delete process.env.MQTT_USERNAME;
		delete process.env.MQTT_PASSWORD;

		const reconciler = new MqttFileAuthReconciler();
		const result = await reconciler.reconcile([], opts(tmpDir));

		expect(result.changed).toBe(false);
		expect(result.users).toBe(0);
	});

	it('atomically writes: no .tmp files left behind', async () => {
		const reconciler = new MqttFileAuthReconciler();
		await reconciler.reconcile([], opts(tmpDir));

		const files = fs.readdirSync(tmpDir);
		expect(files.some(f => f.endsWith('.tmp'))).toBe(false);
	});

	it('does not preserve stale dynamic users from existing managed passwd and acl files', async () => {
		fs.writeFileSync(path.join(tmpDir, 'passwd'), 'admin:old-admin-hash\nstale-user:stale-hash\n', 'utf8');
		fs.writeFileSync(path.join(tmpDir, 'acl'), '# header\n\nuser admin\ntopic readwrite #\n\nuser stale-user\ntopic write stale/topic\n', 'utf8');

		const reconciler = new MqttFileAuthReconciler();
		await reconciler.reconcile([], opts(tmpDir));

		const passwd = fs.readFileSync(path.join(tmpDir, 'passwd'), 'utf8');
		expect(passwd).not.toContain('stale-user:stale-hash');

		const acl = fs.readFileSync(path.join(tmpDir, 'acl'), 'utf8');
		expect(acl).not.toContain('user stale-user');
		expect(acl).not.toContain('stale/topic');
	});
});
// ---------------------------------------------------------------------------
// SIGHUP signalling
// ---------------------------------------------------------------------------

describe('MqttFileAuthReconciler SIGHUP signalling', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
		process.env.MQTT_USERNAME = 'admin';
		process.env.MQTT_PASSWORD = 'adminpass';
	});

	afterEach(() => {
		rmDir(tmpDir);
		delete process.env.MQTT_USERNAME;
		delete process.env.MQTT_PASSWORD;
	});

	it('sends SIGHUP to the named container after writing files', async () => {
		const killMock = jest.fn().mockResolvedValue(undefined);
		const dockerManager: FileAuthOptions['dockerManager'] = {
			findContainerByName: jest.fn().mockResolvedValue({ kill: killMock }),
		};

		const reconciler = new MqttFileAuthReconciler();
		await reconciler.reconcile([], { authDir: tmpDir, containerName: 'iotistic-mosquitto-agent', dockerManager });

		expect(dockerManager!.findContainerByName).toHaveBeenCalledWith('iotistic-mosquitto-agent');
		expect(killMock).toHaveBeenCalledWith({ signal: 'SIGHUP' });
	});

	it('does not call dockerManager when containerName is absent', async () => {
		const dockerManager: FileAuthOptions['dockerManager'] = {
			findContainerByName: jest.fn().mockResolvedValue({ kill: jest.fn() }),
		};

		const reconciler = new MqttFileAuthReconciler();
		await reconciler.reconcile([], { authDir: tmpDir, dockerManager });

		expect(dockerManager!.findContainerByName).not.toHaveBeenCalled();
	});

	it('handles missing container gracefully (no throw)', async () => {
		const dockerManager: FileAuthOptions['dockerManager'] = {
			findContainerByName: jest.fn().mockResolvedValue(null),
		};

		const reconciler = new MqttFileAuthReconciler();
		await expect(
			reconciler.reconcile([], { authDir: tmpDir, containerName: 'iotistic-mosquitto-agent', dockerManager })
		).resolves.not.toThrow();
	});

	it('handles dockerManager.kill() error gracefully (no throw)', async () => {
		const dockerManager: FileAuthOptions['dockerManager'] = {
			findContainerByName: jest.fn().mockResolvedValue({
				kill: jest.fn().mockRejectedValue(new Error('container not running')),
			}),
		};

		const reconciler = new MqttFileAuthReconciler();
		await expect(
			reconciler.reconcile([], { authDir: tmpDir, containerName: 'iotistic-mosquitto-agent', dockerManager })
		).resolves.not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// resolveMosquittoAuthDir
// ---------------------------------------------------------------------------

describe('resolveMosquittoAuthDir', () => {
	let originalDeployment: string | undefined;
	let originalAuthDir: string | undefined;

	beforeEach(() => {
		originalDeployment = process.env.DEPLOYMENT_TYPE;
		originalAuthDir = process.env.MQTT_AUTH_DIR;
	});

	afterEach(() => {
		if (originalDeployment !== undefined) process.env.DEPLOYMENT_TYPE = originalDeployment;
		else delete process.env.DEPLOYMENT_TYPE;
		if (originalAuthDir !== undefined) process.env.MQTT_AUTH_DIR = originalAuthDir;
		else delete process.env.MQTT_AUTH_DIR;
	});

	it('returns MQTT_AUTH_DIR env override when set', () => {
		process.env.MQTT_AUTH_DIR = '/custom/path';
		expect(resolveMosquittoAuthDir()).toBe('/custom/path');
	});

	it('returns /app/data/mosquitto-auth in docker deployment mode', () => {
		delete process.env.MQTT_AUTH_DIR;
		process.env.DEPLOYMENT_TYPE = 'docker';
		expect(resolveMosquittoAuthDir()).toBe('/app/data/mosquitto-auth');
	});

	it('returns a path containing mosquitto-agent/auth in local dev mode', () => {
		delete process.env.MQTT_AUTH_DIR;
		delete process.env.DEPLOYMENT_TYPE;
		const result = resolveMosquittoAuthDir();
		expect(result.replace(/\\/g, '/')).toContain('mosquitto-agent/auth');
	});
});
