/**
 * Device State Management Context
 * 
 * Centralized state management for device current/target/pending states
 * Works alongside existing Sync button in Header component
 * 
 * Flow:
 * 1. User edits in UI → Updates pendingChanges (local only)
 * 2. User clicks "Save Draft" → Saves to device_target_state (sets needs_deployment = true)
 * 3. Sync button turns yellow → User sees changes are ready
 * 4. User clicks Sync → Calls /deploy API → Increments version → Device applies changes
 */

import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { buildApiUrl } from '../config/api';

// ============================================================================
// Type Definitions
// ============================================================================

interface ServiceConfig {
  appId?: number;
  serviceId: number;
  serviceName: string;
  imageName: string;
  state?: 'running' | 'stopped' | 'paused';
  status?: string;
  containerId?: string;
  config?: {
    image?: string;
    ports?: string[];
    volumes?: string[];
    environment?: Record<string, string>;
    labels?: Record<string, string>;
    restart?: string;
    networks?: string[];
    networkMode?: string;
  };
}

interface AppState {
  appId: number;
  appName: string;
  services: ServiceConfig[];
}

interface DeviceConfig {
  logging?: {
    level?: string;
    enableRemoteLogging?: boolean;
  };
  features?: {
    enableShadow?: boolean;
    enableCloudJobs?: boolean;
    enableMetricsExport?: boolean;
  };
  settings?: {
    metricsIntervalMs?: number;
    stateReportIntervalMs?: number;
    deviceReportIntervalMs?: number;
  };
  sensors?: Array<{
    name: string;
    enabled: boolean;
    protocol: string;
    connection: Record<string, any>;
    registers: Array<Record<string, any>>;
    pollInterval: number;
    metadata?: {
      createdAt?: string;
      createdBy?: string;
    };
  }>;
  [key: string]: any;
}

interface DeviceState {
  deviceUuid: string;
  
  // Server states (source of truth)
  currentState: {
    apps: Record<string, AppState>;
    config: DeviceConfig;
    version: number;
    lastReportedAt: string;
  } | null;
  
  targetState: {
    apps: Record<string, AppState>;
    config: DeviceConfig;
    version: number;
    needsDeployment: boolean;
    lastDeployedAt?: string;
    deployedBy?: string;
  } | null;
  
  // Local pending changes (not yet saved to database)
  pendingChanges: {
    apps: Record<string, AppState>;
    config: DeviceConfig;
  } | null;
  
  // UI state
  isDirty: boolean; // Has unsaved changes (pendingChanges exists)
  isSyncing: boolean; // Currently saving to API
  lastSyncError: string | null;
}

interface DeviceStateContextValue {
  // State getters
  getDeviceState: (deviceUuid: string) => DeviceState | undefined;
  getCurrentApps: (deviceUuid: string) => Record<string, AppState>;
  getTargetApps: (deviceUuid: string) => Record<string, AppState>;
  getPendingApps: (deviceUuid: string) => Record<string, AppState>;
  getCurrentConfig: (deviceUuid: string) => DeviceConfig;
  getTargetConfig: (deviceUuid: string) => DeviceConfig;
  getPendingConfig: (deviceUuid: string) => DeviceConfig;
  
  // State modifiers (local only - doesn't hit API)
  updatePendingApp: (deviceUuid: string, appId: string, updates: Partial<AppState>) => void;
  updatePendingService: (deviceUuid: string, appId: string, serviceId: number, updates: Partial<ServiceConfig>) => void;
  addPendingApp: (deviceUuid: string, app: AppState) => void;
  removePendingApp: (deviceUuid: string, appId: string) => void;
  
  // Config modifiers (device-level configuration)
  updatePendingConfig: (deviceUuid: string, path: string, value: any) => void;
  resetPendingConfig: (deviceUuid: string) => void;
  
  // Sensor modifiers (protocol adapter devices in config)
  addPendingSensor: (deviceUuid: string, sensor: any) => void;
  updatePendingSensor: (deviceUuid: string, sensorName: string, updates: any) => void;
  removePendingSensor: (deviceUuid: string, sensorName: string) => void;
  
