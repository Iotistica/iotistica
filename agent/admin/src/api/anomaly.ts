import { client } from './client'
import type {
  AnomalyAlert,
  AnomalyConfig,
  AnomalyStats,
  AnomalyBaseline,
  EdgeAnomalyEvent,
  EdgeAnomalyIncident,
  EdgeAnomalyAlert,
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

  clearBaselines(): Promise<{ deleted: number }> {
    return client.delete<{ deleted: number }>(`${BASE}/baselines`).then((r) => r.data)
  },

  // ── Edge tracking ────────────────────────────────────────────────────────────

  getEdgeEvents(params?: { severity?: string; limit?: number; offset?: number }): Promise<{ events: EdgeAnomalyEvent[]; total: number }> {
    return client.get<{ events: EdgeAnomalyEvent[]; total: number }>('/v1/anomaly-events', { params }).then((r) => r.data)
  },

  getEdgeIncidents(params?: { status?: string; limit?: number; offset?: number }): Promise<{ incidents: EdgeAnomalyIncident[]; total: number }> {
    return client.get<{ incidents: EdgeAnomalyIncident[]; total: number }>('/v1/anomaly-incidents', { params }).then((r) => r.data)
  },

  getEdgeIncidentStats(): Promise<{ open: number; active: number; resolved: number; total: number }> {
    return client.get<{ open: number; active: number; resolved: number; total: number }>('/v1/anomaly-incidents/stats').then((r) => r.data)
  },

  resolveIncident(incidentId: string, notes?: string): Promise<void> {
    return client.patch(`/v1/anomaly-incidents/${incidentId}/resolve`, { notes }).then(() => undefined)
  },

  getEdgeAlerts(params?: { limit?: number; offset?: number }): Promise<{ alerts: EdgeAnomalyAlert[]; total: number }> {
    return client.get<{ alerts: EdgeAnomalyAlert[]; total: number }>('/v1/anomaly-alerts', { params }).then((r) => r.data)
  },

  getMetrics(): Promise<
    Array<{
      name: string
      score?: number
      deviceState?: string
      unit?: string
      configured: boolean
      endpointName?: string
    }>
  > {
    return client
      .get<{
        metrics: Array<{
          name: string
          score?: number
          deviceState?: string
          unit?: string
          configured: boolean
          endpointName?: string
        }>
      }>(`${BASE}/metrics`)
      .then((r) => r.data.metrics)
  },
}
