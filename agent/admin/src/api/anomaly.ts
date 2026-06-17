import { client } from './client'
import type {
  AnomalyAlert,
  AnomalyConfig,
  AnomalyStats,
  AnomalyBaseline,
} from '@/types'

const BASE = '/v1/anomaly'

export const anomalyApi = {
  getConfig(): Promise<AnomalyConfig> {
    return client.get<{ config: AnomalyConfig }>(`${BASE}/config`).then((r) => r.data.config)
  },

  updateConfig(patch: Partial<AnomalyConfig>): Promise<AnomalyConfig> {
    return client
      .patch<{ config: AnomalyConfig }>(`${BASE}/config`, patch)
      .then((r) => r.data.config)
  },

  getAlerts(params?: {
    since?: number
    severity?: string
    metric?: string
    limit?: number
  }): Promise<{ alerts: AnomalyAlert[]; total: number }> {
    return client
      .get<{ alerts: AnomalyAlert[]; total: number }>(`${BASE}/alerts`, { params })
      .then((r) => r.data)
  },

  clearAlerts(): Promise<void> {
    return client.delete(`${BASE}/alerts`).then(() => undefined)
  },

  getStats(): Promise<{
    stats: AnomalyStats
    scores: Record<string, number>
    predictions: Record<string, unknown> | null
  }> {
    return client.get(`${BASE}/stats`).then((r) => r.data)
  },

  getBaselines(params?: {
    metric?: string
    limit?: number
  }): Promise<{ baselines: AnomalyBaseline[]; total: number }> {
    return client
      .get<{ baselines: AnomalyBaseline[]; total: number }>(`${BASE}/baselines`, { params })
      .then((r) => r.data)
  },

  saveBaselines(): Promise<void> {
    return client.post(`${BASE}/save-baselines`).then(() => undefined)
  },

  getMetrics(): Promise<
    Array<{
      name: string
      source: 'live' | 'system' | 'endpoint'
      score?: number
      deviceState?: string
      endpointName?: string
      unit?: string
      configured: boolean
    }>
  > {
    return client
      .get<{
        metrics: Array<{
          name: string
          source: 'live' | 'system' | 'endpoint'
          score?: number
          deviceState?: string
          endpointName?: string
          unit?: string
          configured: boolean
        }>
      }>(`${BASE}/metrics`)
      .then((r) => r.data.metrics)
  },
}
