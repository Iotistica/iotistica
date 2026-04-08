/**
 * Sensors Page - User-Friendly Sensor Management
 * Hides technical pipeline details, focuses on sensor configuration and status
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Activity, ChevronDown, ChevronRight, Pencil, Plus, FileText, Copy } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AddSensorDialog } from '@/components/devices/AddDeviceDialog';
import { EditSensorDialog } from '@/components/devices/EditDeviceDialog';
import { EditProfileDialog } from '@/components/devices/EditProfileDialog';
import { AnomalyMetricsTable } from '@/components/monitoring/AnomalyMetricsTable';
import { SensorSummaryCards } from '@/components/devices/DeviceSummaryCards';
import { toast } from 'sonner';
import { buildApiUrl } from '@/config/api';
import { Device } from "../components/AgentSidebar";
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
  configId?: string;
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
  connection?: Record<string, any>;
  dataPoints?: ModbusDataPoint[] | OPCUADataPoint[]; // Protocol-specific data points
  metadata?: Record<string, any>;
  pollInterval?: number | null; // Poll interval in milliseconds
  // Deployment tracking fields
  deploymentStatus?: 'pending' | 'deployed' | 'deploying' | 'failed' | 'draft' | 'pending_deletion' | 'deleted';
  lastDeployedAt?: string | null;
  deploymentError?: string | null;
  deploymentAttempts?: number;
  // Health metrics from endpoints table
  health?: {
    status: string;
    connected: boolean;
    lastPoll: string | null;
    errorCount: number;
    lastError: string | null;
    updatedAt: string | null;
    lastTelemetryAt: string | null;
  } | null;
  // Virtual device fields
  isVirtual?: boolean;
  virtualProfile?: string;
  virtualImage?: string;
  virtualConnection?: {
    host: string;
    port: number;
  };
  childCount?: number;
  children?: ChildDevice[];
}

interface ChildDevice {
  uuid: string;
  endpointUuid: string;
  name: string;
  protocol: string;
  identifier: string | null;
  enabled: boolean;
  lastSeenAt: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface Profile {
  profile_name: string;
  protocol: string;
  data_points: any[];
  metadata?: {
    description?: string;
    [key: string]: any;
  };
  created_at?: string;
  updated_at?: string;
}

export const SensorsPage: React.FC<SensorsPageProps> = ({ 
  deviceUuid,
  deviceType
}) => {
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addSensorDialogOpen, setAddSensorDialogOpen] = useState(false);
  const anomalyAddRef = useRef<(() => void) | undefined>(undefined);
  const [anomalyFilterDevice, setAnomalyFilterDevice] = useState<string>('all');
  const [anomalyFilterMethod, setAnomalyFilterMethod] = useState<string>('all');
  const [anomalyDeviceOptions, setAnomalyDeviceOptions] = useState<string[]>([]);
  const [anomalyMethodOptions, setAnomalyMethodOptions] = useState<string[]>([]);
  const [anomalyMetricsSummary, setAnomalyMetricsSummary] = useState<{ total: number; filtered: number }>({ total: 0, filtered: 0 });
  const [selectedSensor, setSelectedSensor] = useState<Sensor | null>(null);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [expandedSensors, setExpandedSensors] = useState<Record<string, boolean>>({});
  
  // Load filter preferences from localStorage
  const getStoredFilter = (key: string, defaultValue: string[]) => {
    try {
      const stored = localStorage.getItem(`sensors-filter-${key}-${deviceUuid}`);
      if (!stored) return defaultValue;
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed : defaultValue;
    } catch {
      return defaultValue;
    }
  };

  const [selectedProtocol, setSelectedProtocol] = useState<string[]>(() => getStoredFilter('protocol', []));
  const [selectedStatus, setSelectedStatus] = useState<string[]>(() => getStoredFilter('status', []));
  const [selectedType, setSelectedType] = useState<string[]>(() => getStoredFilter('type', []));
  const { getDeviceState, updatePendingSensor, addPendingSensor } = useDeviceState();

  // Persist filter changes to localStorage
  useEffect(() => {
    localStorage.setItem(`sensors-filter-protocol-${deviceUuid}`, JSON.stringify(selectedProtocol));
  }, [selectedProtocol, deviceUuid]);

  useEffect(() => {
    localStorage.setItem(`sensors-filter-status-${deviceUuid}`, JSON.stringify(selectedStatus));
  }, [selectedStatus, deviceUuid]);

  useEffect(() => {
    localStorage.setItem(`sensors-filter-type-${deviceUuid}`, JSON.stringify(selectedType));
  }, [selectedType, deviceUuid]);

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

  // Profile management states
  const [addProfileDialogOpen, setAddProfileDialogOpen] = useState(false);
  const [editingProfileName, setEditingProfileName] = useState<string | null>(null);
  const [profileFormData, setProfileFormData] = useState({
    profile_name: '',
    protocol: 'modbus',
    description: '',
    data_points: '[]'
  });
  const [profileLoading, setProfileLoading] = useState(false);
  const [dataPointsError, setDataPointsError] = useState('');
  const [activeTab, setActiveTab] = useState('devices');
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [profileProtocolFilter, setProfileProtocolFilter] = useState<string>('all');

  // Protocol-specific data point templates
  const PROTOCOL_TEMPLATES: Record<string, any[]> = {
    modbus: [
      {
        name: 'example_register',
        address: 100,
        type: 'holding',
        dataType: 'uint16',
        unit: '',
        scale: 1,
        displayName: 'Example Register'
      }
    ],
    opcua: [
      {
        folder: 'Production',
        prefix: 'Sensor_',
        model: 'temperature',
        count: 3,
        unit: '°C',
        config: { min: -50, max: 150 }
      },
      {
        folder: 'Production',
        prefix: 'Sensor_',
        model: 'pressure',
        count: 2,
        unit: 'mbar',
        config: { min: 0, max: 2000 }
      },
      {
        folder: 'Production',
        prefix: 'Sensor_',
        model: 'flow',
        count: 2,
        unit: 'L/min',
        config: { min: 0, max: 1000 }
      }
    ],
    mqtt: [
      {
        name: 'temperature',
        topic: 'sim/generic/temperature',
        qos: 0,
        dataType: 'float',
        unit: '°C',
        base: 22,
        noise_pct: 0.05,
        period_s: 30,
        min: -10,
        max: 60
      },
      {
        name: 'humidity',
        topic: 'sim/generic/humidity',
        qos: 0,
        dataType: 'float',
        unit: '%RH',
        base: 55,
        noise_pct: 0.05,
        period_s: 30,
        min: 0,
        max: 100
      }
    ],
    can: [
      {
        name: 'example_signal',
        messageId: '0x100',
        signalName: 'ExampleSignal',
        startBit: 0,
        length: 16,
        dataType: 'uint16'
      }
    ]
  };

  const fetchSensors = useCallback(async () => {
    try {
      const response = await fetch(buildApiUrl(`/api/v1/agents/${deviceUuid}/devices`));
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

      const getSensorIdentity = (sensor: any) => {
        const explicitId = sensor?.uuid || sensor?.configId || sensor?.id;
        return explicitId ? String(explicitId) : '';
      };

      const getSensorLogicalKey = (sensor: any) => {
        const protocol = String(sensor?.protocol || '').trim().toLowerCase();
        const name = String(sensor?.name || '').trim().toLowerCase();
        return `${protocol}:${name}`;
      };

      const getPendingDiffReasons = (pendingSensor: any, deployedSensor: any): string[] => {
        const pendingEnabled = pendingSensor.enabled !== undefined ? pendingSensor.enabled : true;
        const deployedEnabled = deployedSensor.enabled !== undefined ? deployedSensor.enabled : true;
        const pendingDataPoints = pendingSensor.dataPoints ?? pendingSensor.data_points;
        const deployedDataPoints = deployedSensor.dataPoints ?? deployedSensor.data_points;
        const reasons: string[] = [];

        if (pendingSensor.name !== deployedSensor.name) reasons.push('name_mismatch');
        if (pendingSensor.protocol !== deployedSensor.protocol) reasons.push('protocol_mismatch');
        if (pendingEnabled !== deployedEnabled) reasons.push('enabled_mismatch');
        if ((pendingSensor.pollInterval ?? null) !== (deployedSensor.pollInterval ?? null)) reasons.push('poll_interval_mismatch');
        if (JSON.stringify(pendingSensor.connection || {}) !== JSON.stringify(deployedSensor.connection || {})) reasons.push('connection_mismatch');
        // Only compare data points when pending payload explicitly includes them.
        // Some target-state payloads omit data points for unchanged endpoints.
        if (pendingDataPoints !== undefined && pendingDataPoints !== null) {
          if (JSON.stringify(pendingDataPoints || []) !== JSON.stringify(deployedDataPoints || [])) {
            reasons.push('data_points_mismatch');
          }
        }

        return reasons;
      };

      const hasPendingChanges = (pendingSensor: any, deployedSensor: any) => {
        return getPendingDiffReasons(pendingSensor, deployedSensor).length > 0;
      };
      
      
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
        
        return {
          uuid: d.uuid || d.configId, // Use uuid from table, fallback to configId
          configId: d.configId,
          name: d.name,
          state: isConnected ? 'CONNECTED' : 'DISCONNECTED',
          healthy: health ? (health.status === 'healthy' || health.connected) : d.connected,
          messagesPublished: 0, // Protocol adapters don't track messages
          lastActivity: health?.lastTelemetryAt || null,
          lastError: health?.lastError || d.lastError,
          configured: true,
          enabled: d.enabled !== undefined ? d.enabled : true, // Default to enabled
          type: d.metadata?.sidecar === true ? 'virtual' : 'device',
          protocol: d.protocol,
          connected: isConnected,
          connection: d.connection, // Full connection configuration
          dataPoints: d.dataPoints || d.data_points || [], // Data points configuration
          metadata: d.metadata || {},
          pollInterval: d.pollInterval, // Poll interval
          // Virtual device fields (populated from metadata.sidecar)
          isVirtual: d.metadata?.sidecar === true,
          virtualProfile: d.metadata?.profile,
          virtualImage: d.metadata?.image,
          virtualConnection: d.connection, // Connection is already in the right format
          // Deployment tracking
          deploymentStatus: d.deploymentStatus || d.deployment_status,
          lastDeployedAt: d.lastDeployedAt,
          deploymentError: d.deploymentError,
          deploymentAttempts: d.deploymentAttempts,
          childCount: d.childCount || 0,
          children: Array.isArray(d.children) ? d.children : [],
          // Health metrics
          health: health ? {
            status: health.status,
            connected: health.connected,
            lastPoll: health.lastPoll,
            errorCount: health.errorCount,
            lastError: health.lastError,
            updatedAt: health.updatedAt,
            lastTelemetryAt: health.lastTelemetryAt
          } : null,
        };
      });

      // Get pending devices from config (devices not yet deployed)
      const deviceState = getDeviceState(deviceUuid);
      const rawEndpoints = deviceState?.isDirty
        ? (deviceState.pendingChanges?.config?.endpoints || [])
        : [];
      
      // NOTE: Discovery parents are automatically removed from target state config by API
      // when their slaves are discovered. So we just display what's in the config.
      const pendingEndpoints = rawEndpoints;

      const pendingSensors = pendingEndpoints
        .filter((s: any) => {
          const pendingIdentity = getSensorIdentity(s);
          const matchingDevice = devices.find((d: any) => getSensorIdentity(d) === pendingIdentity);

          if (!matchingDevice) {
            return true;
          }

          return hasPendingChanges(s, matchingDevice);
        })
        .map((s: any) => {
          return {
            uuid: s.uuid || s.configId || s.id,
            configId: s.configId || s.uuid || s.id,
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
            dataPoints: s.dataPoints || s.data_points, // Include data points (camelCase/snake_case)
            metadata: s.metadata || {},
            pollInterval: s.pollInterval,
            deploymentStatus: s.deploymentStatus || 'draft',
            lastDeployedAt: null,
            deploymentError: null,
            deploymentAttempts: 0,
          };
        });

      // All deployed devices are shown (no filtering needed since API handles removal of discovery parents)
      const sortedDevices = [...devices].sort((a, b) => {
        const statusOrder = { 'pending': 0, 'deployed': 1, 'failed': 2 };
        const aOrder = statusOrder[a.deploymentStatus as keyof typeof statusOrder] ?? 3;
        const bOrder = statusOrder[b.deploymentStatus as keyof typeof statusOrder] ?? 3;
        return aOrder - bOrder;
      });

      const pendingSensorIds = new Set(pendingSensors.map((sensor: any) => getSensorIdentity(sensor)));
      const pendingSensorLogicalKeys = new Set(pendingSensors.map((sensor: any) => getSensorLogicalKey(sensor)));
      const mergedDevices = sortedDevices.filter((sensor: any) => {
        const byId = pendingSensorIds.has(getSensorIdentity(sensor));
        const byLogicalKey = pendingSensorLogicalKeys.has(getSensorLogicalKey(sensor));
        return !(byId || byLogicalKey);
      });
      
      // Virtual devices now come through regular devices endpoint (no separate fetch needed)
      // They have metadata.sidecar === true

      // Show newly added devices (DRAFT) at the top, then sorted devices (includes virtual devices now)
      setSensors([...pendingSensors, ...pipelines, ...mergedDevices]);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [deviceUuid, getDeviceState]);

  useEffect(() => {
    fetchSensors();
    
    // Auto-refresh every 10 seconds to pick up agent status updates
    const interval = setInterval(fetchSensors, 10000);
    
    // Listen for deployment events from Header (Sync button)
    const handleDeploymentStarted = (event: CustomEvent) => {
      if (event.detail.deviceUuid === deviceUuid) {
        // Fetch immediately to catch discovery target before agent completes discovery
        // Discovery can complete in < 1 second, so we need to be fast
        setTimeout(() => {
          fetchSensors();
        }, 100);
      }
    };
    
    window.addEventListener('deployment-started', handleDeploymentStarted as EventListener);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('deployment-started', handleDeploymentStarted as EventListener);
    };
  }, [deviceUuid, fetchSensors]);

  const handleAddProtocolDevice = async (device: any, options?: any) => {
    try {
      
      // Call POST /api/v1/agents/:uuid/devices?validateOnly=true
      // This validates the sensor config without persisting to DB
      const response = await fetch(buildApiUrl(`/api/v1/agents/${deviceUuid}/devices?validateOnly=true`), {
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

      // Check if API returned validated sensor (validateOnly mode)
      if (!result.sensor) {
        throw new Error('API did not return validated sensor. Please rebuild the API service.');
      }

      if (device.protocol === 'mqtt' && options?.mqttCredentials) {
        result.sensor.connection = {
          ...(result.sensor.connection || {}),
          username: options.mqttCredentials.username,
        };

        result.sensor.metadata = {
          ...(result.sensor.metadata || {}),
        };

        result.sensor.auth = {
          ...(result.sensor.auth || {}),
          mqtt: {
            username: options.mqttCredentials.username,
            password: options.mqttCredentials.password,
            access: options.mqttCredentials.access,
          },
        };
      }

      // Add to pending state (React only - not in DB yet)
      await addPendingSensor(deviceUuid, result.sensor);

      // Refresh sensor list to show the new sensor from pending state
      await fetchSensors();

      toast.success(`Device "${device.name}" added to pending changes - Click "Save Draft" or "Deploy"`, {
        duration: 4000
      });
    } catch (error: any) {
      toast.error(`Failed to add device: ${error.message}`);
      throw error;
    }
  };

  const handleUpdateProtocolDevice = async (deviceName: string, updates: any) => {
    try {
      // Call PUT /api/v1/agents/:uuid/devices/:name?validateOnly=true
      // This validates updates without persisting to DB
      const response = await fetch(buildApiUrl(`/api/v1/agents/${deviceUuid}/devices/${encodeURIComponent(deviceName)}?validateOnly=true`), {
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

    // Physical devices use soft delete and rely on reconciliation for permanent removal
    try {
      
      // Call DELETE /api/v1/agents/:uuid/devices/:name
      // Soft delete marks pending_deletion and waits for agent reconciliation.
      const response = await fetch(buildApiUrl(`/api/v1/agents/${deviceUuid}/devices/${encodeURIComponent(deviceName)}`), {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to delete sensor: ${response.status}`);
      }

      // Refresh sensor list to show pending deletion state
      await fetchSensors();

      toast.success(`Sensor "${deviceName}" marked for deletion - pending agent reconciliation`);
    } catch (error: any) {
      toast.error(`Failed to delete sensor: ${error.message}`);
      throw error;
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
      toast.error('Failed to fetch profiles');
    }
  };

  const fetchAllProfiles = async () => {
    try {
      // Fetch profiles for all protocols
      const protocols = ['modbus', 'opcua', 'mqtt', 'can', 'snmp'];
      const allProfilesData: Profile[] = [];
      
      for (const protocol of protocols) {
        const response = await fetch(buildApiUrl(`/api/v1/profiles?protocol=${protocol}`));
        if (response.ok) {
          const data = await response.json();
          allProfilesData.push(...(data || []));
        }
      }
      
      setAllProfiles(allProfilesData);
    } catch (err) {
      toast.error('Failed to fetch profiles');
    }
  };

  // Lazy-load profiles only when Profiles tab is active.
  useEffect(() => {
    if (activeTab === 'profiles') {
      fetchAllProfiles();
    }
  }, [activeTab]);

  const handleOpenVirtualDeviceDialog = () => {
    const virtualCount = sensors.filter(s => s.type === 'virtual').length;
    
    setVirtualFormData({
      name: `Virtual Device ${virtualCount + 1}`,
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
      const response = await fetch(buildApiUrl(`/api/v1/agents/${deviceUuid}/virtual-devices`), {
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
        buildApiUrl(`/api/v1/agents/${deviceUuid}/virtual-devices/${virtualDeviceUuid}`),
        { method: 'DELETE' }
      );

      if (!response.ok) throw new Error('Failed to delete virtual device');
      
      toast.success('Virtual device deleted');
      
      // Refresh sensor list
      await fetchSensors();
    } catch (err) {
      toast.error('Failed to delete virtual device');
    }
  };

  // Fetch profiles when protocol changes
  useEffect(() => {
    if (virtualFormData.protocol && addVirtualDeviceDialogOpen) {
      fetchProfiles(virtualFormData.protocol);
    }
  }, [virtualFormData.protocol, addVirtualDeviceDialogOpen]);

  // Profile Management Functions
  const handleOpenProfileDialog = () => {
    setProfileFormData({
      profile_name: '',
      protocol: 'modbus',
      description: '',
      data_points: JSON.stringify(PROTOCOL_TEMPLATES.modbus, null, 2)
    });
    setDataPointsError('');
    setAddProfileDialogOpen(true);
  };

  const handleEditProfile = (profile: Profile) => {
    setEditingProfileName(profile.profile_name);
    setProfileFormData({
      profile_name: profile.profile_name,
      protocol: profile.protocol,
      description: profile.metadata?.description || '',
      data_points: JSON.stringify(profile.data_points || [], null, 2)
    });
    setDataPointsError('');
    setAddProfileDialogOpen(true);
  };

  const handleLoadTemplate = () => {
    const template = PROTOCOL_TEMPLATES[profileFormData.protocol] || [];
    setProfileFormData({
      ...profileFormData,
      data_points: JSON.stringify(template, null, 2)
    });
    setDataPointsError('');
  };

  const handleValidateDataPoints = () => {
    try {
      const parsed = JSON.parse(profileFormData.data_points);
      if (!Array.isArray(parsed)) {
        setDataPointsError('Data points must be a JSON array');
        return false;
      }
      
      // OPC UA and SNMP can auto-discover data points - allow empty array
      const autoDiscoveryProtocols = ['opcua', 'snmp'];
      if (parsed.length === 0 && !autoDiscoveryProtocols.includes(profileFormData.protocol)) {
        setDataPointsError('At least one data point is required for Modbus protocol');
        return false;
      }
      
      setDataPointsError('');
      toast.success('Valid JSON!');
      return true;
    } catch (err) {
      setDataPointsError(err instanceof Error ? err.message : 'Invalid JSON');
      return false;
    }
  };

  const handleSaveProfile = async () => {
    // Validate required fields
    if (!profileFormData.profile_name.trim()) {
      toast.error('Profile name is required');
      return;
    }

    if (!profileFormData.protocol) {
      toast.error('Protocol is required');
      return;
    }

    // Validate data points JSON
    let dataPoints;
    try {
      dataPoints = JSON.parse(profileFormData.data_points);
      if (!Array.isArray(dataPoints)) {
        toast.error('Data points must be a JSON array');
        return;
      }
      
      // OPC UA and SNMP can auto-discover data points - allow empty array
      const autoDiscoveryProtocols = ['opcua', 'snmp'];
      if (dataPoints.length === 0 && !autoDiscoveryProtocols.includes(profileFormData.protocol)) {
        toast.error('At least one data point is required for Modbus protocol');
        return;
      }
    } catch (err) {
      toast.error('Invalid JSON in data points');
      return;
    }

    setProfileLoading(true);

    try {
      const payload = {
        profile_name: profileFormData.profile_name.trim(),
        protocol: profileFormData.protocol,
        data_points: dataPoints,
        metadata: profileFormData.description.trim() 
          ? { description: profileFormData.description.trim() }
          : undefined
      };

      const method = editingProfileName ? 'PUT' : 'POST';
      const url = editingProfileName 
        ? buildApiUrl(`/api/v1/profiles/${encodeURIComponent(editingProfileName)}`)
        : buildApiUrl('/api/v1/profiles');

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || `Failed to ${editingProfileName ? 'update' : 'save'} profile`);
      }

      toast.success(`Profile "${profileFormData.profile_name}" ${editingProfileName ? 'updated' : 'saved'} successfully`);
      
      // Refresh profiles list if the same protocol
      if (profileFormData.protocol === virtualFormData.protocol) {
        await fetchProfiles(profileFormData.protocol);
      }
      
      // Refresh all profiles for the Profiles tab
      await fetchAllProfiles();
      
      // Reset edit mode and close dialog
      setEditingProfileName(null);
      setAddProfileDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${editingProfileName ? 'update' : 'save'} profile`);
    } finally {
      setProfileLoading(false);
    }
  };

  /**
   * Simplified status badge - shows what users need to know
   * Priority: Deployment actions → Disabled state → Health status
   * Note: Virtual devices follow same status lifecycle as regular devices
   */
  const getStatusBadge = (sensor: Sensor) => {
    const deploymentStatus = sensor.deploymentStatus;

    const lastPollMs = sensor.health?.lastPoll ? new Date(sensor.health.lastPoll).getTime() : null;
    const lastTelemetryMs = sensor.health?.lastTelemetryAt ? new Date(sensor.health.lastTelemetryAt).getTime() : null;
    const pollIntervalMs = sensor.pollInterval && sensor.pollInterval > 0 ? sensor.pollInterval : null;

    // Mark as no data when polling has happened but telemetry is missing or too far behind polls.
    // Uses both last poll and last telemetry timestamps so connected adapters still surface stale data.
    const isNoData = (() => {
      if (sensor.type !== 'device' || !sensor.enabled || !lastPollMs) {
        return false;
      }

      if (!lastTelemetryMs) {
        return true;
      }

      const telemetryLagMs = lastPollMs - lastTelemetryMs;
      // Allow 5 missed poll cycles, with a minimum floor of 2 minutes, to avoid
      // flipping to No Data due to minor network/processing delays.
      const lagThresholdMs = pollIntervalMs
        ? Math.max(pollIntervalMs * 5, 2 * 60 * 1000)
        : 5 * 60 * 1000;
      return telemetryLagMs > lagThresholdMs;
    })();
    
    // 1. Deployment lifecycle states (require user action - highest priority)
    
    if (deploymentStatus === 'draft') {
      return <Badge className="bg-zinc-700 dark:bg-zinc-600 text-white border border-zinc-800 dark:border-zinc-500">Draft</Badge>;
    }
    

    // When user toggles, deploymentStatus becomes 'pending' to prevent overwrite
    if (deploymentStatus === 'pending') {
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

    if (deploymentStatus === 'deleted') {
      return <Badge className="bg-slate-500 dark:bg-slate-600 text-white border border-slate-600 dark:border-slate-500">Deleted</Badge>;
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

    if (isNoData) {
      return <Badge className="bg-amber-500 dark:bg-amber-600 text-white border border-amber-600 dark:border-amber-500 font-semibold">No Data</Badge>;
    }
    
    // Active (healthy and connected) - Same for all device types
    if (sensor.state === 'CONNECTED' && sensor.healthy) {
      return <Badge className="bg-green-500 dark:bg-green-600 text-white border border-green-600 dark:border-green-500 font-semibold">Active</Badge>;
    }
    
    // Connecting (deployed and enabled but never polled yet - agent still initializing)
    if (!sensor.health?.lastPoll) {
      return <Badge className="bg-blue-500 dark:bg-blue-600 text-white border border-blue-600 dark:border-blue-500 font-semibold">Connecting</Badge>;
    }

    // Offline (not healthy or not connected, but enabled)
    if (!sensor.healthy || sensor.state === 'DISCONNECTED') {
      return <Badge className="bg-orange-500 dark:bg-orange-600 text-white border border-orange-600 dark:border-orange-500 font-semibold">Offline</Badge>;
    }
    
    // Fallback
    return <Badge variant="outline" className="bg-muted text-muted-foreground border-border">Unknown</Badge>;
  };

  const getChildStatusBadge = (child: ChildDevice) => {
    if (!child.enabled) {
      return <Badge className="bg-gray-500 dark:bg-gray-600 text-white border border-gray-600 dark:border-gray-500">Disabled</Badge>;
    }

    if (!child.lastSeenAt) {
      return <Badge variant="outline" className="bg-muted text-muted-foreground border-border">Unknown</Badge>;
    }

    const lastSeenMs = new Date(child.lastSeenAt).getTime();
    const ageMs = Date.now() - lastSeenMs;

    if (ageMs <= 5 * 60 * 1000) {
      return <Badge className="bg-green-500 dark:bg-green-600 text-white border border-green-600 dark:border-green-500 font-semibold">Online</Badge>;
    }

    return <Badge className="bg-amber-500 dark:bg-amber-600 text-white border border-amber-600 dark:border-amber-500 font-semibold">Stale</Badge>;
  };

  const toggleExpandedSensor = (sensorId: string) => {
    setExpandedSensors(prev => ({
      ...prev,
      [sensorId]: !prev[sensorId],
    }));
  };

  const getEndpointUrl = (sensor: Sensor): string | null => {
    const connection = sensor.connection;
    if (!connection || typeof connection !== 'object') {
      return null;
    }

    const protocol = String(sensor.protocol || '').toLowerCase();

    if (protocol === 'opcua' && typeof connection.endpointUrl === 'string' && connection.endpointUrl.trim().length > 0) {
      return connection.endpointUrl.trim();
    }

    if (protocol === 'modbus') {
      if (connection.type === 'tcp' && typeof connection.host === 'string' && connection.host.trim().length > 0) {
        return `modbus-tcp://${connection.host.trim()}${connection.port ? `:${connection.port}` : ''}`;
      }

      if (connection.type === 'rtu' && typeof connection.serialPort === 'string' && connection.serialPort.trim().length > 0) {
        return `serial://${connection.serialPort.trim()}`;
      }
    }

    if (protocol === 'mqtt') {
      if (typeof connection.topic === 'string' && connection.topic.trim().length > 0) {
        return connection.topic.trim();
      }

      if (Array.isArray(connection.topics) && connection.topics.length > 0) {
        return connection.topics.filter((topic: unknown) => typeof topic === 'string' && topic.trim().length > 0).join(', ');
      }
    }

    const directUrl = connection.url || connection.endpoint || connection.uri || connection.brokerUrl;
    if (typeof directUrl === 'string' && directUrl.trim().length > 0) {
      return directUrl.trim();
    }

    const host = connection.host || connection.hostname || connection.server;
    if (!host || typeof host !== 'string') {
      return null;
    }

    const scheme = String(connection.protocol || sensor.protocol || 'tcp').toLowerCase();
    const hasPort = connection.port !== undefined && connection.port !== null && connection.port !== '';
    const base = `${scheme}://${host}${hasPort ? `:${connection.port}` : ''}`;

    const pathOrTopic = connection.path || connection.topic;
    if (typeof pathOrTopic === 'string' && pathOrTopic.trim().length > 0) {
      const suffix = pathOrTopic.startsWith('/') ? pathOrTopic : `/${pathOrTopic}`;
      return `${base}${suffix}`;
    }

    return base;
  };

  const copyEndpointToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Endpoint copied');
    } catch {
      toast.error('Failed to copy endpoint');
    }
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
              offline: sensors.filter(s => s.state === 'DISCONNECTED').length,
              pending: sensors.filter(s => s.state === 'PENDING').length,
              errors: sensors.filter(s => s.lastError && s.state !== 'PENDING').length,
            }}
          />
        )}

        {/* Tabs for Devices and Profiles */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="bg-transparent w-fit h-auto p-0 rounded-none justify-start border-0">
            <TabsTrigger
              value="devices"
              data-testid="devices-tab-trigger"
              className="!flex-none !border-0 bg-transparent rounded-none hover:bg-transparent px-0 pb-2 text-base leading-none font-normal data-[state=active]:font-medium"
              style={
                activeTab === 'devices'
                  ? { color: 'hsl(var(--foreground))', marginRight: '1.5rem', fontWeight: 700, textDecoration: 'underline', textUnderlineOffset: '8px', textDecorationThickness: '2px', textDecorationColor: 'hsl(var(--foreground))' }
                  : { color: 'hsl(var(--foreground))', marginRight: '1.5rem', textDecoration: 'none' }
              }
            >
              Devices
            </TabsTrigger>
            <TabsTrigger
              value="anomaly"
              className="!flex-none !border-0 bg-transparent rounded-none hover:bg-transparent px-0 pb-2 text-base leading-none font-normal data-[state=active]:font-medium"
              style={
                activeTab === 'anomaly'
                  ? { color: 'hsl(var(--foreground))', fontWeight: 700, textDecoration: 'underline', textUnderlineOffset: '8px', textDecorationThickness: '2px', textDecorationColor: 'hsl(var(--foreground))' }
                  : { color: 'hsl(var(--foreground))', textDecoration: 'none' }
              }
            >
              Anomaly Detection
            </TabsTrigger>
          </TabsList>

          {/* Devices Tab */}
          <TabsContent value="devices" className="space-y-6">
        {/* Protocol Filter with Add Device Button */}
        <div className="flex items-center justify-between gap-4">
          {sensors.length > 0 ? (
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-foreground">Protocol:</label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="min-w-[160px] justify-between">
                      {selectedProtocol.length === 0 ? 'All' : `${selectedProtocol.length} selected`}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuCheckboxItem
                      checked={selectedProtocol.length === 0}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(checked) => setSelectedProtocol(checked ? [] : selectedProtocol)}
                    >
                      All ({sensors.length})
                    </DropdownMenuCheckboxItem>
                    {Array.from(new Set(sensors.map(s => s.protocol).filter(Boolean))).sort().map(protocol => (
                      <DropdownMenuCheckboxItem
                        key={protocol}
                        checked={selectedProtocol.includes(protocol as string)}
                        onSelect={(e) => e.preventDefault()}
                        onCheckedChange={(checked) => {
                          setSelectedProtocol(prev =>
                            checked
                              ? [...prev.filter(p => p !== protocol), protocol as string]
                              : prev.filter(p => p !== protocol)
                          );
                        }}
                      >
                        {protocol?.toUpperCase()} ({sensors.filter(s => s.protocol === protocol).length})
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-foreground">Status:</label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="min-w-[160px] justify-between">
                      {selectedStatus.length === 0 ? 'All' : `${selectedStatus.length} selected`}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuCheckboxItem
                      checked={selectedStatus.length === 0}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(checked) => setSelectedStatus(checked ? [] : selectedStatus)}
                    >
                      All ({sensors.length})
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={selectedStatus.includes('CONNECTED')}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(checked) => {
                        setSelectedStatus(prev =>
                          checked ? [...prev.filter(s => s !== 'CONNECTED'), 'CONNECTED'] : prev.filter(s => s !== 'CONNECTED')
                        );
                      }}
                    >
                      Active ({sensors.filter(s => s.state === 'CONNECTED').length})
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={selectedStatus.includes('DISCONNECTED')}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(checked) => {
                        setSelectedStatus(prev =>
                          checked ? [...prev.filter(s => s !== 'DISCONNECTED'), 'DISCONNECTED'] : prev.filter(s => s !== 'DISCONNECTED')
                        );
                      }}
                    >
                      Disconnected ({sensors.filter(s => s.state === 'DISCONNECTED').length})
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={selectedStatus.includes('PENDING')}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(checked) => {
                        setSelectedStatus(prev =>
                          checked ? [...prev.filter(s => s !== 'PENDING'), 'PENDING'] : prev.filter(s => s !== 'PENDING')
                        );
                      }}
                    >
                      Pending ({sensors.filter(s => s.state === 'PENDING').length})
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={selectedStatus.includes('healthy')}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(checked) => {
                        setSelectedStatus(prev =>
                          checked ? [...prev.filter(s => s !== 'healthy'), 'healthy'] : prev.filter(s => s !== 'healthy')
                        );
                      }}
                    >
                      Healthy ({sensors.filter(s => s.healthy).length})
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={selectedStatus.includes('unhealthy')}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(checked) => {
                        setSelectedStatus(prev =>
                          checked ? [...prev.filter(s => s !== 'unhealthy'), 'unhealthy'] : prev.filter(s => s !== 'unhealthy')
                        );
                      }}
                    >
                      Unhealthy ({sensors.filter(s => !s.healthy && s.state !== 'PENDING').length})
                    </DropdownMenuCheckboxItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-foreground">Type:</label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="min-w-[160px] justify-between">
                      {selectedType.length === 0 ? 'All' : `${selectedType.length} selected`}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuCheckboxItem
                      checked={selectedType.length === 0}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(checked) => setSelectedType(checked ? [] : selectedType)}
                    >
                      All ({sensors.length})
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={selectedType.includes('device')}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(checked) => {
                        setSelectedType(prev =>
                          checked ? [...prev.filter(s => s !== 'device'), 'device'] : prev.filter(s => s !== 'device')
                        );
                      }}
                    >
                      Physical ({sensors.filter(s => s.type === 'device').length})
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={selectedType.includes('virtual')}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(checked) => {
                        setSelectedType(prev =>
                          checked ? [...prev.filter(s => s !== 'virtual'), 'virtual'] : prev.filter(s => s !== 'virtual')
                        );
                      }}
                    >
                      Virtual ({sensors.filter(s => s.type === 'virtual').length})
                    </DropdownMenuCheckboxItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {(selectedProtocol.length > 0 || selectedStatus.length > 0 || selectedType.length > 0) && (
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={() => {
                    setSelectedProtocol([]);
                    setSelectedStatus([]);
                    setSelectedType([]);
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
            {deviceType !== 'virtual' && (
              <Button data-testid="add-device-button" onClick={() => setAddSensorDialogOpen(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Add Device
              </Button>
            )}
            {deviceType === 'virtual' && (
              <Button data-testid="add-device-button" onClick={handleOpenVirtualDeviceDialog}>
                <Plus className="w-4 h-4 mr-2" />
                Add Device
              </Button>
            )}
          </div>
        </div>

       
        {/* Sensors List */}
        <Card>
          <CardHeader>
            
            <CardDescription>
              {sensors.length === 0 
                ? 'No devices configured yet.' 
                : (() => {
                    const filtered = sensors
                    .filter(s => selectedProtocol.length === 0 || selectedProtocol.includes(s.protocol || ''))
                    .filter(s => selectedType.length === 0 || selectedType.includes(s.type || ''))
                    .filter(s => {
                      if (selectedStatus.length === 0) return true;
                      if (selectedStatus.includes('healthy') && s.healthy) return true;
                      if (selectedStatus.includes('unhealthy') && !s.healthy && s.state !== 'PENDING') return true;
                      return selectedStatus.includes(s.state);
                    });
                    
                  const hasFilters = selectedProtocol.length > 0 || selectedStatus.length > 0 || selectedType.length > 0;
                    return hasFilters 
                      ? `${filtered.length} of ${sensors.length} device(s) matching filters`
                      : `${sensors.length} device(s) configured`;
                  })()}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sensors.length === 0 ? (
              <div data-testid="devices-empty-state" className="text-center py-12 text-muted-foreground">
                <Activity className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-lg font-medium mb-2">No devices yet</p>
               
              </div>
            ) : (
              <div className="overflow-x-auto" data-testid="devices-table">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="w-10 py-3 px-2"></th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Status</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Name</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Protocol</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Devices</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Poll Interval</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Endpoint</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Last Activity</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Last Poll</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Last Deployed</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Errors</th>
                      <th className="py-3 px-4 font-semibold text-sm text-foreground text-left">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sensors
                      .filter(sensor => selectedProtocol.length === 0 || selectedProtocol.includes(sensor.protocol || ''))
                      .filter(sensor => selectedType.length === 0 || selectedType.includes(sensor.type || ''))
                      .filter(sensor => {
                        if (selectedStatus.length === 0) return true;
                        if (selectedStatus.includes('healthy') && sensor.healthy) return true;
                        if (selectedStatus.includes('unhealthy') && !sensor.healthy && sensor.state !== 'PENDING') return true;
                        return selectedStatus.includes(sensor.state);
                      })
                      .map((sensor) => {
                      const sensorId = sensor.uuid || sensor.configId || sensor.name;
                      const hasChildren = (sensor.childCount || 0) > 0;
                      const isExpanded = !!expandedSensors[sensorId];
                      const endpointUrl = getEndpointUrl(sensor);

                      return (
                      <React.Fragment key={sensorId}>
                      <tr data-testid={`device-row-${sensorId}`} className="border-b border-border last:border-0 hover:bg-muted">
                        <td className="py-3 px-2 align-top">
                          {hasChildren ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => toggleExpandedSensor(sensorId)}
                              aria-label={isExpanded ? 'Collapse child devices' : 'Expand child devices'}
                            >
                              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </Button>
                          ) : null}
                        </td>
                        <td className="py-3 px-4 align-top">
                          <div className="flex items-center gap-2">
                            {getStatusBadge(sensor)}
                            {(sensor.type === 'virtual' || sensor.isVirtual) && (
                              <Badge className="bg-purple-600 dark:bg-purple-700 text-white border border-purple-700 dark:border-purple-600 text-xs font-semibold">
                                Virtual
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 font-medium text-foreground align-top">
                          <div>
                            {sensor.name}
                            {sensor.lastError && sensor.state !== 'PENDING' && (
                              <div className="text-xs text-red-600 mt-0.5 max-w-[200px] truncate" title={sensor.lastError}>
                                {sensor.lastError}
                              </div>
                            )}
                            {sensor.deploymentError && (
                              <div className="text-xs text-red-600 mt-0.5 max-w-[200px] truncate" title={sensor.deploymentError}>
                                {sensor.deploymentError}
                              </div>
                            )}
                            {sensor.state === 'PENDING' && (
                              <div className="text-xs text-yellow-600 mt-0.5">Waiting for agent...</div>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 align-top">
                          {sensor.protocol && (
                            <Badge variant="outline" className="text-xs">
                              {sensor.protocol.toUpperCase()}
                            </Badge>
                          )}
                        </td>
                        <td className="py-3 px-4 text-muted-foreground align-top">
                          {hasChildren ? (
                            <button
                              type="button"
                              className="text-left hover:text-foreground underline-offset-2 hover:underline"
                              onClick={() => toggleExpandedSensor(sensorId)}
                            >
                              {sensor.childCount}
                            </button>
                          ) : '—'}
                        </td>
                        <td className="py-3 px-4 text-muted-foreground align-top">
                          {sensor.pollInterval
                            ? sensor.pollInterval >= 60000
                              ? `${sensor.pollInterval / 60000}m`
                              : `${sensor.pollInterval / 1000}s`
                            : '—'}
                        </td>
                        <td className="py-3 px-4 text-muted-foreground align-top w-[360px] min-w-[360px] max-w-[360px]">
                          <div className="flex items-start gap-2">
                            <span data-testid={`device-endpoint-${sensorId}`} className="block flex-1 truncate" title={endpointUrl || undefined}>
                              {endpointUrl || '—'}
                            </span>
                            {endpointUrl && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 shrink-0"
                                onClick={() => copyEndpointToClipboard(endpointUrl)}
                                title="Copy full endpoint"
                                aria-label="Copy full endpoint"
                              >
                                <Copy className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-muted-foreground align-top">
                          {sensor.health?.lastPoll && sensor.lastActivity ? new Date(sensor.lastActivity).toLocaleString() : '—'}
                        </td>
                        <td className="py-3 px-4 text-muted-foreground align-top">
                          {sensor.type === 'device' && sensor.health?.lastPoll
                            ? new Date(sensor.health.lastPoll).toLocaleString()
                            : '—'}
                        </td>
                        <td className="py-3 px-4 text-muted-foreground align-top">
                          {sensor.type === 'device' && sensor.lastDeployedAt
                            ? new Date(sensor.lastDeployedAt).toLocaleString()
                            : '—'}
                        </td>
                        <td className="py-3 px-4 align-top">
                          {sensor.health && sensor.health.errorCount > 0
                            ? <span className="text-red-600 font-semibold">{sensor.health.errorCount}</span>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-3 px-4 align-top">
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
                        </td>
                      </tr>
                      {hasChildren && isExpanded && (
                        <tr className="border-b border-border bg-muted/30">
                          <td></td>
                          <td colSpan={10} className="px-4 py-4">
                            <div className="rounded-lg border border-border bg-background overflow-hidden">
                              <table className="w-full text-xs sm:text-sm">
                                <thead className="bg-muted/60">
                                  <tr>
                                    <th className="text-left py-2 px-3 font-semibold text-foreground">Device</th>
                                    <th className="text-left py-2 px-3 font-semibold text-foreground">UUID</th>
                                    <th className="text-left py-2 px-3 font-semibold text-foreground">Status</th>
                                    <th className="text-left py-2 px-3 font-semibold text-foreground">Last Seen</th>
                                    <th className="text-left py-2 px-3 font-semibold text-foreground">Protocol</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(sensor.children || []).map((child) => (
                                    <tr key={child.uuid} className="border-t border-border">
                                      <td className="py-2 px-3 font-medium text-foreground">{child.name}</td>
                                      <td className="py-2 px-3 text-muted-foreground">{child.identifier || '—'}</td>
                                      <td className="py-2 px-3">{getChildStatusBadge(child)}</td>
                                      <td className="py-2 px-3 text-muted-foreground">
                                        {child.lastSeenAt ? new Date(child.lastSeenAt).toLocaleString() : '—'}
                                      </td>
                                      <td className="py-2 px-3">
                                        <Badge variant="outline" className="text-xs">
                                          {child.protocol.toUpperCase()}
                                        </Badge>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    )})}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
          </TabsContent>

          {/* Anomaly Detection Tab */}
          <TabsContent value="anomaly" className="space-y-6">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Select value={anomalyFilterDevice} onValueChange={setAnomalyFilterDevice}>
                    <SelectTrigger className="h-9 w-44 text-sm">
                      <SelectValue placeholder="All devices" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All devices</SelectItem>
                      {anomalyDeviceOptions.map(label => (
                        <SelectItem key={label} value={label}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={anomalyFilterMethod} onValueChange={setAnomalyFilterMethod}>
                    <SelectTrigger className="h-9 w-40 text-sm">
                      <SelectValue placeholder="All methods" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All methods</SelectItem>
                      {anomalyMethodOptions.map(m => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={() => anomalyAddRef.current?.()}>
                  <Plus className="w-4 h-4 mr-2" />
                  Add Metric
                </Button>
              </div>

              <Card>
                <CardHeader>
                  <CardDescription>
                    {anomalyMetricsSummary.total === 0
                      ? 'No anomaly metrics configured yet.'
                      : (() => {
                          const hasFilters = anomalyFilterDevice !== 'all' || anomalyFilterMethod !== 'all';
                          return hasFilters
                            ? `${anomalyMetricsSummary.filtered} of ${anomalyMetricsSummary.total} anomaly metric(s) matching filters`
                            : `${anomalyMetricsSummary.total} anomaly metric(s) configured`;
                        })()}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <AnomalyMetricsTable
                    inline
                    addTriggerRef={anomalyAddRef}
                    initialDeviceUuid={deviceUuid}
                    open={true}
                    onOpenChange={() => {}}
                    filterDevice={anomalyFilterDevice}
                    onFilterDeviceChange={setAnomalyFilterDevice}
                    filterMethod={anomalyFilterMethod}
                    onFilterMethodChange={setAnomalyFilterMethod}
                    onFilterOptionsChange={(devices, methods) => {
                      setAnomalyDeviceOptions(devices);
                      setAnomalyMethodOptions(methods);
                    }}
                    onMetricsSummaryChange={setAnomalyMetricsSummary}
                  />
                </CardContent>
              </Card>
            </TabsContent>

          {false && (
          <TabsContent value="profiles" className="space-y-6">
            {/* Protocol Filter with Add Profile Button */}
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-foreground">Protocol:</label>
                <Select
                  value={profileProtocolFilter}
                  onValueChange={setProfileProtocolFilter}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All ({allProfiles.length})</SelectItem>
                    <SelectItem value="modbus">Modbus ({allProfiles.filter(p => p.protocol === 'modbus').length})</SelectItem>
                    <SelectItem value="opcua">OPC-UA ({allProfiles.filter(p => p.protocol === 'opcua').length})</SelectItem>
                    <SelectItem value="mqtt">MQTT ({allProfiles.filter(p => p.protocol === 'mqtt').length})</SelectItem>
                    <SelectItem value="can">CAN Bus ({allProfiles.filter(p => p.protocol === 'can').length})</SelectItem>
                    <SelectItem value="snmp">SNMP ({allProfiles.filter(p => p.protocol === 'snmp').length})</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Button onClick={handleOpenProfileDialog}>
                <Plus className="w-4 h-4 mr-2" />
                Add Profile
              </Button>
            </div>

            {/* Profiles List */}
            <Card>
              <CardHeader>
                <CardTitle>Device Profiles</CardTitle>
                <CardDescription>
                  {(() => {
                    const filteredProfiles = profileProtocolFilter === 'all' 
                      ? allProfiles 
                      : allProfiles.filter(p => p.protocol === profileProtocolFilter);
                    
                    if (allProfiles.length === 0) {
                      return 'No profiles configured yet.';
                    }
                    
                    const hasFilter = profileProtocolFilter !== 'all';
                    return hasFilter 
                      ? `${filteredProfiles.length} of ${allProfiles.length} profile(s) matching filter`
                      : `${allProfiles.length} profile(s) configured`;
                  })()}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {/* Profiles List */}
                {(() => {
                  const filteredProfiles = profileProtocolFilter === 'all' 
                    ? allProfiles 
                    : allProfiles.filter(p => p.protocol === profileProtocolFilter);
                  
                  if (filteredProfiles.length === 0) {
                    return (
                      <div className="text-center py-12 text-muted-foreground">
                        <FileText className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                        <p className="text-lg font-medium mb-2">
                          {allProfiles.length === 0 ? 'No profiles yet' : 'No profiles found'}
                        </p>
                        {allProfiles.length === 0 && (
                          <p className="text-sm mb-4">Create your first protocol profile</p>
                        )}
                      </div>
                    );
                  }
                  
                  return (
                    <div className="space-y-3">
                      {filteredProfiles.map((profile) => (
                        <div key={profile.profile_name}>
                          <div
                            className="flex items-center justify-between p-4 border border-border rounded-lg hover:border-muted-foreground/20 transition-colors"
                          >
                            <div className="flex-1">
                              <div className="flex items-center gap-3 mb-2">
                                <h3 className="text-lg font-semibold text-foreground">{profile.profile_name}</h3>
                                <Badge variant="outline" className="text-xs">
                                  {profile.protocol.toUpperCase()}
                                </Badge>
                                <Badge variant="secondary" className="text-xs">
                                  {profile.data_points?.length || 0} data points
                                </Badge>
                              </div>
                              
                              <div className="flex flex-wrap gap-6 text-sm text-muted-foreground">
                                {profile.metadata?.description && (
                                  <div>
                                    <span className="font-medium">Description:</span>{' '}
                                    {profile.metadata.description}
                                  </div>
                                )}
                                {profile.created_at && (
                                  <div>
                                    <span className="font-medium">Created:</span>{' '}
                                    {new Date(profile.created_at).toLocaleDateString()}
                                  </div>
                                )}
                              </div>
                            </div>
                            
                            {/* Action Buttons */}
                            <div className="flex items-center gap-3 ml-4">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleEditProfile(profile)}
                              >
                                <Pencil className="h-4 w-4 mr-2" />
                                Edit
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          </TabsContent>
          )}
        </Tabs>

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
          <DialogContent
            className="w-[min(96vw,1100px)] max-w-[96vw] !p-0 overflow-hidden flex flex-col"
            style={{ height: '66vh', maxHeight: '66vh' }}
          >
            <DialogHeader className="px-6 py-4">
              <DialogTitle>Add Device</DialogTitle>
              <DialogDescription>
                Virtual devices are protocol simulators that run as sidecar containers.
                The agent connects to them via localhost just like physical devices.
              </DialogDescription>
            </DialogHeader>

            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
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
                        {profile.profile_name}
                        {profile.metadata?.description && ` - ${profile.metadata.description}`}
                        {` (${profile.data_points?.length || 0} points)`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Data Points Preview - Commented out to reduce confusion, users should work with profiles only
              <div className="space-y-2">
                <Label>Data Points Preview</Label>
                <Textarea
                  readOnly
                  className="h-80 w-full font-mono text-xs"
                  value={
                    selectedVirtualProfile
                      ? JSON.stringify(selectedVirtualProfile.data_points || [], null, 2)
                      : 'Select a profile to preview its data points.'
                  }
                />
              </div>
              */}

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

            </div>

            <DialogFooter className="px-6 py-4">
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

        {/* Add/Edit Profile Dialog - Separate Component */}
        <EditProfileDialog
          open={addProfileDialogOpen}
          onOpenChange={setAddProfileDialogOpen}
          onSaveProfile={handleSaveProfile}
          profileData={profileFormData}
          onProfileDataChange={setProfileFormData}
          isEditing={!!editingProfileName}
          isLoading={profileLoading}
          dataPointsError={dataPointsError}
          onDataPointsErrorChange={setDataPointsError}
          onLoadTemplate={handleLoadTemplate}
          onValidateDataPoints={handleValidateDataPoints}
          onProfileNameReset={() => setEditingProfileName(null)}
        />
      </div>
    </div>
  );
};
