import { client } from './client'
import type { DiscoveredDevice, DiscoveryRule, DiscoveryRuleFormData } from '@/types'

export interface DiscoveryOptions {
  protocols?: string[]
  validate?: boolean
  forceRun?: boolean
  overrides?: Record<string, Record<string, unknown>>
}

export const discoveryApi = {
  run(options: DiscoveryOptions = {}): Promise<DiscoveredDevice[]> {
    return client
      .post<{ devices: DiscoveredDevice[] }>('/v1/discover', options, { timeout: 60_000 })
      .then((r) => r.data.devices)
  },
}

const RULES_BASE = '/v1/discovery-rules'

export const discoveryRulesApi = {
  getAll(): Promise<DiscoveryRule[]> {
    return client.get<{ rules: DiscoveryRule[] }>(RULES_BASE).then((r) => r.data.rules)
  },

  create(data: DiscoveryRuleFormData): Promise<DiscoveryRule> {
    return client.post<{ rule: DiscoveryRule }>(RULES_BASE, data).then((r) => r.data.rule)
  },

  update(uuid: string, data: Partial<DiscoveryRuleFormData>): Promise<DiscoveryRule> {
    return client.patch<{ rule: DiscoveryRule }>(`${RULES_BASE}/${uuid}`, data).then((r) => r.data.rule)
  },

  remove(uuid: string): Promise<void> {
    return client.delete(`${RULES_BASE}/${uuid}`).then(() => undefined)
  },

  run(uuid: string): Promise<DiscoveryRule> {
    return client.post<{ rule: DiscoveryRule }>(`${RULES_BASE}/${uuid}/run`, {}, { timeout: 120_000 }).then((r) => r.data.rule)
  },
}
