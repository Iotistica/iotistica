import { EventEmitter } from "events";
import manifest from "./manifest.json" with { type: "json" };

class SampleProtocolAdapter extends EventEmitter {
  constructor(logger, options = {}) {
    super();
    this.logger = logger;
    this.options = options;
    this.running = false;
  }

  async start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.logger.info("Sample external adapter started");
    this.emit("started");

    // Emit a synthetic heartbeat datapoint so users can verify plugin wiring.
    this.emit("data", [
      {
        deviceName: this.options.deviceName || "sample_device",
        metric: "heartbeat",
        value: 1,
        unit: "count",
        timestamp: new Date().toISOString(),
        quality: "GOOD",
        protocol: manifest.protocol,
      },
    ]);
  }

  async stop() {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.emit("stopped");
    this.logger.info("Sample external adapter stopped");
  }

  isRunning() {
    return this.running;
  }

  getDeviceStatuses() {
    return [
      {
        deviceName: this.options.deviceName || "sample_device",
        connected: this.running,
        lastPoll: this.running ? new Date() : null,
        lastSeen: this.running ? new Date() : null,
        errorCount: 0,
        lastError: null,
        responseTimeMs: 0,
        pollSuccessRate: this.running ? 1 : 0,
        registersUpdated: this.running ? 1 : 0,
        communicationQuality: this.running ? "good" : "offline",
      },
    ];
  }
}

export function createPlugin(context) {
  // Version guard: require same major API version.
  const runtimeMajor = String(context.apiVersion || "").split(".")[0];
  const pluginMajor = String(manifest.apiVersion || "").split(".")[0];
  if (!runtimeMajor || runtimeMajor !== pluginMajor) {
    throw new Error(
      `Incompatible plugin API version. Runtime=${context.apiVersion}, Plugin=${manifest.apiVersion}`,
    );
  }

  return {
    manifest,
    createStarter(manager, options = {}) {
      return async () => {
        const adapter = new SampleProtocolAdapter(context.logger, options);
        await manager.attachAdapter(manifest.protocol, adapter, new Map());
      };
    },
  };
}
