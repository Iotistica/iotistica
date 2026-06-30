import { client } from './client'
import type { Endpoint, EndpointCreateData, EndpointUpdateData } from '@/types'

const BASE = '/v1/endpoints'

export const sourcesApi = {
  getAll(protocol?: string): Promise<Endpoint[]> {
    return client
      .get<{ endpoints: Endpoint[] }>(BASE, { params: protocol ? { protocol } : {} })
      .then((r) => r.data.endpoints)
  },

  create(data: EndpointCreateData): Promise<Endpoint> {
    return client.post<{ endpoint: Endpoint }>(BASE, data).then((r) => r.data.endpoint)
  },

  update(uuid: string, data: EndpointUpdateData): Promise<Endpoint> {
    return client.patch<{ endpoint: Endpoint }>(`${BASE}/${uuid}`, data).then((r) => r.data.endpoint)
  },

  replace(uuid: string, data: EndpointCreateData): Promise<Endpoint> {
    return client.put<{ endpoint: Endpoint }>(`${BASE}/${uuid}`, data).then((r) => r.data.endpoint)
  },

  remove(uuid: string): Promise<void> {
    return client.delete(`${BASE}/${uuid}`).then(() => undefined)
  },
}
