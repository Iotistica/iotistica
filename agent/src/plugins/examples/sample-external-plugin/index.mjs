import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * A small protocol client that follows the standard lifecycle contract.
 * One client instance should represent one logical device connection.
 */
class SampleClient {
  constructor(deviceConfig) {
    this.device = deviceConfig;
    this.connected = false;
  }

  async connect() {
    this.connected = true;
  }

  async disconnect() {
    this.connected = false;
  }

  isConnected() {
    return this.connected;
  }

  async read() {
    const timestamp = new Date().toISOString();
    return this.device.dataPoints.map((dp) => ({
      deviceName: this.device.name,
      metric: dp.name,
      value: null,
      unit: dp.unit || "",
      timestamp,
      quality: "BAD",
      qualityCode: "NOT_IMPLEMENTED",
      protocol: "sample",
    }));
  }
}

class SampleAdapter {
  constructor(devices, logger) {
    this.devices = devices || [];
    this.logger = logger;
    this.running = false;
    this.handlers = new Map();
    this.clients = new Map();
    this.pollTimer = null;
  }

  on(event, listener) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event).push(listener);
    return this;
  }

  emit(event, ...args) {
    const listeners = this.handlers.get(event) || [];
    for (const listener of listeners) {
      try {
        listener(...args);
      } catch (error) {
        this.logger.error(`Sample adapter handler failed: ${error}`);
      }
    }
  }

  isRunning() {
    return this.running;
  }

  getDeviceStatuses() {
    return this.devices.map((device) => ({
      deviceName: device.name,
      connected: this.clients.get(device.name)?.isConnected() || false,
      lastPoll: null,
      lastSeen: null,
      errorCount: 0,
      lastError: null,
      responseTimeMs: null,
      pollSuccessRate: 1,
      registersUpdated: 0,
      communicationQuality: "offline",
    }));
  }

  async start() {
    if (this.running) return;

    for (const device of this.devices) {
      const client = new SampleClient(device);
      await client.connect();
      this.clients.set(device.name, client);
      this.emit("device-connected", device.name);
    }

    this.running = true;
    this.emit("started");

    // Poll loop to show where adapters emit protocol data.
    this.pollTimer = setInterval(async () => {
      const payload = [];
      for (const [deviceName, client] of this.clients) {
        if (!client.isConnected()) continue;
        try {
          const points = await client.read();
          payload.push(...points);
        } catch (error) {
          this.emit("device-error", deviceName, error);
        }
      }

      if (payload.length > 0) {
        this.emit("data", payload);
      }
    }, 5000);
  }

  async stop() {
    if (!this.running) return;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    for (const [deviceName, client] of this.clients) {
      await client.disconnect();
      this.emit("device-disconnected", deviceName);
    }

    this.clients.clear();
    this.running = false;
    this.emit("stopped");
  }
}

function loadManifest() {
  const modulePath = fileURLToPath(import.meta.url);
  const manifestPath = path.join(path.dirname(modulePath), "manifest.json");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

export function createPlugin(context) {
  const manifest = loadManifest();

  return {
    manifest,
    createStarter: (manager, options = {}) => {
      return async () => {
        const devices = options.devices || [];
        const adapter = new SampleAdapter(devices, context.logger);
        await manager.attachAdapter(manifest.protocol, adapter, new Map());
      };
    },
  };
}