  // State sync actions (hits API)
  fetchDeviceState: (deviceUuid: string) => Promise<void>;
  saveTargetState: (deviceUuid: string) => Promise<void>; // Save to device_target_state (draft)
  saveTargetStateWithConfig: (deviceUuid: string, config: any) => Promise<void>; // Save with explicit config (bypasses pending state)
  syncTargetState: (deviceUuid: string, deployedBy: string) => Promise<void>; // Mark for deployment (Sync button)
  cancelDeployment: (deviceUuid: string) => Promise<void>; // Cancel pending deployment
  discardPendingChanges: (deviceUuid: string) => void;
  
  // Utilities
  hasPendingChanges: (deviceUuid: string) => boolean;
  getSyncStatus: (deviceUuid: string) => "synced" | "syncing" | "error" | "pending";
}

// ============================================================================
// Context Creation
// ============================================================================

const DeviceStateContext = createContext<DeviceStateContextValue | undefined>(undefined);

// ============================================================================
// Provider Implementation
// ============================================================================

export function DeviceStateProvider({ children }: { children: ReactNode }) {
  // Store state for all devices
  const [deviceStates, setDeviceStates] = useState<Record<string, DeviceState>>({});
  
  // Fetch device state from API
  const fetchDeviceState = useCallback(async (deviceUuid: string) => {
    try {
      const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}`));
      if (!response.ok) {
        throw new Error(`Failed to fetch device: ${response.statusText}`);
      }
      const data = await response.json();
      
      setDeviceStates(prev => {
        // Preserve existing pending changes and isDirty flag
        const existingState = prev[deviceUuid];
        const preservePendingChanges = existingState?.pendingChanges || null;
        const preserveIsDirty = existingState?.isDirty || false;
        
        return {
          ...prev,
          [deviceUuid]: {
            deviceUuid,
            currentState: data.current_state ? {
              apps: data.current_state.apps || {},
              config: data.current_state.config || {},
              version: data.current_state.version || 0,
              lastReportedAt: data.current_state.reported_at || new Date().toISOString()
            } : null,
            targetState: data.target_state ? {
              apps: data.target_state.apps || {},
              config: data.target_state.config || {},
              version: data.target_state.version || 0,
              needsDeployment: data.target_state.needs_deployment || false,
              lastDeployedAt: data.target_state.last_deployed_at,
              deployedBy: data.target_state.deployed_by
            } : null,
            pendingChanges: preservePendingChanges, // Preserve existing pending changes
            isDirty: preserveIsDirty, // Preserve isDirty flag
            isSyncing: existingState?.isSyncing || false,
            lastSyncError: null,
          }
        };
      });
    } catch (error: any) {
      console.error('Failed to fetch device state:', error);
      setDeviceStates(prev => ({
        ...prev,
        [deviceUuid]: {
          ...prev[deviceUuid],
          lastSyncError: error.message
        }
      }));
    }
  }, []);
  
  // Update pending service (local only)
  const updatePendingService = useCallback((
    deviceUuid: string, 
    appId: string, 
    serviceId: number, 
    updates: Partial<ServiceConfig>
  ) => {
    setDeviceStates(prev => {
      const deviceState = prev[deviceUuid];
      if (!deviceState) return prev;
      
      // Start with target state if no pending changes yet
      const currentPending = deviceState.pendingChanges || {
        apps: { ...deviceState.targetState?.apps },
        config: { ...deviceState.targetState?.config }
      };
      
      // Update specific service
      const app = currentPending.apps[appId];
      if (!app) return prev;
      
      const updatedServices = app.services.map(s => 
        s.serviceId === serviceId ? { ...s, ...updates } : s
      );
      
      return {
        ...prev,
        [deviceUuid]: {
          ...deviceState,
          pendingChanges: {
            ...currentPending,
            apps: {
              ...currentPending.apps,
              [appId]: {
                ...app,
                services: updatedServices
              }
            }
          },
          isDirty: true
        }
      };
    });
  }, []);
  
  // Update pending app (local only)
  const updatePendingApp = useCallback((
    deviceUuid: string,
    appId: string,
    updates: Partial<AppState>
  ) => {
    setDeviceStates(prev => {
      const deviceState = prev[deviceUuid];
      if (!deviceState) return prev;
      
      // Start with target state if no pending changes yet
      const currentPending = deviceState.pendingChanges || {
        apps: { ...deviceState.targetState?.apps },
        config: { ...deviceState.targetState?.config }
      };
      
      const app = currentPending.apps[appId];
      if (!app) return prev;
      
      return {
        ...prev,
        [deviceUuid]: {
          ...deviceState,
          pendingChanges: {
            ...currentPending,
            apps: {
              ...currentPending.apps,
              [appId]: { ...app, ...updates }
            }
          },
          isDirty: true
        }
      };
    });
  }, []);
  
  // Add pending app (local only)
  const addPendingApp = useCallback((deviceUuid: string, app: AppState) => {
    setDeviceStates(prev => {
      const deviceState = prev[deviceUuid];
      if (!deviceState) return prev;
      
      // Start with target state if no pending changes yet
      const currentPending = deviceState.pendingChanges || {
        apps: { ...deviceState.targetState?.apps },
        config: { ...deviceState.targetState?.config }
      };
      
      return {
        ...prev,
        [deviceUuid]: {
          ...deviceState,
          pendingChanges: {
            ...currentPending,
            apps: {
              ...currentPending.apps,
              [app.appId]: app
            }
          },
          isDirty: true
        }
      };
    });
  }, []);
  
  // Remove pending app (local only)
  const removePendingApp = useCallback((deviceUuid: string, appId: string) => {
    setDeviceStates(prev => {
      const deviceState = prev[deviceUuid];
      if (!deviceState) return prev;
      
      // Start with target state if no pending changes yet
      const currentPending = deviceState.pendingChanges || {
        apps: { ...deviceState.targetState?.apps },
        config: { ...deviceState.targetState?.config }
      };
      
      const { [appId]: removed, ...remainingApps } = currentPending.apps;
      
      return {
        ...prev,
        [deviceUuid]: {
          ...deviceState,
          pendingChanges: {
            ...currentPending,
            apps: remainingApps
          },
          isDirty: true
        }
      };
    });
  }, []);
  
  // Update device config (local only)
  const updatePendingConfig = useCallback((deviceUuid: string, path: string, value: any) => {
    setDeviceStates(prev => {
      const deviceState = prev[deviceUuid];
      if (!deviceState) return prev;
      
      // Start with target state if no pending changes
      const currentPending = deviceState.pendingChanges || {
        apps: { ...deviceState.targetState?.apps },
        config: { ...deviceState.targetState?.config }
      };
      
      // Update config using dot notation path (e.g., "mqtt.broker")
      const pathParts = path.split('.');
      const updatedConfig = { ...currentPending.config };
      let current: any = updatedConfig;
      
      for (let i = 0; i < pathParts.length - 1; i++) {
        current[pathParts[i]] = { ...current[pathParts[i]] };
        current = current[pathParts[i]];
      }
      current[pathParts[pathParts.length - 1]] = value;
      
      return {
        ...prev,
        [deviceUuid]: {
          ...deviceState,
          pendingChanges: {
            ...currentPending,
            config: updatedConfig
          },
          isDirty: true
        }
      };
    });
  }, []);
  
  // Reset pending config to target state
  const resetPendingConfig = useCallback((deviceUuid: string) => {
    setDeviceStates(prev => {
      const deviceState = prev[deviceUuid];
      if (!deviceState) return prev;
      
      return {
        ...prev,
        [deviceUuid]: {
          ...deviceState,
          pendingChanges: deviceState.pendingChanges ? {
            ...deviceState.pendingChanges,
            config: { ...deviceState.targetState?.config }
          } : null,
          isDirty: false
        }
      };
    });
  }, []);
  
  // Add sensor to config (local only - matches app pattern)
  const addPendingSensor = useCallback((deviceUuid: string, sensor: any) => {
    // Defensive check
    if (!sensor) {
      console.error('[addPendingSensor] Sensor is undefined');
      throw new Error('Cannot add undefined sensor. API may need to be rebuilt.');
    }

    setDeviceStates(prev => {
      const deviceState = prev[deviceUuid];
      if (!deviceState) return prev;
      
      // Start with target state if no pending changes
      const currentPending = deviceState.pendingChanges || {
        apps: { ...deviceState.targetState?.apps },
        config: { ...deviceState.targetState?.config }
      };
      
      // Generate unique ID for sensor (UUID v4)
      // This ID persists through: draft → saved → deployed states
      const sensorWithId = {
        ...sensor,
        id: sensor.id || crypto.randomUUID() // Use existing ID or generate new one
      };
      
      // Add sensor to endpoints array
      const updatedConfig = { ...currentPending.config };
      const existingDevices = updatedConfig.endpoints || [];
      updatedConfig.endpoints = [...existingDevices, sensorWithId];
      
      return {
        ...prev,
        [deviceUuid]: {
          ...deviceState,
          pendingChanges: {
            ...currentPending,
            config: updatedConfig
          },
          isDirty: true
        }
      };
    });
  }, []);
  
  // Update sensor in config (local only)
  const updatePendingSensor = useCallback((deviceUuid: string, sensorName: string, updates: any) => {
    console.log(`[DeviceStateContext] updatePendingSensor called: ${sensorName}`, updates);
    
    setDeviceStates(prev => {
      const deviceState = prev[deviceUuid];
      if (!deviceState) {
        console.log('[DeviceStateContext] No device state found for', deviceUuid);
        return prev;
      }
      
      // Start with target state if no pending changes
      const currentPending = deviceState.pendingChanges || {
        apps: { ...deviceState.targetState?.apps },
        config: { ...deviceState.targetState?.config }
      };
      
      console.log('[DeviceStateContext] Current pending config.endpoints:', (currentPending.config as any)?.endpoints?.map((e: any) => ({ name: e.name, enabled: e.enabled })));
      
      // Update sensor in endpoints array
      const updatedConfig = { ...currentPending.config };
      const existingDevices = updatedConfig.endpoints || [];
      updatedConfig.endpoints = existingDevices.map((device: any) =>
        device.name === sensorName ? { ...device, ...updates } : device
      );
      
      console.log('[DeviceStateContext] Updated config.endpoints:', updatedConfig.endpoints.map((e: any) => ({ name: e.name, enabled: e.enabled })));
      
      return {
        ...prev,
        [deviceUuid]: {
          ...deviceState,
          pendingChanges: {
            ...currentPending,
            config: updatedConfig
          },
          isDirty: true
        }
      };
    });
  }, []);
  
  // Remove sensor from config (local only)
  const removePendingSensor = useCallback((deviceUuid: string, sensorName: string) => {
    setDeviceStates(prev => {
      const deviceState = prev[deviceUuid];
      if (!deviceState) return prev;
      
      // Start with target state if no pending changes
      const currentPending = deviceState.pendingChanges || {
        apps: { ...deviceState.targetState?.apps },
        config: { ...deviceState.targetState?.config }
      };
      
      // Remove sensor from endpoints array
      const updatedConfig = { ...currentPending.config };
      const existingDevices = updatedConfig.endpoints || [];
      updatedConfig.endpoints = existingDevices.filter((device: any) => device.name !== sensorName);
      
      return {
        ...prev,
        [deviceUuid]: {
          ...deviceState,
          pendingChanges: {
            ...currentPending,
            config: updatedConfig
          },
          isDirty: true
        }
      };
    });
  }, []);
  
  // Save to device_target_state (doesn't mark for deployment yet)
  const saveTargetState = useCallback(async (deviceUuid: string) => {
    const deviceState = deviceStates[deviceUuid];
    if (!deviceState?.pendingChanges) return;
    
    setDeviceStates(prev => ({
      ...prev,
      [deviceUuid]: { ...prev[deviceUuid], isSyncing: true, lastSyncError: null }
    }));
    
    try {
      // Save to API (device_target_state table) - sets needs_deployment = true
      console.log('[saveTargetState] Sending to API:', {
        deviceUuid,
        apps: deviceState.pendingChanges.apps,
        configEndpoints: (deviceState.pendingChanges.config as any)?.endpoints?.map((e: any) => ({ name: e.name, enabled: e.enabled }))
      });
      
      const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/target-state`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apps: deviceState.pendingChanges.apps,
          config: deviceState.pendingChanges.config
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Save target state failed:', response.status, errorData);
        console.error('Validation errors:', JSON.stringify(errorData.errors, null, 2));
        console.error('Sent config:', JSON.stringify(deviceState.pendingChanges.config, null, 2));
        throw new Error(errorData.message || `Failed to save target state: ${response.statusText}`);
      }
      
      // Re-fetch to get updated state
      await fetchDeviceState(deviceUuid);
      
      // Clear pending changes after successful save
      setDeviceStates(prev => ({
        ...prev,
        [deviceUuid]: {
          ...prev[deviceUuid],
          pendingChanges: null,
          isDirty: false,
          isSyncing: false
        }
      }));
    } catch (error: any) {
      setDeviceStates(prev => ({
        ...prev,
        [deviceUuid]: { 
          ...prev[deviceUuid], 
          isSyncing: false, 
          lastSyncError: error.message 
        }
      }));
      throw error;
    }
  }, [deviceStates, fetchDeviceState]);
  
  // Save target state with explicit config (bypasses pending state)
  const saveTargetStateWithConfig = useCallback(async (deviceUuid: string, config: any) => {
    const deviceState = deviceStates[deviceUuid];
    if (!deviceState) return;
    
    setDeviceStates(prev => ({
      ...prev,
      [deviceUuid]: { ...prev[deviceUuid], isSyncing: true, lastSyncError: null }
    }));
    
    try {
      // Get apps from target state or pending changes
      const apps = deviceState.pendingChanges?.apps || deviceState.targetState?.apps || {};
      
      console.log('[saveTargetStateWithConfig] Sending to API:', {
        deviceUuid,
        apps,
        configEndpoints: config?.endpoints?.map((e: any) => ({ name: e.name, enabled: e.enabled }))
      });
      
      const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/target-state`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apps, config })
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Save target state failed:', response.status, errorData);
        throw new Error(errorData.message || `Failed to save target state: ${response.statusText}`);
      }
      
      // Re-fetch to get updated state
      await fetchDeviceState(deviceUuid);
      
      // Clear pending changes after successful save
      setDeviceStates(prev => ({
        ...prev,
        [deviceUuid]: {
          ...prev[deviceUuid],
          pendingChanges: null,
          isDirty: false,
          isSyncing: false
        }
      }));
    } catch (error: any) {
      setDeviceStates(prev => ({
        ...prev,
        [deviceUuid]: { 
          ...prev[deviceUuid], 
          isSyncing: false, 
          lastSyncError: error.message 
        }
      }));
      throw error;
    }
  }, [deviceStates, fetchDeviceState]);
  
  // Sync/Deploy - marks target state ready for device (Sync button in Header)
  const syncTargetState = useCallback(async (deviceUuid: string, deployedBy: string = 'dashboard') => {
    setDeviceStates(prev => ({
      ...prev,
      [deviceUuid]: { ...prev[deviceUuid], isSyncing: true }
    }));
    
    try {
      // Call global deploy endpoint - increments version, syncs sensors to table with deployment_status='pending'
      const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/deploy`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deployedBy })
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Deploy failed:', response.status, errorData);
        throw new Error(errorData.message || `Failed to sync state: ${response.statusText}`);
      }
      
      // Re-fetch to update needsDeployment flag
      await fetchDeviceState(deviceUuid);
      
      setDeviceStates(prev => ({
        ...prev,
        [deviceUuid]: { ...prev[deviceUuid], isSyncing: false }
      }));
    } catch (error: any) {
      setDeviceStates(prev => ({
        ...prev,
        [deviceUuid]: { 
          ...prev[deviceUuid], 
          isSyncing: false, 
          lastSyncError: error.message 
        }
      }));
      throw error;
    }
  }, [fetchDeviceState]);
  
  // Cancel deployment - discard pending deployment
  const cancelDeployment = useCallback(async (deviceUuid: string) => {
    try {
      const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/deploy/cancel`), {
        method: 'POST'
      });
      
      if (!response.ok) {
        throw new Error(`Failed to cancel deployment: ${response.statusText}`);
      }
      
      await fetchDeviceState(deviceUuid);
    } catch (error: any) {
      console.error('Failed to cancel deployment:', error);
      throw error;
    }
  }, [fetchDeviceState]);
  
  // Discard pending changes
  const discardPendingChanges = useCallback((deviceUuid: string) => {
    setDeviceStates(prev => ({
      ...prev,
      [deviceUuid]: {
        ...prev[deviceUuid],
        pendingChanges: null,
        isDirty: false
      }
    }));
  }, []);
  
  // Utility functions
  const getDeviceState = useCallback((deviceUuid: string) => deviceStates[deviceUuid], [deviceStates]);
  
  const getCurrentApps = useCallback((deviceUuid: string) => 
    deviceStates[deviceUuid]?.currentState?.apps || {}, [deviceStates]);
  
  const getTargetApps = useCallback((deviceUuid: string) => 
    deviceStates[deviceUuid]?.targetState?.apps || {}, [deviceStates]);
  
  const getPendingApps = useCallback((deviceUuid: string) => 
    deviceStates[deviceUuid]?.pendingChanges?.apps || 
    deviceStates[deviceUuid]?.targetState?.apps || {}, [deviceStates]);
  
  const getCurrentConfig = useCallback((deviceUuid: string) =>
    deviceStates[deviceUuid]?.currentState?.config || {}, [deviceStates]);
  
  const getTargetConfig = useCallback((deviceUuid: string) =>
    deviceStates[deviceUuid]?.targetState?.config || {}, [deviceStates]);
  
  const getPendingConfig = useCallback((deviceUuid: string) =>
    deviceStates[deviceUuid]?.pendingChanges?.config ||
    deviceStates[deviceUuid]?.targetState?.config || {}, [deviceStates]);
  
  const hasPendingChanges = useCallback((deviceUuid: string) => {
    const deviceState = deviceStates[deviceUuid];
    if (!deviceState) return false;
    
    // If device hasn't reported yet (no currentState) OR no target state loaded, no deployment needed
    // This prevents the sync button from being enabled before initial data is loaded
    if (!deviceState.currentState || !deviceState.targetState) return false;
    
    // Check if there are unsaved local changes OR saved changes that need deployment
    return !!deviceState.isDirty || !!deviceState.targetState.needsDeployment;
  }, [deviceStates]);
  
  const getSyncStatus = useCallback((deviceUuid: string): "synced" | "syncing" | "error" | "pending" => {
    const deviceState = deviceStates[deviceUuid];
    if (!deviceState) return "pending";
    
    // If there's an error, show error
    if (deviceState.lastSyncError) return "error";
    
    // If there are unsaved changes, show pending
    if (deviceState.isDirty) return "pending";
    
    // If actively syncing (button was clicked), show syncing
    if (deviceState.isSyncing) return "syncing";
    
    // If there are saved changes needing deployment, show pending
    if (deviceState.targetState?.needsDeployment) return "pending";
    
    // Check version match: if current and target versions match, it's synced
    const currentVersion = deviceState.currentState?.version;
    const targetVersion = deviceState.targetState?.version;
    
    if (currentVersion !== undefined && targetVersion !== undefined) {
      if (currentVersion === targetVersion) {
        return "synced";
      } else {
        // Version mismatch means device hasn't reported back yet - still syncing
        return "syncing";
      }
    }
    
    // Default to synced if no target state exists
    return "synced";
  }, [deviceStates]);
  
  const value: DeviceStateContextValue = {
    getDeviceState,
    getCurrentApps,
    getTargetApps,
    getPendingApps,
    getCurrentConfig,
    getTargetConfig,
    getPendingConfig,
    updatePendingApp,
    updatePendingService,
    addPendingApp,
    removePendingApp,
    updatePendingConfig,
    resetPendingConfig,
    addPendingSensor,
    updatePendingSensor,
    removePendingSensor,
    fetchDeviceState,
    saveTargetState,
    saveTargetStateWithConfig,
    syncTargetState,
    cancelDeployment,
    discardPendingChanges,
    hasPendingChanges,
    getSyncStatus,
  };
  
  // Listen for sensor config changes (toggle events) and mark as needs deployment
  useEffect(() => {
    const handleConfigChanged = (event: CustomEvent) => {
      const deviceUuid = event.detail.deviceUuid;
      console.log(`DeviceStateContext: Sensor config changed for device ${deviceUuid}`);
      
      setDeviceStates(prev => {
        const deviceState = prev[deviceUuid];
        if (!deviceState?.targetState) return prev;
        
        return {
          ...prev,
          [deviceUuid]: {
            ...deviceState,
            targetState: {
              ...deviceState.targetState,
              needsDeployment: true // Mark as needs deployment immediately
            }
          }
        };
      });
    };
    
    window.addEventListener('sensor-config-changed', handleConfigChanged as EventListener);
    
    return () => {
      window.removeEventListener('sensor-config-changed', handleConfigChanged as EventListener);
    };
  }, []);
  
  return (
    <DeviceStateContext.Provider value={value}>
      {children}
    </DeviceStateContext.Provider>
  );
}

// ============================================================================
// Custom Hook
// ============================================================================

export function useDeviceState() {
  const context = useContext(DeviceStateContext);
  if (!context) {
    throw new Error('useDeviceState must be used within DeviceStateProvider');
  }
  return context;
}

// Export types
export type { DeviceState, AppState, ServiceConfig, DeviceConfig };
