// Mirrors agent/src/db/models/publish-destinations.model.ts
export type DestinationType = 'iotistica' | 'azure' | 'aws' | 'gcp' | 'mqtt' | string

export interface Destination {
  id: number
  name: string
  type: DestinationType
  config_json: Record<string, unknown> | null
  enabled: boolean
  last_error: string | null
  last_error_at: string | null
  created_at: string
  updated_at: string
}

// Mirrors agent/src/db/models/publish-subscriptions.model.ts
export type PayloadFormat = 'custom' | 'tags' | 'ecp'
export type Compression = 'json' | 'msgpack' | 'json+deflate' | 'msgpack+deflate'

export interface SubscriptionRoute {
  includeMetrics?: string[]
  excludeMetrics?: string[]
  includeDevices?: string[]
  excludeDevices?: string[]
  qualities?: Array<'GOOD' | 'BAD' | 'UNCERTAIN'>
  minIntervalMs?: number
  maxPointsPerMessage?: number
  topic?: string
}

export interface Subscription {
  id: number
  publish_destination_id: number
  topics: string[]
  route_json: SubscriptionRoute | null
  payload_format: PayloadFormat
  compression: Compression | null
  enabled: boolean
  created_at: string
  updated_at: string
}

// Form shapes (omit server-generated fields)
export type DestinationFormData = Omit<Destination, 'id' | 'last_error' | 'last_error_at' | 'created_at' | 'updated_at'>
export type SubscriptionFormData = Omit<Subscription, 'id' | 'created_at' | 'updated_at'>

// Mirrors agent/src/db/models/endpoints.model.ts
export type EndpointProtocol = 'modbus' | 'opcua' | 'mqtt' | 'bacnet'

export interface Endpoint {
  uuid: string
  name: string
  protocol: EndpointProtocol | string
  enabled: boolean
  poll_interval: number
  connection: Record<string, unknown>
  data_points?: unknown[]
  metadata?: Record<string, unknown>
  created_at?: string
  updated_at?: string
  // enriched health fields from AdapterManager (may be absent)
  status?: string
  connected?: boolean
  lastError?: string | null
  lastSeen?: string | null
  responseTimeMs?: number | null
}

export type DiscoveryRuleStatus = 'idle' | 'running' | 'ok' | 'error'

export interface DiscoveryRuleResult {
  found: number
  saved: number
  skipped: number
  error?: string
}

export interface DiscoveryRule {
  uuid: string
  name: string
  enabled: boolean
  protocol: string
  interval_seconds: number
  target_json: Record<string, unknown> | null
  params_json: Record<string, unknown> | null
  auto_enable: boolean
  status: DiscoveryRuleStatus
  last_run_at: string | null
  next_run_at: string | null
  last_result_json: DiscoveryRuleResult | null
  created_at?: string
  updated_at?: string
}

export interface DiscoveryRuleFormData {
  name: string
  protocol: string
  interval_seconds: number
  enabled: boolean
  auto_enable: boolean
  target_json: Record<string, unknown> | null
  params_json: Record<string, unknown> | null
}

export interface EndpointCreateData {
  name: string
  protocol: string
  connection: Record<string, unknown>
  poll_interval?: number
  enabled?: boolean
  data_points?: unknown[]
  metadata?: Record<string, unknown>
  fingerprint?: string
}

export interface EndpointUpdateData {
  enabled?: boolean
  poll_interval?: number
}

// ── Anomaly detection ────────────────────────────────────────────────────────

export type AnomalySeverity = 'info' | 'warning' | 'critical'
export type DetectionMethod =
  | 'zscore'
  | 'mad'
  | 'iqr'
  | 'expected_range'
  | 'rate_change'
  | 'ewma'
  | 'fusion'
  | 'simulation'
export type SeasonalityPattern = 'none' | 'day-night' | 'hourly' | 'weekly'

export interface AnomalyAlert {
  id: string
  severity: AnomalySeverity
  metric: string
  deviceState?: string
  value: number
  expectedRange: [number, number]
  deviation: number
  detectionMethod: DetectionMethod
  timestamp: number
  confidence: number
  message: string
  fingerprint: string
  count: number
  cooldownSec: number
  firstSeen: number
  consecutiveCount: number
}

export interface AnomalyMetricConfig {
  name: string
  deviceName?: string
  enabled: boolean
  methods: DetectionMethod[]
  threshold: number
  windowSize: number
  expectedRange?: [number, number]
  minConfidence?: number
  cooldownMs?: number
  seasonality?: SeasonalityPattern
}

export interface AnomalyConfig {
  enabled?: boolean
  sensitivity: number
  metrics: AnomalyMetricConfig[]
  alerts: {
    mqtt: boolean
    cloud: boolean
    minConfidence: number
    cooldownMs: number
    maxQueueSize: number
  }
  storage?: {
    retention: number
    minSamples?: number
    baselineMaxAgeDays?: number
  }
  warmupPeriodMs?: number
}

export interface AnomalyStats {
  enabled: boolean
  metricsTracked: number
  stateBucketsTracked: number
  alertQueueSize: number
  criticalAlerts: number
  warningAlerts: number
  infoAlerts: number
}

export interface AnomalyBaseline {
  metric: string
  device_id: string
  device_state: string
  time_slot: number
  mean: number | null
  std_dev: number | null
  median: number | null
  mad: number | null
  sample_count: number
  calculated_at: number
}

export interface DiscoveryRun {
  id: number
  rule_uuid: string
  rule_name: string
  protocol: string
  trigger: 'scheduled' | 'manual'
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  status: 'running' | 'ok' | 'error'
  found: number
  saved: number
  skipped: number
  error: string | null
  created_at: string
}

export interface DiscoveredDevice {
  protocol: string
  name: string
  fingerprint: string
  connection: Record<string, unknown>
  dataPoints: unknown[]
  confidence: 'low' | 'medium' | 'high'
  discoveredAt: string
  validated: boolean
  metadata?: Record<string, unknown>
}

// ── Agent Settings ────────────────────────────────────────────────────────────

export interface AgentSettingsLogging {
  level?: 'debug' | 'info' | 'warn' | 'error'
  maxLogs?: number
  logMaxAge?: number
  maxLogFileSize?: number
  enableCompression?: boolean
  enableRemoteLogging?: boolean
  enableFilePersistence?: boolean
}

export interface AgentSettingsFeatures {
  enableDeviceJobs?: boolean
  enableAnomalyDetection?: boolean
  enableDeviceRemoteAccess?: boolean
  enableDevicePublish?: boolean
}

export interface AgentSettingsIntervals {
  agent?: {
    reportIntervalMs?: number
    metricsIntervalMs?: number
    reconciliationIntervalMs?: number
    targetStatePollIntervalMs?: number
  }
  discovery?: {
    fullIntervalMs?: number
    lightIntervalMs?: number
  }
}

export interface AgentSettingsRuntime {
  memory?: {
    thresholdMb?: number
    checkIntervalMs?: number
  }
}

export interface AgentSettingsInfo {
  uuid: string | null
  name: string | null
  version: string | null
  provisioned: boolean
  apiEndpoint?: string | null
  mqttBrokerUrl?: string | null
}

export interface AgentSettings {
  agent?: AgentSettingsInfo
  logging?: AgentSettingsLogging
  features?: AgentSettingsFeatures
  intervals?: AgentSettingsIntervals
  runtime?: AgentSettingsRuntime
  anomalyDetection?: Record<string, unknown>
}
