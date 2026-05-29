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
