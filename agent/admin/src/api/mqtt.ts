import { client } from './client'

export interface TopicNode {
  name: string
  fullTopic: string
  count: number
  bytes: number
  lastMessage: string | null
  lastMessageAt: number | null
  messageType: 'json' | 'string' | 'binary'
  retain: boolean
  qos: number
  children: Record<string, TopicNode>
}

export interface BrokerMetrics {
  connected: boolean
  version: string
  clients: { connected: number; total: number; maximum: number }
  messages: { received: number; sent: number; stored: number }
  bytes: { received: number; sent: number }
  subscriptions: number
  retainedMessages: number
  uptime: number
  messageRateIn: number
  messageRateOut: number
  throughputIn: number
  throughputOut: number
}

export interface BrokerStatus {
  connected: boolean
  topicCount: number
  messageCount: number
  monitoringTopics: string[]
}

export interface FlatTopic {
  name: string
  fullTopic: string
  count: number
  bytes: number
  lastMessage: string | null
  lastMessageAt: number | null
  messageType: 'json' | 'string' | 'binary'
  retain: boolean
  qos: number
}

export const mqttApi = {
  getStatus(): Promise<BrokerStatus> {
    return client.get<BrokerStatus>('/v1/mqtt/broker/status').then(r => r.data)
  },
  getMetrics(): Promise<BrokerMetrics> {
    return client.get<BrokerMetrics>('/v1/mqtt/broker/metrics').then(r => r.data)
  },
  getTopicTree(): Promise<Record<string, TopicNode>> {
    return client.get<Record<string, TopicNode>>('/v1/mqtt/broker/topic-tree').then(r => r.data)
  },
  getTopics(): Promise<FlatTopic[]> {
    return client.get<FlatTopic[]>('/v1/mqtt/topics').then(r => r.data)
  },
}
