import { client } from './client'

export interface NetworkBandwidth {
  iface: string
  rx_sec: number
  tx_sec: number
  rx_bytes: number
  tx_bytes: number
}

export interface DashboardStats {
  cpu_usage: number
  memory_percent: number
  memory_used: number
  memory_total: number
  storage_percent: number | null
  storage_used: number | null
  storage_total: number | null
  uptime: number
  hostname: string
  network: NetworkBandwidth[]
}

export const dashboardApi = {
  getStats(): Promise<DashboardStats> {
    return client.get<DashboardStats>('/v1/dashboard/stats').then((r) => r.data)
  },
}
