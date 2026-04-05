import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-publish-replay-'));
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function waitFor(assertion: () => void, timeoutMs = 5000, intervalMs = 25): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while ((Date.now() - startedAt) < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Condition not met within ${timeoutMs}ms`);
}

function decodeMsgId(payload: string | Buffer): string | undefined {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
  const parsed = JSON.parse(text) as { msgId?: string };
  return parsed.msgId;
}

class ControlledMqttConnection extends EventEmitter {
  public connected = false;
  public failNextPublishWith?: Error;
  public readonly publishAttempts: Array<{ topic: string; msgId?: string }> = [];

  constructor(private readonly msgIdGenerator: { generate: () => string }) {
    super();
  }

  isConnected(): boolean {
    return this.connected;
  }

  setConnected(connected: boolean): void {
    const wasConnected = this.connected;
    this.connected = connected;

    if (!wasConnected && connected) {
      this.emit('connect');
    }
  }

  getMessageIdGenerator(): { generate: () => string } {
    return this.msgIdGenerator;
  }

  async publish(topic: string, payload: string | Buffer): Promise<void> {
    this.publishAttempts.push({
      topic,
      msgId: decodeMsgId(payload),
    });

    if (this.failNextPublishWith) {
      const error = this.failNextPublishWith;
      this.failNextPublishWith = undefined;
      throw error;
    }
  }
}

describe('PublishManager durable replay integration', () => {
  const originalDatabasePath = process.env.DATABASE_PATH;
  const originalBusyTimeout = process.env.SQLITE_BUSY_TIMEOUT_MS;

  let tempDir: string;
  let activeBufferSync: { stop: () => void } | undefined;

  const loadModule = <T>(modulePath: string): T => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(modulePath) as T;
  };

  afterEach(() => {
    const sqlite = loadModule<typeof import('../../src/db/sqlite')>('../../src/db/sqlite');
    const topics = loadModule<typeof import('../../src/mqtt/topics')>('../../src/mqtt/topics');

    topics.resetTenantIdCache();
    sqlite.closeDatabase();

    activeBufferSync?.stop();
    activeBufferSync = undefined;

    if (originalDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = originalDatabasePath;
    }

    if (originalBusyTimeout === undefined) {
      delete process.env.SQLITE_BUSY_TIMEOUT_MS;
    } else {
      process.env.SQLITE_BUSY_TIMEOUT_MS = originalBusyTimeout;
    }

    if (tempDir) {
      rmDir(tempDir);
    }

    jest.resetModules();
  });

  it('replays the same msgId after a publish timeout and reconnect flush', async () => {
    tempDir = makeTempDir();
    process.env.DATABASE_PATH = path.join(tempDir, 'agent.sqlite');
    process.env.SQLITE_BUSY_TIMEOUT_MS = '100';

    jest.resetModules();

    const sqlite = loadModule<typeof import('../../src/db/sqlite')>('../../src/db/sqlite');
    const migrationHelpers = loadModule<typeof import('../../src/db/migration-helpers')>('../../src/db/migration-helpers');
    sqlite.getDatabase().exec(migrationHelpers.loadTemplateSql());

    const { PublishManager } = loadModule<typeof import('../../src/features/publish/manager')>('../../src/features/publish/manager');
    const { MessageBufferSync } = loadModule<typeof import('../../src/mqtt/buffer')>('../../src/mqtt/buffer');
    const { MessageIdGenerator } = loadModule<typeof import('../../src/mqtt/utils')>('../../src/mqtt/utils');
    const { MessageBufferModel } = loadModule<typeof import('../../src/db/models/buffer.model')>('../../src/db/models/buffer.model');
    const { agentTopic, setTenantId } = loadModule<typeof import('../../src/mqtt/topics')>('../../src/mqtt/topics');

    setTenantId('tenant-test-001');

    const mqttConnection = new ControlledMqttConnection(new MessageIdGenerator('device-test-001'));
    mqttConnection.setConnected(true);
    mqttConnection.failNextPublishWith = new Error('Publish timeout waiting for PUBACK');

    const manager = new PublishManager(
      {
        name: 'test-endpoint',
        enabled: true,
        addr: '127.0.0.1:1234',
        addrPollSec: 10,
        publishInterval: 1000,
        bufferTimeMs: 0,
        bufferSize: 0,
        bufferCapacity: 1024 * 1024,
        eomDelimiter: '\n',
        mqttTopic: 'telemetry',
      },
      mqttConnection as any,
      undefined,
      'device-test-001',
    );

    const inputMessage = { temperature: 21.5, quality: 'good' };
    const built = (manager as any).buildPayload('test-endpoint', [inputMessage]) as {
      data: { sensor: string; timestamp: string; messages: any[]; msgId: string };
      baselineSize: number;
    };
    const topic = agentTopic('device-test-001', 'endpoints', 'telemetry');
    const batchBytes = Buffer.byteLength(JSON.stringify(inputMessage), 'utf8');

    await (manager as any).publishOnline(
      topic,
      built.data,
      built.baselineSize,
      1,
      batchBytes,
      built.data.messages,
      'test-endpoint',
    );

    expect(mqttConnection.publishAttempts).toHaveLength(1);
    expect(MessageBufferModel.getStats().current_count).toBe(1);

    const firstAttempt = mqttConnection.publishAttempts[0];
    expect(firstAttempt.topic).toBe(topic);
    expect(firstAttempt.msgId).toBeTruthy();

    mqttConnection.setConnected(false);

    activeBufferSync = new MessageBufferSync(mqttConnection as any, undefined, {
      flushBatchSize: 10,
      flushIntervalMs: 25,
      cleanupIntervalMs: 60_000,
      maxRetries: 3,
      maxFlushPerCycle: 10,
    });

    await activeBufferSync.start();
    mqttConnection.setConnected(true);

    await waitFor(() => {
      expect(mqttConnection.publishAttempts).toHaveLength(2);
      expect(MessageBufferModel.getStats().current_count).toBe(0);
    });

    const replayAttempt = mqttConnection.publishAttempts[1];
    expect(replayAttempt.topic).toBe(firstAttempt.topic);
    expect(replayAttempt.msgId).toBe(firstAttempt.msgId);

    activeBufferSync.stop();
    activeBufferSync = undefined;
  });
});