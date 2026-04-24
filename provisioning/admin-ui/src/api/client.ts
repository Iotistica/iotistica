import { Customer, Job, Subscription } from './types';

const TOKEN_KEY = 'admin_token';

function getToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...init.headers,
    },
  });

  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    window.location.href = '/admin/login';
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// ─── Customers ───────────────────────────────────────────────────────────────

export async function listCustomers(params: {
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ customers: Customer[]; total: number; limit: number; offset: number }> {
  const q = new URLSearchParams();
  if (params.search) q.set('search', params.search);
  if (params.status) q.set('status', params.status);
  if (params.limit != null) q.set('limit', String(params.limit));
  if (params.offset != null) q.set('offset', String(params.offset));
  return request(`/api/admin/customers?${q}`);
}

export async function getCustomer(
  id: string
): Promise<{ customer: Customer; subscription: Subscription | null }> {
  return request(`/api/admin/customers/${id}`);
}

export async function createCustomer(data: {
  email: string;
  company_name?: string;
  full_name?: string;
  plan?: 'trial' | 'starter' | 'professional' | 'enterprise';
}): Promise<{ customer: Customer }> {
  return request('/api/admin/customers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateCustomer(
  id: string,
  data: { company_name?: string; full_name?: string; is_active?: boolean }
): Promise<{ customer: Customer }> {
  return request(`/api/admin/customers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteCustomer(id: string): Promise<{ success: boolean }> {
  return request(`/api/admin/customers/${id}`, { method: 'DELETE' });
}

export async function provisionCustomer(
  id: string
): Promise<{ jobId: string; message: string }> {
  return request(`/api/admin/customers/${id}/provision`, { method: 'POST' });
}

export async function deprovisionCustomer(
  id: string
): Promise<{ jobId: string; message: string }> {
  return request(`/api/admin/customers/${id}/deprovision`, { method: 'POST' });
}

export async function getCustomerJobs(id: string): Promise<{ jobs: Job[] }> {
  return request(`/api/admin/customers/${id}/jobs`);
}

// ─── Token validation (login) ─────────────────────────────────────────────────

export async function checkAuth(): Promise<boolean> {
  try {
    await request('/api/admin/jobs');
    return true;
  } catch {
    return false;
  }
}
