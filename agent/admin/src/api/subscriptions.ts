import { client } from './client'
import type { Subscription, SubscriptionFormData } from '@/types'

const BASE = '/v1/publish/subscriptions'

export const subscriptionsApi = {
  getAll(): Promise<Subscription[]> {
    return client.get<{ subscriptions: Subscription[] }>(BASE).then((r) => r.data.subscriptions)
  },

  create(data: SubscriptionFormData): Promise<Subscription> {
    return client.post<{ subscription: Subscription }>(BASE, data).then((r) => r.data.subscription)
  },

  update(id: number, data: Partial<SubscriptionFormData>): Promise<Subscription> {
    return client.patch<{ subscription: Subscription }>(`${BASE}/${id}`, data).then((r) => r.data.subscription)
  },

  delete(id: number): Promise<void> {
    return client.delete(`${BASE}/${id}`).then(() => undefined)
  },
}
