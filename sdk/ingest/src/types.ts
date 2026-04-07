// ─── Public configuration ─────────────────────────────────────────────────────

export interface IotisticaClientOptions {
  /** Base URL of the Iotistica API, e.g. 'https://api.iotistica.cloud' */
  apiUrl: string;

  /**
   * Provisioning key issued from the Iotistica dashboard.
   * Only needed on first run — afterwards the device API key issued during
   * registration is stored in `stateFile` and used for all subsequent calls.
   */
  provisioningKey: string;

  /** Human-readable name for this device, e.g. 'pump-controller-01' */
  deviceName: string;

  /**
   * Path to a JSON file used to persist the device UUID and API key across
   * process restarts. Defaults to './iotistica-state.json'.
   */
  stateFile?: string;

  /**
   * Maximum number of readings to buffer before an automatic flush.
   * Defaults to 100.
   */
  batchSize?: number;

  /**
   * Maximum milliseconds to wait before flushing a non-empty buffer.
   * Defaults to 5000 (5 s).
   */
  flushIntervalMs?: number;

  /**
   * Maximum number of HTTP retry attempts on transient failures.
   * Defaults to 5.
   */
  maxRetries?: number;

  /**
   * Optional callback invoked when readings cannot be delivered after all retries.
   * Receives the wire-format entries that were dropped and a reason string.
   * Useful for logging or writing to a local fallback store.
   */
  onDropped?: (entries: WireEntry[], reason: string) => void;

  /**
   * Called whenever the cloud delivers a new target state for this device.
   * Set this to receive configuration / command updates pushed from the
   * Iotistica dashboard.
   *
   * When this callback is provided the client automatically starts a
   * background polling loop against `GET /api/v1/device/:uuid/state`.
   *
   * @param state - The new target state (apps + config object).
   */
  onTargetState?: (state: TargetState) => void | Promise<void>;

  /**
   * How often (ms) to poll the cloud for target state changes.
   * Only relevant when `onTargetState` is provided.
   * Defaults to 30 000 (30 s).
   */
  targetStatePollIntervalMs?: number;
}

// ─── Domain types ─────────────────────────────────────────────────────────────

/** A single metric reading to send to the platform. */
export interface Reading {
  /** Metric name, e.g. 'temperature', 'pressure', 'voltage' */
  metric: string;
  /** Numeric value */
  value: number;
  /**
   * ISO-8601 timestamp. Defaults to `new Date().toISOString()` if omitted.
   */
  timestamp?: string;
  /** Arbitrary key-value metadata attached to this reading */
  tags?: Record<string, string | number | boolean>;
}

// ─── Internal wire format (matches DeviceDataEntry expected by the API) ────────

/** @internal */
export interface WireEntry {
  deviceUuid: string;
  deviceName: string;
  timestamp: string;
  data: Record<string, number>;
  metadata: Record<string, unknown>;
}

// ─── Target state (received from cloud) ──────────────────────────────────────

/**
 * The target state the cloud wants this device to be in.
 * Mirrors the server's `DeviceTargetState` shape.
 */
export interface TargetState {
  /** App definitions keyed by app ID */
  apps: Record<string, unknown>;
  /** Device configuration (features, endpoints, logging, etc.) */
  config: Record<string, unknown>;
  /** Monotonically incrementing version number */
  version?: number;
  /** ISO-8601 timestamp of the last update */
  updated_at?: string;
}

// ─── Persisted device identity ────────────────────────────────────────────────

/** @internal */
export interface DeviceState {
  uuid: string;
  /** The plain-text device API key generated at registration time */
  deviceApiKey: string;
  registeredAt: string;
}
