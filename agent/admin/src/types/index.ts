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
