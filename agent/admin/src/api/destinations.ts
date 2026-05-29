import { client } from './client'
import type { Destination, DestinationFormData } from '@/types'

const BASE = '/v1/publish/destinations'

export const destinationsApi = {
  getAll(): Promise<Destination[]> {
    return client.get<Destination[]>(BASE).then((r) => r.data)
  },

  create(data: DestinationFormData): Promise<Destination> {
    return client.post<Destination>(BASE, data).then((r) => r.data)
  },

  update(id: number, data: Partial<DestinationFormData>): Promise<Destination> {
    return client.patch<Destination>(`${BASE}/${id}`, data).then((r) => r.data)
  },

  delete(id: number): Promise<void> {
    return client.delete(`${BASE}/${id}`).then(() => undefined)
  },
}
