/**
 * Sensors Page - User-Friendly Sensor Management
 * Hides technical pipeline details, focuses on sensor configuration and status
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Activity, Pencil, Plus, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AddSensorDialog } from '@/components/sensors/AddSensorDialog';
import { EditSensorDialog } from '@/components/sensors/EditSensorDialog';
import { SensorSummaryCards } from '@/components/sensors/SensorSummaryCards';
import { toast } from 'sonner';
import { buildApiUrl } from '@/config/api';
import { Device } from "../components/DeviceSidebar";
import { useDeviceState } from '@/contexts/DeviceStateContext';


interface SensorsPageProps {
  deviceUuid: string;
  deviceStatus?: Device['status']; // Add device status for permission checks
  deviceType?: Device['type']; // Device type to determine feature availability
  debugMode?: boolean;
  onDebugModeChange?: (enabled: boolean) => void;
}

interface ModbusDataPoint {
  name: string;
  address: number;
  type: string;
  dataType: string;
  unit?: string;
  scale?: number;
  description?: string;
  base?: number;
  noise_pct?: number;
}

interface OPCUADataPoint {
  name: string;
  nodeId: string;
}

interface Sensor {
  uuid?: string; // Unique identifier for the sensor
  name: string;
  state: string;
  healthy: boolean;
  messagesPublished: number;
  lastActivity: string | null;
  lastError: string | null;
  configured: boolean;
  enabled?: boolean; // Whether sensor is enabled/disabled
  type?: 'pipeline' | 'device' | 'virtual'; // pipeline = sensor publish, device = protocol adapter, virtual = simulator
  protocol?: string;
  connected?: boolean;
  dataPoints?: ModbusDataPoint[] | OPCUADataPoint[]; // Protocol-specific data points
  // Deployment tracking fields
  deploymentStatus?: 'pending' | 'deployed' | 'deploying' | 'failed' | 'draft' | 'pending_deletion';
  lastDeployedAt?: string | null;
  deploymentError?: string | null;
  deploymentAttempts?: number;
  // Health metrics from device_sensors table
  health?: {
    status: string;
    connected: boolean;
    lastPoll: string | null;
    errorCount: number;
    lastError: string | null;
    updatedAt: string | null;
  } | null;
  // Virtual device fields
  isVirtual?: boolean;
  virtualProfile?: string;
  virtualImage?: string;
  virtualConnection?: {
    host: string;
    port: number;
  };
}

interface Profile {
  profile_name: string;
  protocol: string;
  data_points: any[];
}

export const SensorsPage: React.FC<SensorsPageProps> = ({ 
  deviceUuid,
  deviceType
}) => {
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addSensorDialogOpen, setAddSensorDialogOpen] = useState(false);
  const [selectedSensor, setSelectedSensor] = useState<Sensor | null>(null);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [selectedProtocol, setSelectedProtocol] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const { getPendingConfig, updatePendingSensor, addPendingSensor } = useDeviceState();

  // Virtual device states
  const [addVirtualDeviceDialogOpen, setAddVirtualDeviceDialogOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [virtualFormData, setVirtualFormData] = useState({
    name: '',
    protocol: 'modbus',
    profile: '',
    slaveCount: 40,
  });
  const [virtualDeviceLoading, setVirtualDeviceLoading] = useState(false);

  const fetchSensors = useCallback(async () => {
    console.log('[fetchSensors] 🔄 START - Fetching sensors from API');
    try {
      const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/sensors`));
      if (!response.ok) {
        const text = await response.text();
        let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        try {
          const errorJson = JSON.parse(text);
          errorMessage = errorJson.message || errorMessage;
        } catch {
          // If not JSON, use the status text
        }
        throw new Error(errorMessage);
      }
      const data = await response.json();
      
      console.log('[fetchSensors] Raw API response:', {
        devicesCount: data.devices?.length,
        pipelinesCount: data.pipelines?.length,
        firstDevice: data.devices?.[0],
        deviceNames: data.devices?.map((d: any) => d.name),
        pipelineNames: data.pipelines?.map((p: any) => p.name),
        deploymentStatuses: data.devices?.map((d: any) => ({ name: d.name, status: d.deploymentStatus || d.deployment_status, metadata: d.metadata }))
      });
      
      // Merge pipelines and protocol adapter devices
      const pipelines = (data.pipelines || []).map((p: any) => ({
        ...p,
        type: 'pipeline' as const,
        protocol: p.protocolType, // Map protocolType to protocol for consistency
      }));
      
      const devices = (data.devices || []).map((d: any) => {
        // Use health data if available, otherwise fall back to connection status
        const health = d.health;
        const isConnected = health ? health.connected : d.connected;
        
        console.log(`[fetchSensors] device "${d.name}":`, {
          enabled: d.enabled,
          healthConnected: health?.connected,
          deploymentStatus: d.deploymentStatus,
          state: d.state,
          rawDeploymentStatus: d.deployment_status, // Check if API returns snake_case
          rawData: d
        });
        
        return {
          uuid: d.uuid || d.configId, // Use uuid from table, fallback to configId
          name: d.name,
          state: isConnected ? 'CONNECTED' : 'DISCONNECTED',
          healthy: health ? (health.status === 'healthy' || health.connected) : d.connected,
          messagesPublished: 0, // Protocol adapters don't track messages
          lastActivity: health?.updatedAt || null,
          lastError: health?.lastError || d.lastError,
          configured: true,
          enabled: d.enabled !== undefined ? d.enabled : true, // Default to enabled
          type: 'device' as const,
          protocol: d.protocol,
          connected: isConnected,
          connection: d.connection, // Full connection configuration
          dataPoints: d.dataPoints || d.data_points || [], // Data points configuration
          pollInterval: d.pollInterval, // Poll interval
          // Deployment tracking
          deploymentStatus: d.deploymentStatus || d.deployment_status,
          lastDeployedAt: d.lastDeployedAt,
          deploymentError: d.deploymentError,
          deploymentAttempts: d.deploymentAttempts,
          // Health metrics
          health: health ? {
            status: health.status,
            connected: health.connected,
            lastPoll: health.lastPoll,
            errorCount: health.errorCount,
            lastError: health.lastError,
            updatedAt: health.updatedAt
          } : null,
        };
      });
      
      // Get pending devices from config (devices not yet deployed)
      console.log('[fetchSensors] 📋 Getting pending config...');
      const pendingConfig = getPendingConfig(deviceUuid);
      
      console.log('[fetchdevices] Pending config:', {
        hasEndpoints: !!pendingConfig.endpoints,
        endpointsCount: pendingConfig.endpoints?.length || 0,
        hasSensors: !!pendingConfig.sensors,
        sensorsCount: pendingConfig.sensors?.length || 0
      });
      
      // Check both endpoints (new validation mode) and sensors (legacy)
      const pendingEndpoints = pendingConfig.endpoints || pendingConfig.sensors || [];
      
      const pendingSensors = pendingEndpoints
        .filter((s: any) => {
          // Exclude virtual devices from pending sensors (they're fetched separately)
          if (s.metadata?.virtual === true) {
            console.log(`[fetchSensors] Skipping virtual device "${s.name}" from pending state (fetched via virtual-devices endpoint)`);
            return false;
          }
          
          // Only include sensors that are NOT in the database yet
          const notInDb = !devices.find((d: any) => d.name === s.name);
          if (notInDb) {
            console.log(`[fetchSensors] Pending sensor "${s.name}" not in DB - adding to grid`);
          }
          return notInDb;
        })
        .map((s: any) => {
          return {
            uuid: s.id || s.uuid, // Use generated ID from addPendingSensor
            name: s.name,
            state: 'DRAFT', // Use DRAFT to distinguish from deployed sensors waiting for agent
            healthy: false,
            messagesPublished: 0,
            lastActivity: null,
            lastError: null,
            configured: true,
            enabled: s.enabled !== undefined ? s.enabled : true, // Default to enabled
            type: 'device' as const,
            protocol: s.protocol,
            connected: false,
            connection: s.connection, // Include connection config
            dataPoints: s.dataPoints, // Include data points
            pollInterval: s.pollInterval,
            deploymentStatus: s.deploymentStatus || 'draft',
            lastDeployedAt: null,
            deploymentError: null,
            deploymentAttempts: 0,
          };
        });
      
      console.log(`[fetchSensors] Found ${pendingSensors.length} pending devices to display`);
      console.log('[fetchSensors] 📊 Final pendingSensors status:', pendingSensors.map((s: any) => ({ name: s.name, status: s.deploymentStatus })));
      
      // Sort devices to show pending at top (recently deployed), then deployed, then others
      const sortedDevices = [...devices].sort((a, b) => {
        const statusOrder = { 'pending': 0, 'deployed': 1, 'failed': 2 };
        const aOrder = statusOrder[a.deploymentStatus as keyof typeof statusOrder] ?? 3;
        const bOrder = statusOrder[b.deploymentStatus as keyof typeof statusOrder] ?? 3;
        return aOrder - bOrder;
      });
      
      // Fetch virtual devices
      let virtualDevices: Sensor[] = [];
      try {
        const virtualResponse = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/virtual-devices`));
        if (virtualResponse.ok) {
          const virtualData = await virtualResponse.json();
          virtualDevices = (virtualData.virtualDevices || []).map((vd: any) => ({
            uuid: vd.uuid,
            name: vd.name,
            state: 'CONNECTED', // Virtual devices are always "connected" since they're sidecars
            healthy: true,
            messagesPublished: 0,
            lastActivity: null,
            lastError: null,
            configured: true,
            enabled: true,
            type: 'virtual' as const,
            protocol: vd.protocol,
            connected: true,
            isVirtual: true,
            virtualProfile: vd.profile,
            virtualImage: vd.image,
            virtualConnection: vd.connection,
            deploymentStatus: 'deployed', // Virtual devices created via API are immediately deployed
          }));
          console.log(`[fetchSensors] Found ${virtualDevices.length} virtual devices`);
        }
      } catch (virtualErr) {
        console.warn('[fetchSensors] Failed to fetch virtual devices:', virtualErr);
        // Don't fail the whole request if virtual devices fail
      }

      console.log(`[fetchSensors] Merging arrays:`, {
        pendingSensorsCount: pendingSensors.length,
        virtualDevicesCount: virtualDevices.length,
        pipelinesCount: pipelines.length,
        sortedDevicesCount: sortedDevices.length,
        pendingSensorsNames: pendingSensors.map(s => s.name),
        virtualDevicesNames: virtualDevices.map(s => s.name),
        pipelinesNames: pipelines.map(s => s.name),
        sortedDevicesNames: sortedDevices.map(s => s.name)
      });

      // Show newly added devices (DRAFT) at the top, then virtual devices, then sorted physical devices
      setSensors([...pendingSensors, ...virtualDevices, ...pipelines, ...sortedDevices]);
      console.log('[fetchSensors] ✅ COMPLETE - Updated sensors state');
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [deviceUuid, getPendingConfig]);

  useEffect(() => {
    fetchSensors();
    
    // Auto-refresh every 10 seconds to pick up agent status updates
    const interval = setInterval(fetchSensors, 10000);
    
    // Listen for deployment events from Header (Sync button)
    const handleDeploymentStarted = (event: CustomEvent) => {
      if (event.detail.deviceUuid === deviceUuid) {
        console.log('[deployment-started] 🚀 Event received for device:', deviceUuid);
        
        // Refresh immediately to get the database version with pending status
        setTimeout(() => {
          console.log('[deployment-started] 🔄 Fetching sensors to confirm database update');
          fetchSensors();
        }, 500);
      }
    };
    
    window.addEventListener('deployment-started', handleDeploymentStarted as EventListener);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('deployment-started', handleDeploymentStarted as EventListener);
    };
  }, [deviceUuid, fetchSensors]);

  const handleAddProtocolDevice = async (device: any) => {
    try {
      console.log('📝 Validating new device (not persisting yet):', device);
      
      // Call POST /api/v1/devices/:uuid/sensors?validateOnly=true
      // This validates the sensor config without persisting to DB
      const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/sensors?validateOnly=true`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(device),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to validate device: ${response.status}`);
      }

      const result = await response.json();
      console.log('✅ Device validated:', result);

      // Check if API returned validated sensor (validateOnly mode)
      if (!result.sensor) {
        throw new Error('API did not return validated sensor. Please rebuild the API service.');
      }

      // Add to pending state (React only - not in DB yet)
      await addPendingSensor(deviceUuid, result.sensor);

      // Refresh sensor list to show the new sensor from pending state
      await fetchSensors();

      toast.success(`Device "${device.name}" added to pending changes - Click "Save Draft" or "Deploy"`, {
        duration: 4000
      });
    } catch (error: any) {
      console.error('❌ Failed to add device:', error);
      toast.error(`Failed to add device: ${error.message}`);
      throw error;
    }
  };

  const handleUpdateProtocolDevice = async (deviceName: string, updates: any) => {
    try {
      console.log('📝 Validating device updates (not persisting yet):', deviceName, updates);
      
      // Call PUT /api/v1/devices/:uuid/sensors/:name?validateOnly=true
      // This validates updates without persisting to DB
      const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/sensors/${encodeURIComponent(deviceName)}?validateOnly=true`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to validate device: ${response.status}`);
      }

      const result = await response.json();
      console.log('✅ Device updates validated:', result);

      // Check if API returned validated updates (validateOnly mode)
      if (!result.updates) {
        throw new Error('API did not return validated updates. Please rebuild the API service.');
      }

      // Update pending state (React only - not in DB yet)
      await updatePendingSensor(deviceUuid, deviceName, result.updates);

      // Refresh sensor list
      await fetchSensors();

      toast.success(`Sensor "${deviceName}" updated in pending changes - Click "Save Draft" or "Deploy"`, {
        duration: 4000
      });
    } catch (error: any) {
      console.error('❌ Failed to update device:', error);
      toast.error(`Failed to update device: ${error.message}`);
      throw error;
    }
  };

  const handleDeleteProtocolDevice = async (deviceName: string) => {
    // Check if this is a virtual device
    const sensor = sensors.find(s => s.name === deviceName);
    if (sensor && (sensor.type === 'virtual' || sensor.isVirtual)) {
      // Virtual devices use direct delete
      if (sensor.uuid) {
        await handleDeleteVirtualDevice(sensor.uuid, deviceName);
      }
      return;
    }

    // Physical devices use soft delete
    try {
      console.log('🗑️ Marking sensor for deletion via API:', deviceName);
      
      // Call DELETE /api/v1/devices/:uuid/sensors/:name API endpoint
      // This performs a SOFT DELETE - marks for deletion, waits for agent confirmation
      const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/sensors/${encodeURIComponent(deviceName)}`), {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to delete sensor: ${response.status}`);
      }

      const result = await response.json();
      console.log('✅ Sensor marked for deletion:', result);

      // Refresh sensor list to show pending_deletion status
      await fetchSensors();

      toast.success(`Sensor "${deviceName}" marked for deletion - Click Sync to confirm on agent`);
    } catch (error: any) {
      console.error('❌ Failed to delete sensor:', error);
      toast.error(`Failed to delete sensor: ${error.message}`);
      throw error;
    }
  };

  const handleToggleSensorEnabled = async (sensor: Sensor, currentEnabled: boolean) => {
    try {
      const newEnabled = !currentEnabled;
      
      console.log(`[Toggle] Toggling sensor "${sensor.name}" (UUID: ${sensor.uuid}) from ${currentEnabled} to ${newEnabled}`);
      
      // Build the update payload
      const updates = {
        uuid: sensor.uuid,
        name: sensor.name,
        enabled: newEnabled
      };
      
      // Update pending changes (React state only - not saved to DB yet)
      await updatePendingSensor(deviceUuid, sensor.name, updates);
      
      console.log('[Toggle] Updated pending state - Click "Save Draft" to persist or "Deploy" to deploy');
      
      // Refresh sensor list to show updated state from pending changes
      await fetchSensors();

      toast.success(`Device "${sensor.name}" ${newEnabled ? 'enabled' : 'disabled'} - Click "Save Draft" or "Deploy"`, {
        duration: 4000
      });
    } catch (error: any) {
      console.error('Toggle device error:', error);
      toast.error(`Failed to toggle device: ${error.message}`);
    }
  };

  // Virtual Device Management Functions
  const fetchProfiles = async (protocol: string) => {
    try {
      const response = await fetch(buildApiUrl(`/api/v1/profiles?protocol=${protocol}`));
      if (!response.ok) throw new Error('Failed to fetch profiles');
      const data = await response.json();
      setProfiles(data || []);
      
      // Auto-select first profile if available
      if (data && data.length > 0 && !virtualFormData.profile) {
        setVirtualFormData(prev => ({ ...prev, profile: data[0].profile_name }));
      }
    } catch (err) {
      console.error('Failed to fetch profiles:', err);
      toast.error('Failed to fetch profiles');
    }
  };

  const handleOpenVirtualDeviceDialog = () => {
    const virtualCount = sensors.filter(s => s.type === 'virtual').length;
    
    setVirtualFormData({
      name: `Virtual ${virtualFormData.protocol.toUpperCase()} Device ${virtualCount + 1}`,
      protocol: 'modbus',
      profile: '',
      slaveCount: 40,
    });
    
    // Fetch profiles for default protocol
    fetchProfiles('modbus');
    
    setAddVirtualDeviceDialogOpen(true);
  };

  const handleCreateVirtualDevice = async () => {
    setVirtualDeviceLoading(true);

    try {
      const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/virtual-devices`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(virtualFormData),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create virtual device');
      }
      
      toast.success('Virtual device created successfully');
      
      // Refresh sensor list
      await fetchSensors();
      
      // Close dialog
      setAddVirtualDeviceDialogOpen(false);
    } catch (err) {
      console.error('Failed to create virtual device:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to create virtual device');
    } finally {
      setVirtualDeviceLoading(false);
    }
  };

  const handleDeleteVirtualDevice = async (virtualDeviceUuid: string, name: string) => {
    if (!confirm(`Delete virtual device "${name}"?`)) {
      return;
    }

    try {
      const response = await fetch(
        buildApiUrl(`/api/v1/devices/${deviceUuid}/virtual-devices/${virtualDeviceUuid}`),
        { method: 'DELETE' }
      );

      if (!response.ok) throw new Error('Failed to delete virtual device');
      
      toast.success('Virtual device deleted');
      
      // Refresh sensor list
      await fetchSensors();
    } catch (err) {
      console.error('Failed to delete virtual device:', err);
      toast.error('Failed to delete virtual device');
    }
  };

  // Fetch profiles when protocol changes
  useEffect(() => {
    if (virtualFormData.protocol && addVirtualDeviceDialogOpen) {
      fetchProfiles(virtualFormData.protocol);
    }
  }, [virtualFormData.protocol, addVirtualDeviceDialogOpen]);

  /**
   * Simplified status badge - shows what users need to know
   * Priority: Deployment actions → Disabled state → Health status
   */
  const getStatusBadge = (sensor: Sensor) => {
    const deploymentStatus = sensor.deploymentStatus;
    
    // Virtual device badge (always show for virtual devices)
    if (sensor.type === 'virtual' || sensor.isVirtual) {
      return <Badge className="bg-purple-600 dark:bg-purple-700 text-white border border-purple-700 dark:border-purple-600 font-semibold">Virtual</Badge>;
    }
    
    // 1. Deployment lifecycle states (require user action - highest priority)
    
    if (deploymentStatus === 'draft') {
      return <Badge className="bg-zinc-700 dark:bg-zinc-600 text-white border border-zinc-800 dark:border-zinc-500">Draft</Badge>;
    }
    

    // When user toggles, deploymentStatus becomes 'pending' to prevent overwrite
    if (deploymentStatus === 'pending') {
      console.log(`[Badge] "${sensor.name}" - Showing "Pending" (deploymentStatus=${deploymentStatus})`);
      return (
        <span 
          className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold border"
          style={{ backgroundColor: '#ca8a04', color: 'white', borderColor: '#a16207' }}
        >
          Pending
        </span>
      );
    }
    
    
    if (deploymentStatus === 'failed') {
      return <Badge className="bg-red-600 dark:bg-red-700 text-white border border-red-700 dark:border-red-600 font-semibold">Deploy Failed</Badge>;
    }
    
    // Pending deletion (marked for deletion, waiting for agent to confirm)
    if (deploymentStatus === 'pending_deletion') {
      return <Badge className="bg-gray-500 dark:bg-gray-600 text-white border border-gray-600 dark:border-gray-500">Pending Deletion</Badge>;
    }

    
    // 2. Disabled state (toggle is off - don't show health indicators)
    if (!sensor.enabled) {
      return <Badge className="bg-gray-500 dark:bg-gray-600 text-white border border-gray-600 dark:border-gray-500">Disabled</Badge>;
    }
    
    // 3. Health status (only for enabled sensors)
    // Error state (has explicit errors)
    if (sensor.lastError || (sensor.health && sensor.health.errorCount > 0)) {
      return <Badge className="bg-red-500 dark:bg-red-600 text-white border border-red-600 dark:border-red-500 font-semibold">Error</Badge>;
    }
    
    // Active (healthy and connected)
    if (sensor.state === 'CONNECTED' && sensor.healthy) {
      return <Badge className="bg-green-500 dark:bg-green-600 text-white border border-green-600 dark:border-green-500 font-semibold">Active</Badge>;
    }
    
    // Offline (not healthy or not connected, but enabled)
    if (!sensor.healthy || sensor.state === 'DISCONNECTED') {
      return <Badge className="bg-orange-500 dark:bg-orange-600 text-white border border-orange-600 dark:border-orange-500 font-semibold">Offline</Badge>;
    }
    
    // Fallback
    return <Badge variant="outline" className="bg-muted text-muted-foreground border-border">Unknown</Badge>;
  };

  if (loading) {
    return (
      <div className="flex-1 bg-background overflow-auto">
        <div className="flex items-center justify-center min-h-[400px]">
          <Activity className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Devices</h1>
            <p className="text-sm text-muted-foreground">
              Monitor your connected devices
            </p>
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>Failed to load endpoints: {error}</AlertDescription>
          </Alert>
        )}

        {/* Summary Cards */}
        {sensors.length > 0 && (
          <SensorSummaryCards 
            summary={{
              total: sensors.length,
              online: sensors.filter(s => s.state === 'CONNECTED' && s.healthy).length,
              offline: sensors.filter(s => s.state === 'DISCONNECTED' || s.state === 'PENDING').length,
              errors: sensors.filter(s => s.lastError && s.state !== 'PENDING').length,
            }}
          />
        )}

        {/* Protocol Filter with Add Device Button */}
        <div className="flex items-center justify-between gap-4">
          {sensors.length > 0 ? (
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-foreground">Protocol:</label>
                <select 
                  value={selectedProtocol} 
                  onChange={(e) => setSelectedProtocol(e.target.value)}
                  className="border border-border rounded-md px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="all">All ({sensors.length})</option>
                  {Array.from(new Set(sensors.map(s => s.protocol).filter(Boolean))).sort().map(protocol => (
                    <option key={protocol} value={protocol}>
                      {protocol?.toUpperCase()} ({sensors.filter(s => s.protocol === protocol).length})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-foreground">Status:</label>
                <select 
                  value={selectedStatus} 
                  onChange={(e) => setSelectedStatus(e.target.value)}
                  className="border border-border rounded-md px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="all">All ({sensors.length})</option>
                  <option value="CONNECTED">Connected ({sensors.filter(s => s.state === 'CONNECTED').length})</option>
                  <option value="DISCONNECTED">Disconnected ({sensors.filter(s => s.state === 'DISCONNECTED').length})</option>
                  <option value="PENDING">Pending ({sensors.filter(s => s.state === 'PENDING').length})</option>
                  <option value="healthy">Healthy ({sensors.filter(s => s.healthy).length})</option>
                  <option value="unhealthy">Unhealthy ({sensors.filter(s => !s.healthy && s.state !== 'PENDING').length})</option>
                </select>
              </div>

              {(selectedProtocol !== 'all' || selectedStatus !== 'all') && (
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={() => {
                    setSelectedProtocol('all');
                    setSelectedStatus('all');
                  }}
                  className="text-sm"
                >
                  Clear Filters
                </Button>
              )}
            </div>
          ) : (
            <div></div>
          )}
          
          <div className="flex gap-2">
            <Button onClick={() => setAddSensorDialogOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Add Device
            </Button>
            {deviceType === 'virtual' && (
              <Button onClick={handleOpenVirtualDeviceDialog}>
                <Plus className="w-4 h-4 mr-2" />
                Add Virtual Device
              </Button>
            )}
          </div>
        </div>

       
        {/* Sensors List */}
        <Card>
          <CardHeader>
            <CardTitle>Configured Devices</CardTitle>
            <CardDescription>
              {sensors.length === 0 
                ? 'No devices configured yet.' 
                : (() => {
                    const filtered = sensors
                      .filter(s => selectedProtocol === 'all' || s.protocol === selectedProtocol)
                      .filter(s => {
                        if (selectedStatus === 'all') return true;
                        if (selectedStatus === 'healthy') return s.healthy;
                        if (selectedStatus === 'unhealthy') return !s.healthy && s.state !== 'PENDING';
                        return s.state === selectedStatus;
                      });
                    
                    const hasFilters = selectedProtocol !== 'all' || selectedStatus !== 'all';
                    return hasFilters 
                      ? `${filtered.length} of ${sensors.length} device(s) matching filters`
                      : `${sensors.length} device(s) configured`;
                  })()}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sensors.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Activity className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-lg font-medium mb-2">No devices yet</p>
               
              </div>
            ) : (
              <div className="space-y-3">
                {sensors
                  .filter(sensor => selectedProtocol === 'all' || sensor.protocol === selectedProtocol)
                  .filter(sensor => {
                    if (selectedStatus === 'all') return true;
                    if (selectedStatus === 'healthy') return sensor.healthy;
                    if (selectedStatus === 'unhealthy') return !sensor.healthy && sensor.state !== 'PENDING';
                    return sensor.state === selectedStatus;
                  })
                  .map((sensor) => (
                  <div key={sensor.name}>
                    {/* Sensor Row */}
                    <div
                      className="flex items-center justify-between p-4 border border-border rounded-lg hover:border-muted-foreground/20 transition-colors"
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <h3 className="text-lg font-semibold text-foreground">{sensor.name}</h3>
                          {getStatusBadge(sensor)}
                          {sensor.protocol && (
                            <Badge variant="outline" className="text-xs">
                              {sensor.protocol.toUpperCase()}
                            </Badge>
                          )}
                          {sensor.dataPoints && sensor.dataPoints.length > 0 && (
                            <Badge variant="secondary" className="text-xs">
                              {sensor.dataPoints.length} data point{sensor.dataPoints.length !== 1 ? 's' : ''}
                            </Badge>
                          )}
                        </div>
                      
                        <div className="flex flex-wrap gap-6 text-sm text-muted-foreground">
                          {sensor.type === 'pipeline' && (
                            <div>
                              <span className="font-medium">Messages Published:</span>{' '}
                              {sensor.messagesPublished.toLocaleString()}
                            </div>
                          )}
                          <div>
                            <span className="font-medium">Last Activity:</span>{' '}
                            {sensor.lastActivity 
                              ? new Date(sensor.lastActivity).toLocaleString()
                              : 'Never'}
                          </div>
                          {sensor.health && sensor.health.errorCount > 0 && (
                            <div>
                              <span className="font-medium">Error Count:</span>{' '}
                              <span className="text-red-600 font-semibold">{sensor.health.errorCount}</span>
                            </div>
                          )}
                          {sensor.type === 'device' && sensor.lastDeployedAt && (
                            <div>
                              <span className="font-medium">Last Deployed:</span>{' '}
                              {new Date(sensor.lastDeployedAt).toLocaleString()}
                            </div>
                          )}
                          {sensor.type === 'device' && sensor.deploymentAttempts !== undefined && sensor.deploymentAttempts > 1 && (
                            <div>
                              <span className="font-medium">Deploy Attempts:</span>{' '}
                              {sensor.deploymentAttempts}
                            </div>
                          )}
                        </div>

                        {sensor.lastError && sensor.state !== 'PENDING' && (
                          <div className="mt-2 text-sm text-red-600">
                            <span className="font-medium">Error:</span> {sensor.lastError}
                          </div>
                        )}

                        {sensor.deploymentError && (
                          <div className="mt-2 text-sm text-red-600">
                            <span className="font-medium">Deployment Error:</span> {sensor.deploymentError}
                          </div>
                        )}
                        
                        {sensor.state === 'PENDING' && (
                          <div className="mt-2 text-sm text-yellow-600">
                            <span className="font-medium">Status:</span> Waiting for agent to initialize sensor...
                          </div>
                        )}
                      </div>
                      
                      {/* Action Buttons */}
                      <div className="flex items-center gap-3 ml-4">
                        {/* Enable/Disable Select - only show for deployed sensors */}
                        {sensor.type === 'device' && 
                         sensor.deploymentStatus !== 'draft' && (
                          <select
                            value={sensor.enabled !== undefined ? (sensor.enabled ? 'enabled' : 'disabled') : 'enabled'}
                            onChange={(e) => handleToggleSensorEnabled(sensor, e.target.value === 'enabled')}
                            className="h-8 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                          >
                            <option value="enabled">Enabled</option>
                            <option value="disabled">Disabled</option>
                          </select>
                        )}
                        
                        {/* Edit Button */}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSelectedSensor(sensor);
                            setDetailsDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4 mr-2" />
                          Edit
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Add Sensor Dialog */}
        <AddSensorDialog
          open={addSensorDialogOpen}
          onOpenChange={setAddSensorDialogOpen}
          onSaveDevice={handleAddProtocolDevice}
          deviceUuid={deviceUuid}
        />

        {/* Edit Sensor Dialog */}
        <EditSensorDialog
          open={detailsDialogOpen}
          onOpenChange={setDetailsDialogOpen}
          onUpdateDevice={handleUpdateProtocolDevice}
          onDeleteDevice={handleDeleteProtocolDevice}
          device={selectedSensor}
        />

        {/* Add Virtual Device Dialog */}
        <Dialog open={addVirtualDeviceDialogOpen} onOpenChange={setAddVirtualDeviceDialogOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Add Virtual Device</DialogTitle>
              <DialogDescription>
                Virtual devices are protocol simulators that run as sidecar containers.
                The agent connects to them via localhost just like physical devices.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="virtual-name">Device Name</Label>
                <Input
                  id="virtual-name"
                  value={virtualFormData.name}
                  onChange={(e) => setVirtualFormData({ ...virtualFormData, name: e.target.value })}
                  placeholder="e.g., Virtual PLC 1"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="virtual-protocol">Protocol</Label>
                <Select
                  value={virtualFormData.protocol}
                  onValueChange={(value) => setVirtualFormData({ ...virtualFormData, protocol: value, profile: '' })}
                >
                  <SelectTrigger id="virtual-protocol">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="modbus">Modbus TCP</SelectItem>
                    <SelectItem value="opcua">OPC-UA</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="virtual-profile">Profile</Label>
                <Select
                  value={virtualFormData.profile}
                  onValueChange={(value) => setVirtualFormData({ ...virtualFormData, profile: value })}
                  disabled={profiles.length === 0}
                >
                  <SelectTrigger id="virtual-profile">
                    <SelectValue placeholder="Select a profile" />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles.map((profile) => (
                      <SelectItem key={profile.profile_name} value={profile.profile_name}>
                        {profile.profile_name} ({profile.data_points?.length || 0} data points)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {virtualFormData.protocol === 'modbus' && (
                <div className="space-y-2">
                  <Label htmlFor="virtual-slaveCount">Slave Count</Label>
                  <Input
                    id="virtual-slaveCount"
                    type="number"
                    value={virtualFormData.slaveCount}
                    onChange={(e) => setVirtualFormData({ ...virtualFormData, slaveCount: parseInt(e.target.value) })}
                  />
                  <p className="text-sm text-muted-foreground">
                    Number of Modbus slave IDs to simulate
                  </p>
                </div>
              )}

              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  <div className="font-medium mb-1">Auto-Configuration:</div>
                  <ul className="list-disc list-inside space-y-1 text-sm">
                    <li>Port will be auto-assigned (502, 503, 504... for Modbus)</li>
                    <li>
                      Agent will connect via localhost:
                      {sensors.filter(s => s.type === 'virtual' && s.protocol === 'modbus').length === 0 
                        ? '502' 
                        : `${502 + sensors.filter(s => s.type === 'virtual' && s.protocol === 'modbus').length}`}
                    </li>
                    <li>Data points defined by selected profile</li>
                  </ul>
                </AlertDescription>
              </Alert>
            </div>

            <DialogFooter>
              <Button 
                variant="outline" 
                onClick={() => setAddVirtualDeviceDialogOpen(false)} 
                disabled={virtualDeviceLoading}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateVirtualDevice}
                disabled={virtualDeviceLoading || !virtualFormData.name || !virtualFormData.profile}
              >
                {virtualDeviceLoading ? 'Creating...' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};
