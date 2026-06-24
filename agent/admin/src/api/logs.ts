import { client } from './client'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogSourceType = 'system' | 'container' | 'manager'

export interface LogMessage {
  id?: string
  message: string
  timestamp: number
  level: LogLevel
  source: { type: LogSourceType; name: string }
  serviceId?: number
  serviceName?: string
  containerId?: string
  isStdErr?: boolean
  isSystem?: boolean
}

export interface LogsFilter {
  level?: LogLevel
  source?: LogSourceType
  since?: number
  limit?: number
}

export const logsApi = {
  getLogs(filter?: LogsFilter): Promise<{ logs: LogMessage[]; total: number }> {
    const params: Record<string, string> = {}
    if (filter?.level) params.level = filter.level
    if (filter?.source) params.source = filter.source
    if (filter?.since) params.since = String(filter.since)
    if (filter?.limit) params.limit = String(filter.limit)
    return client.get<{ logs: LogMessage[]; total: number }>('/v1/logs', { params }).then((r) => r.data)
  },
}
