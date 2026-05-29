import { client } from './client'
import type { Subscription, SubscriptionFormData } from '@/types'

const BASE = '/v1/publish/subscriptions'

export const subscriptionsApi = {
  getAll(): Promise<Subscription[]> {
    return client.get<Subscription[]>(BASE).then((r) => r.data)
  },

  create(data: SubscriptionFormData): Promise<Subscription> {
    return client.post<Subscription>(BASE, data).then((r) => r.data)
  },

  update(id: number, data: Partial<SubscriptionFormData>): Promise<Subscription> {
    return client.patch<Subscription>(`${BASE}/${id}`, data).then((r) => r.data)
  },

  delete(id: number): Promise<void> {
    return client.delete(`${BASE}/${id}`).then(() => undefined)
  },
}
