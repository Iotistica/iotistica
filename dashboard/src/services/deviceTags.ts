/**
 * Device Tags API Service
 */

import { buildApiUrl } from '@/config/api';

export interface DeviceTag {
  key: string;
  value: string;
}

export interface DeviceTagsResponse {
  deviceUuid: string;
  tags: Record<string, string>;
}

export interface TagDefinition {
  id: number;
  key: string;
  description?: string;
  allowedValues?: string[];
  isRequired: boolean;
}

export interface TagKey {
  key: string;
  deviceCount: number;
}

export interface TagValue {
  value: string;
  deviceCount: number;
}

// Request deduplication: cache and pending requests
const tagsCache = new Map<string, { data: Record<string, string>; timestamp: number }>();
const pendingRequests = new Map<string, Promise<Record<string, string>>>();
const CACHE_TTL = 30000; // 30 seconds

/**
 * Get all tags for a device (with caching and request deduplication)
 */
export async function getDeviceTags(deviceUuid: string): Promise<Record<string, string>> {
  // Check cache
  const cached = tagsCache.get(deviceUuid);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  // Check if request is already pending
  const pending = pendingRequests.get(deviceUuid);
  if (pending) {
    return pending;
  }

  // Create new request
  const request = (async () => {
    try {
      const response = await fetch(buildApiUrl(`/api/v1/agents/${deviceUuid}/tags`));
      
      if (!response.ok) {
        throw new Error('Failed to fetch device tags');
      }
      
      const data: DeviceTagsResponse = await response.json();
      
      // Update cache
      tagsCache.set(deviceUuid, { data: data.tags, timestamp: Date.now() });
      
      return data.tags;
    } finally {
      // Remove from pending
      pendingRequests.delete(deviceUuid);
    }
  })();

  // Store as pending
  pendingRequests.set(deviceUuid, request);
  
  return request;
}

/**
 * Invalidate cached tags for a device
 */
export function invalidateDeviceTagsCache(deviceUuid: string): void {
  tagsCache.delete(deviceUuid);
}

/**
 * Add or update a single tag
 */
export async function setDeviceTag(
  deviceUuid: string,
  key: string,
  value: string
): Promise<void> {
  const response = await fetch(buildApiUrl(`/api/v1/agents/${deviceUuid}/tags`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ key, value }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to add tag');
  }
  
  // Invalidate cache after update
  invalidateDeviceTagsCache(deviceUuid);
}

/**
 * Delete a specific tag
 */
export async function deleteDeviceTag(
  deviceUuid: string,
  key: string
): Promise<void> {
  const response = await fetch(buildApiUrl(`/api/v1/agents/${deviceUuid}/tags/${key}`), {
    method: 'DELETE',
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to delete tag');
  }
  
  // Invalidate cache after deletion
  invalidateDeviceTagsCache(deviceUuid);
}

/**
 * Replace all tags for a device
 */
export async function replaceDeviceTags(
  deviceUuid: string,
  tags: Record<string, string>
): Promise<void> {
  const response = await fetch(buildApiUrl(`/api/v1/agents/${deviceUuid}/tags`), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tags }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to replace tags');
  }
}

/**
 * Get all tag definitions
 */
export async function getTagDefinitions(): Promise<TagDefinition[]> {
  const response = await fetch(buildApiUrl('/api/v1/tags/definitions'));
  
  if (!response.ok) {
    throw new Error('Failed to fetch tag definitions');
  }
  
  const data = await response.json();
  return data.definitions;
}

/**
 * Create a new tag definition
 */
export async function createTagDefinition(
  key: string,
  description?: string,
  allowedValues?: string[],
  isRequired?: boolean
): Promise<TagDefinition> {
  const response = await fetch(buildApiUrl('/api/v1/tags/definitions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ key, description, allowedValues, isRequired }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to create tag definition');
  }
  
  const data = await response.json();
  return data.definition;
}

/**
 * Update an existing tag definition
 */
export async function updateTagDefinition(
  key: string,
  description?: string,
  allowedValues?: string[],
  isRequired?: boolean
): Promise<TagDefinition> {
  const response = await fetch(buildApiUrl(`/api/v1/tags/definitions/${key}`), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ description, allowedValues, isRequired }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to update tag definition');
  }
  
  const data = await response.json();
  return data.definition;
}

/**
 * Delete a tag definition
 */
export async function deleteTagDefinition(key: string): Promise<void> {
  const response = await fetch(buildApiUrl(`/api/v1/tags/definitions/${key}`), {
    method: 'DELETE',
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || error.error || 'Failed to delete tag definition');
  }
}

/**
 * Get all unique tag keys
 */
export async function getTagKeys(): Promise<TagKey[]> {
  const response = await fetch(buildApiUrl('/api/v1/tags/keys'));
  
  if (!response.ok) {
    throw new Error('Failed to fetch tag keys');
  }
  
  const data = await response.json();
  return data.keys;
}

/**
 * Get all values for a specific tag key
 */
export async function getTagValues(key: string): Promise<TagValue[]> {
  const response = await fetch(buildApiUrl(`/api/v1/tags/values/${key}`));
  
  if (!response.ok) {
    throw new Error('Failed to fetch tag values');
  }
  
  const data = await response.json();
  return data.values;
}
