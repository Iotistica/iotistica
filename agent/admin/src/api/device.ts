import { client } from './client'

export interface DeviceInfo {
  uuid?: string
  name?: string
  provisioned?: boolean
  is_online?: boolean
  pro_installed?: boolean
  [key: string]: unknown
}

export const deviceApi = {
  getInfo(): Promise<DeviceInfo> {
    return client.get<DeviceInfo>('/v1/device').then((r) => r.data)
  },
}
