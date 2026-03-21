/**
 * Permission System Types
 * 
 * Implements RBAC (Role-Based Access Control) with granular permissions
 * using the resource:action pattern.
 */

// Permission constants
export const PERMISSIONS = {
  // User management
  USER_READ: 'user:read',
  USER_WRITE: 'user:write',
  USER_DELETE: 'user:delete',
  
  // Device management
  DEVICE_READ: 'device:read',
  DEVICE_WRITE: 'device:write',
  DEVICE_DELETE: 'device:delete',
  DEVICE_CONTROL: 'device:control',
  
  // MQTT management
  MQTT_USER_READ: 'mqtt:user:read',
  MQTT_USER_WRITE: 'mqtt:user:write',
  MQTT_ACL_MANAGE: 'mqtt:acl:manage',
  
  // API keys
  API_KEY_READ: 'api-key:read',
  API_KEY_CREATE: 'api-key:create',
  API_KEY_REVOKE: 'api-key:revoke',
  
  // Data access
  DATA_READ: 'data:read',
  DATA_EXPORT: 'data:export',
  DATA_DELETE: 'data:delete',
  
  // Settings
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',
  
  // Billing (owner only)
  BILLING_READ: 'billing:read',
  BILLING_MANAGE: 'billing:manage',
} as const;

// Role constants
export const ROLES = {
  OWNER: 'owner',           // Full access + billing
  ADMIN: 'admin',           // Full access except billing
  MANAGER: 'manager',       // Read all, write agents/users
  OPERATOR: 'operator',     // Read all, control agents
  VIEWER: 'viewer',         // Read-only access
} as const;

// Type definitions
export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS];
export type Role = typeof ROLES[keyof typeof ROLES];

// Role to permissions mapping
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [ROLES.OWNER]: [
    // All permissions
    PERMISSIONS.USER_READ,
    PERMISSIONS.USER_WRITE,
    PERMISSIONS.USER_DELETE,
    PERMISSIONS.DEVICE_READ,
    PERMISSIONS.DEVICE_WRITE,
    PERMISSIONS.DEVICE_DELETE,
    PERMISSIONS.DEVICE_CONTROL,
    PERMISSIONS.MQTT_USER_READ,
    PERMISSIONS.MQTT_USER_WRITE,
    PERMISSIONS.MQTT_ACL_MANAGE,
    PERMISSIONS.API_KEY_READ,
    PERMISSIONS.API_KEY_CREATE,
    PERMISSIONS.API_KEY_REVOKE,
    PERMISSIONS.DATA_READ,
    PERMISSIONS.DATA_EXPORT,
    PERMISSIONS.DATA_DELETE,
    PERMISSIONS.SETTINGS_READ,
    PERMISSIONS.SETTINGS_WRITE,
    PERMISSIONS.BILLING_READ,
    PERMISSIONS.BILLING_MANAGE,
  ],
  
  [ROLES.ADMIN]: [
    PERMISSIONS.USER_READ,
    PERMISSIONS.USER_WRITE,
    PERMISSIONS.USER_DELETE,
    PERMISSIONS.DEVICE_READ,
    PERMISSIONS.DEVICE_WRITE,
    PERMISSIONS.DEVICE_DELETE,
    PERMISSIONS.DEVICE_CONTROL,
    PERMISSIONS.MQTT_USER_READ,
    PERMISSIONS.MQTT_USER_WRITE,
    PERMISSIONS.MQTT_ACL_MANAGE,
    PERMISSIONS.API_KEY_READ,
    PERMISSIONS.API_KEY_CREATE,
    PERMISSIONS.API_KEY_REVOKE,
    PERMISSIONS.DATA_READ,
    PERMISSIONS.DATA_EXPORT,
    PERMISSIONS.DATA_DELETE,
    PERMISSIONS.SETTINGS_READ,
    PERMISSIONS.SETTINGS_WRITE,
    // No billing access
  ],
  
  [ROLES.MANAGER]: [
    PERMISSIONS.USER_READ,
    PERMISSIONS.USER_WRITE,
    PERMISSIONS.DEVICE_READ,
    PERMISSIONS.DEVICE_WRITE,
    PERMISSIONS.DEVICE_CONTROL,
    PERMISSIONS.MQTT_USER_READ,
    PERMISSIONS.API_KEY_READ,
    PERMISSIONS.DATA_READ,
    PERMISSIONS.DATA_EXPORT,
    PERMISSIONS.SETTINGS_READ,
  ],
  
  [ROLES.OPERATOR]: [
    PERMISSIONS.USER_READ,
    PERMISSIONS.DEVICE_READ,
    PERMISSIONS.DEVICE_CONTROL,
    PERMISSIONS.MQTT_USER_READ,
    PERMISSIONS.DATA_READ,
    PERMISSIONS.SETTINGS_READ,
  ],
  
  [ROLES.VIEWER]: [
    PERMISSIONS.USER_READ,
    PERMISSIONS.DEVICE_READ,
    PERMISSIONS.DATA_READ,
    PERMISSIONS.SETTINGS_READ,
  ],
};

// Helper function to check if a role has a permission
export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

// Helper function to get all permissions for a role
export function getPermissionsForRole(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

// User type with permissions
export interface UserWithPermissions {
  id: number;
  username: string;
  email: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  last_login_at?: string;
}
