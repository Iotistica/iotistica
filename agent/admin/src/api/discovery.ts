import { client } from './client'
import type { DiscoveredDevice } from '@/types'

export interface DiscoveryOptions {
  protocols?: string[]
  validate?: boolean
  forceRun?: boolean
}

export const discoveryApi = {
  run(options: DiscoveryOptions = {}): Promise<DiscoveredDevice[]> {
    return client
      .post<{ devices: DiscoveredDevice[] }>('/v1/discover', options, { timeout: 60_000 })
      .then((r) => r.data.devices)
  },
}
