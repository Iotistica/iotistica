import { client } from './client'
import type { Destination, DestinationFormData } from '@/types'

const BASE = '/v1/publish/destinations'

export const destinationsApi = {
  getAll(): Promise<Destination[]> {
    return client.get<{ publishers: Destination[] }>(BASE).then((r) => r.data.publishers)
  },

  create(data: DestinationFormData): Promise<Destination> {
    return client.post<{ publisher: Destination }>(BASE, data).then((r) => r.data.publisher)
  },

  update(id: number, data: Partial<DestinationFormData>): Promise<Destination> {
    return client.patch<{ publisher: Destination }>(`${BASE}/${id}`, data).then((r) => r.data.publisher)
  },

  delete(id: number): Promise<void> {
    return client.delete(`${BASE}/${id}`).then(() => undefined)
  },
}
