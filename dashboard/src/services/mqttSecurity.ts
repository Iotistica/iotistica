import { buildApiUrl } from '@/config/api';

export interface MqttAcl {
  id: number;
  topic: string;
  access: number;
  priority: number;
  created_at: string;
}

export interface MqttUser {
  id: number;
  username: string;
  is_superuser: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  acls: MqttAcl[];
}

interface MqttUsersResponse {
  success: boolean;
  users: MqttUser[];
}

interface CreateMqttUserRequest {
  username: string;
  password: string;
  is_superuser?: boolean;
  is_active?: boolean;
}

interface UpdateMqttUserRequest {
  password?: string;
  is_superuser?: boolean;
  is_active?: boolean;
}

interface CreateMqttAclRequest {
  topic: string;
  access: number;
  priority?: number;
}

interface UpdateMqttAclRequest {
  topic?: string;
  access?: number;
  priority?: number;
}

async function handleResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (data as any).message || (data as any).error || `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

export async function listMqttUsers(): Promise<MqttUser[]> {
  const response = await fetch(buildApiUrl('/api/v1/auth/mqtt-users'), {
    credentials: 'include',
  });

  const data = await handleResponse<MqttUsersResponse>(response);
  return data.users || [];
}

export async function createMqttUser(payload: CreateMqttUserRequest): Promise<MqttUser> {
  const response = await fetch(buildApiUrl('/api/v1/auth/mqtt-users'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  const data = await handleResponse<{ success: boolean; user: MqttUser }>(response);
  return data.user;
}

export async function updateMqttUser(userId: number, payload: UpdateMqttUserRequest): Promise<MqttUser> {
  const response = await fetch(buildApiUrl(`/api/v1/auth/mqtt-users/${userId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  const data = await handleResponse<{ success: boolean; user: MqttUser }>(response);
  return data.user;
}

export async function deleteMqttUser(userId: number): Promise<void> {
  const response = await fetch(buildApiUrl(`/api/v1/auth/mqtt-users/${userId}`), {
    method: 'DELETE',
    credentials: 'include',
  });

  await handleResponse<{ success: boolean; message: string }>(response);
}

export async function createMqttAcl(userId: number, payload: CreateMqttAclRequest): Promise<MqttAcl> {
  const response = await fetch(buildApiUrl(`/api/v1/auth/mqtt-users/${userId}/acls`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  const data = await handleResponse<{ success: boolean; acl: MqttAcl }>(response);
  return data.acl;
}

export async function updateMqttAcl(aclId: number, payload: UpdateMqttAclRequest): Promise<MqttAcl> {
  const response = await fetch(buildApiUrl(`/api/v1/auth/mqtt-acls/${aclId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  const data = await handleResponse<{ success: boolean; acl: MqttAcl }>(response);
  return data.acl;
}

export async function deleteMqttAcl(aclId: number): Promise<void> {
  const response = await fetch(buildApiUrl(`/api/v1/auth/mqtt-acls/${aclId}`), {
    method: 'DELETE',
    credentials: 'include',
  });

  await handleResponse<{ success: boolean; message: string }>(response);
}
