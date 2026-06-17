import { client } from './client'
import type { AgentSettings } from '@/types'

export const settingsApi = {
  get(): Promise<AgentSettings> {
    return client.get<{ settings: AgentSettings }>('/v1/settings').then((r) => r.data.settings)
  },

  update(patch: Omit<AgentSettings, 'agent'>): Promise<AgentSettings> {
    return client
      .patch<{ settings: AgentSettings }>('/v1/settings', patch)
      .then((r) => r.data.settings)
  },

  provision(body: {
    provisioningApiKey: string
    deviceName?: string
    apiEndpoint?: string
  }): Promise<{ uuid: string; deviceName: string; provisioned: boolean; mqttBrokerUrl?: string }> {
    return client
      .post<{ success: boolean; device: { uuid: string; deviceName: string; provisioned: boolean; mqttBrokerUrl?: string } }>('/v1/provision', body)
      .then((r) => r.data.device)
  },
}
