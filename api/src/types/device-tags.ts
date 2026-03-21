/**
 * Device Tags Types
 * Type definitions for device tagging system
 */

export interface DeviceTag {
  id: number;
  deviceUuid: string;
  key: string;
  value: string;
  createdAt: Date;
  createdBy?: number;
  updatedAt: Date;
}

export interface TagDefinition {
  id: number;
  key: string;
  description?: string;
  allowedValues?: string[];
  isRequired: boolean;
  createdAt: Date;
  createdBy?: number;
  updatedAt: Date;
}

export interface TagSelector {
  [key: string]: string;
}

export interface DeviceTagsResponse {
  deviceUuid: string;
  tags: Record<string, string>;
}

export interface TagOperationRequest {
  key: string;
  value: string;
}

export interface BulkTagOperationRequest {
  deviceUuids: string[];
  tags: Record<string, string>;
}

export interface DeviceQueryRequest {
  tagSelectors: TagSelector;
}

export interface DeviceQueryResponse {
  count: number;
  agents: Array<{
    uuid: string;
    deviceName?: string;
    deviceType?: string;
    isOnline: boolean;
    tags: Record<string, string>;
  }>;
}

export interface TagDefinitionRequest {
  key: string;
  description?: string;
  allowedValues?: string[];
  isRequired?: boolean;
}

export interface TagDefinitionUpdateRequest {
  description?: string;
  allowedValues?: string[];
  isRequired?: boolean;
}
