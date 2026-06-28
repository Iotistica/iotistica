import { client } from './client'

export interface User {
  id: number
  username: string
  is_superuser: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface Session {
  token: string
  token_id: string
  username: string
  created_at: string
  expires_at: string
  active: boolean
}

const BASE = '/v1/admin/users'
const SESSIONS_BASE = '/v1/admin/sessions'

export const usersApi = {
  getAll(): Promise<User[]> {
    return client.get<{ users: User[] }>(BASE).then((r) => r.data.users)
  },

  create(data: { username: string; password: string; is_superuser?: boolean }): Promise<User> {
    return client.post<{ user: User }>(BASE, data).then((r) => r.data.user)
  },

  update(username: string, data: { is_active?: boolean; is_superuser?: boolean; password?: string }): Promise<User> {
    return client.patch<{ user: User }>(`${BASE}/${encodeURIComponent(username)}`, data).then((r) => r.data.user)
  },

  remove(username: string): Promise<void> {
    return client.delete(`${BASE}/${encodeURIComponent(username)}`).then(() => undefined)
  },
}

export const sessionsApi = {
  getAll(): Promise<Session[]> {
    return client.get<{ sessions: Session[] }>(SESSIONS_BASE).then((r) => r.data.sessions)
  },

  revoke(token: string): Promise<void> {
    return client.delete(`${SESSIONS_BASE}/${encodeURIComponent(token)}`).then(() => undefined)
  },
}
