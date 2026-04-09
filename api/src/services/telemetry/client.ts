import logger from '../../utils/logger';

export interface RemoteReadingInsertPayload {
  agent_uuid: string;
  metric_name: string;
  value: number;
  unit?: string;
  protocol: string;
  quality?: 'good' | 'fair' | 'poor';
  extra?: Record<string, unknown> | null;
}

function getIngestionInternalUrl(): string {
  const url = process.env.INGESTION_INTERNAL_URL?.trim();

  if (!url) {
    throw new Error('INGESTION_INTERNAL_URL must be set for the API service');
  }

  return url.replace(/\/$/, '');
}

function getInternalAuthToken(): string {
  const token = process.env.INTERNAL_AUTH_TOKEN?.trim();

  if (!token) {
    throw new Error('INTERNAL_AUTH_TOKEN must be set for ingestion control-plane requests');
  }

  return token;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('x-internal-auth-token', getInternalAuthToken());
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${getIngestionInternalUrl()}${path}`, {
    method: init?.method || 'GET',
    ...init,
    headers,
  });

  if (!response.ok) {
    const body = await response.text();
    logger.error('Ingestion service request failed', {
      path,
      status: response.status,
      body,
    });
    throw new Error(`Ingestion service request failed for ${path} with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function getRemoteIngestionHealth<T>(): Promise<T> {
  return requestJson<T>('/api/v1/metrics/ingestion-health');
}

export async function getRemoteIngestionStats<T>(): Promise<T> {
  return requestJson<T>('/api/v1/admin/ingestion/stats');
}

export async function insertRemoteReading(reading: RemoteReadingInsertPayload): Promise<void> {
  await requestJson<{ message: string }>('/api/v1/readings/internal', {
    method: 'POST',
    body: JSON.stringify(reading),
  });
}