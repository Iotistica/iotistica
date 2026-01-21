/**
 * Sensors Page - User-Friendly Sensor Management
 * Hides technical pipeline details, focuses on sensor configuration and status
 */

import React, { useEffect, useState } from 'react';
import { Activity, Eye } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { SimpleToggle } from '@/components/ui/simple-toggle';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AddSensorDialog } from '@/components/sensors/AddSensorDialog';
import { SensorSummaryCards } from '@/components/sensors/SensorSummaryCards';
import { DataPointsViewer } from '@/components/sensors/DataPointsViewer';
import { toast } from 'sonner';
import { buildApiUrl } from '@/config/api';
import { Device } from "../components/DeviceSidebar";
import { useDeviceState } from '@/contexts/DeviceStateContext';


interface SensorsPageProps {
  deviceUuid: string;
  deviceStatus?: Device['status']; // Add device status for permission checks
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
  type?: 'pipeline' | 'device'; // pipeline = sensor publish, device = protocol adapter
  protocol?: string;
  connected?: boolean;
  dataPoints?: ModbusDataPoint[] | OPCUADataPoint[]; // Protocol-specific data points
  // Deployment tracking fields
  deploymentStatus?: 'pending' | 'deployed' | 'deploying' | 'failed' | 'reconciling' | 'draft' | 'saved-draft';
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
}

export const SensorsPage: React.FC<SensorsPageProps> = ({ 
  deviceUuid
}) => {
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addSensorDialogOpen, setAddSensorDialogOpen] = useState(false);
  const [selectedSensor, setSelectedSensor] = useState<Sensor | null>(null);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [selectedProtocol, setSelectedProtocol] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const { addPendingSensor, getPendingConfig, getTargetConfig, updatePendingSensor, saveTargetState } = useDeviceState();

  const fetchSensors = async () => {
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
        firstDevice: data.devices?.[0],
        deploymentStatuses: data.devices?.map((d: any) => ({ name: d.name, status: d.deploymentStatus || d.deployment_status }))
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
        
        console.log(`[fetchSensors] Sensor "${d.name}":`, {
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
          lastActivity: health?.lastPoll || d.lastSeen,
          lastError: health?.lastError || d.lastError,
          configured: true,
          enabled: d.enabled !== undefined ? d.enabled : true, // Default to enabled
          type: 'device' as const,
          protocol: d.protocol,
          connected: isConnected,
          dataPoints: d.data_points || d.dataPoints || [], // Include data points from API
          // Deployment tracking
          deploymentStatus: d.deploymentStatus,
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
      
      // Get pending sensors from config (sensors not yet deployed)
      const pendingConfig = getPendingConfig(deviceUuid);
      const targetConfig = getTargetConfig(deviceUuid);
      
      const pendingSensors = (pendingConfig.sensors || [])
        .filter((s: any) => {
          // Only include sensors that are NOT in the database yet
          return !devices.find((d: any) => d.name === s.name);
        })
        .map((s: any) => {
          // Check if sensor exists in saved target state (clicked "Save Draft")
          const inTargetState = targetConfig?.sensors?.find((ts: any) => ts.name === s.name);
          
          return {
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
            // Show "saved-draft" if saved to target_state, "draft" if only in context
            deploymentStatus: inTargetState ? 'saved-draft' : 'draft',
            lastDeployedAt: null,
            deploymentError: null,
            deploymentAttempts: 0,
          };
        });
      
      // Show newly added sensors (DRAFT) at the top, then deployed sensors
      setSensors([...pendingSensors, ...pipelines, ...devices]);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSensors();
    
    // Auto-refresh every 10 seconds
    // const interval = setInterval(fetchSensors, 10000);
    
    // Listen for deployment events from Header (Sync button)
    const handleDeploymentStarted = (event: CustomEvent) => {
      if (event.detail.deviceUuid === deviceUuid) {
        console.log('Deployment started - refreshing sensors after database update completes');
        // Small delay to ensure database update completes before fetching
        // This prevents race condition where deployment_status hasn't been set to 'pending' yet
        setTimeout(() => {
          fetchSensors();
        }, 500);
      }
    };
    
    window.addEventListener('deployment-started', handleDeploymentStarted as EventListener);
    
    return () => {
      // clearInterval(interval);
      window.removeEventListener('deployment-started', handleDeploymentStarted as EventListener);
    };
  }, [deviceUuid, getPendingConfig(deviceUuid), getTargetConfig(deviceUuid)]);

  const handleAddProtocolDevice = async (device: any) => {
    try {
      console.log('📝 Adding sensor to local state (draft mode):', device);
      
      // Add sensor to config in React state only (matches app pattern)
      // User must click "Save Draft" to persist to device_target_state
      addPendingSensor(deviceUuid, device);

      // Refresh sensor list to show the new pending sensor immediately
      await fetchSensors();

      toast.success(`Sensor "${device.name}" added (not saved yet - click Save Draft)`);
    } catch (error: any) {
      toast.error(`Failed to add sensor: ${error.message}`);
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
      
      // OVERRIDE-ONLY PATTERN: Update pending changes with just {uuid, name, enabled}
      // Now returns a promise to ensure state is updated before saveTargetState
      await updatePendingSensor(deviceUuid, sensor.name, updates);
      
      // Auto-save to persist to database (now uses functional state update - no closure issue)
      console.log('[Toggle] Auto-saving to database...');
      await saveTargetState(deviceUuid);
      console.log('[Toggle] Saved successfully');
      
      // Refresh sensor list to show updated state
      await fetchSensors();

      toast.success(`Device "${sensor.name}" ${newEnabled ? 'enabled' : 'disabled'} - Click Sync to deploy`);
    } catch (error: any) {
      console.error('Toggle device error:', error);
      toast.error(`Failed to toggle device: ${error.message}`);
    }
  };

  /**
   * Simplified status badge - shows what users need to know
   * Priority: Deployment actions → Disabled state → Health status
   */
  const getStatusBadge = (sensor: Sensor) => {
    const deploymentStatus = sensor.deploymentStatus;
    
    // 1. Deployment lifecycle states (require user action - highest priority)
    if (deploymentStatus === 'draft') {
      return <Badge className="bg-zinc-700 dark:bg-zinc-600 text-white border border-zinc-800 dark:border-zinc-500">Draft</Badge>;
    }
    if (deploymentStatus === 'saved-draft') {
      return <Badge className="bg-zinc-700 dark:bg-zinc-600 text-white border border-zinc-800 dark:border-zinc-500">Draft (Saved)</Badge>;
    }
    

    // When user toggles, deploymentStatus becomes 'pending' to prevent overwrite
    if (deploymentStatus === 'pending') {
      console.log(`[Badge] "${sensor.name}" - Showing "Needs Sync" (deploymentStatus=${deploymentStatus})`);
      return (
        <span 
          className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold border"
          style={{ backgroundColor: '#ca8a04', color: 'white', borderColor: '#a16207' }}
        >
          Needs Sync
        </span>
      );
    }
    
    
    if (deploymentStatus === 'failed') {
      return <Badge className="bg-red-600 dark:bg-red-700 text-white border border-red-700 dark:border-red-600 font-semibold">Deploy Failed</Badge>;
    }
    
    if (deploymentStatus === 'reconciling') {
      return <Badge className="bg-blue-500 dark:bg-blue-600 text-white border border-blue-600 dark:border-blue-500 font-semibold">Reconciling</Badge>;
    }
    
    // Discovered (agent found it, initial state)
    if ((deploymentStatus as any) === 'discovered') {
      return <Badge className="bg-slate-500 dark:bg-slate-600 text-white border border-slate-600 dark:border-slate-500">Discovered</Badge>;
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

        {/* Protocol Filter */}
        {sensors.length > 0 && (
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
        )}

       
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
                <p className="text-lg font-medium mb-2">No endpoints yet</p>
               
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
                         sensor.deploymentStatus !== 'draft' && 
                         sensor.deploymentStatus !== 'saved-draft' && (
                          <select
                            value={sensor.enabled !== undefined ? (sensor.enabled ? 'enabled' : 'disabled') : 'enabled'}
                            onChange={(e) => handleToggleSensorEnabled(sensor, e.target.value === 'enabled')}
                            className="h-8 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                          >
                            <option value="enabled">Enabled</option>
                            <option value="disabled">Disabled</option>
                          </select>
                        )}
                        
                        {/* View Details Button */}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSelectedSensor(sensor);
                            setDetailsDialogOpen(true);
                          }}
                        >
                          <Eye className="h-4 w-4 mr-2" />
                          View Details
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

        {/* Sensor Details Dialog */}
        <Dialog open={detailsDialogOpen} onOpenChange={setDetailsDialogOpen}>
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>Sensor Details: {selectedSensor?.name}</DialogTitle>
              <DialogDescription>
                {selectedSensor?.protocol && `${selectedSensor.protocol.toUpperCase()} sensor`}
              </DialogDescription>
            </DialogHeader>
            
            {selectedSensor && (
              <Tabs defaultValue="overview" className="flex-1 overflow-hidden flex flex-col">
                <TabsList className="w-full justify-start">
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="datapoints">
                    Data Points {selectedSensor.dataPoints && selectedSensor.dataPoints.length > 0 && (
                      <Badge variant="secondary" className="ml-2 text-xs">
                        {selectedSensor.dataPoints.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="anomaly">Anomaly Detection</TabsTrigger>
                </TabsList>

                {/* Overview Tab */}
                <TabsContent value="overview" className="flex-1 overflow-y-auto space-y-6 mt-4">
                  {/* Status Section */}
                  <div>
                    <h3 className="text-sm font-semibold mb-3 text-foreground">Status</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-sm text-muted-foreground">State</p>
                        <div className="mt-1">{getStatusBadge(selectedSensor)}</div>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Health</p>
                        <p className="text-sm font-medium mt-1">{selectedSensor.healthy ? '✓ Healthy' : '✗ Unhealthy'}</p>
                      </div>
                      {selectedSensor.protocol && (
                        <div>
                          <p className="text-sm text-muted-foreground">Protocol</p>
                          <Badge variant="outline" className="mt-1">{selectedSensor.protocol.toUpperCase()}</Badge>
                        </div>
                      )}
                      {selectedSensor.connected !== undefined && (
                        <div>
                          <p className="text-sm text-muted-foreground">Connected</p>
                          <p className="text-sm font-medium mt-1">{selectedSensor.connected ? '✓ Yes' : '✗ No'}</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Deployment Section */}
                  {selectedSensor.type === 'device' && (
                    <div>
                      <h3 className="text-sm font-semibold mb-3 text-foreground">Deployment</h3>
                      <div className="grid grid-cols-2 gap-4">
                        {selectedSensor.lastDeployedAt && (
                          <div>
                            <p className="text-sm text-muted-foreground">Last Deployed</p>
                            <p className="text-sm font-medium mt-1">
                              {new Date(selectedSensor.lastDeployedAt).toLocaleString()}
                            </p>
                          </div>
                        )}
                        {selectedSensor.deploymentAttempts !== undefined && (
                          <div>
                            <p className="text-sm text-muted-foreground">Deploy Attempts</p>
                            <p className="text-sm font-medium mt-1">{selectedSensor.deploymentAttempts}</p>
                          </div>
                        )}
                      </div>
                      {selectedSensor.deploymentError && (
                        <Alert variant="destructive" className="mt-4">
                          <AlertDescription>
                            <span className="font-medium">Deployment Error:</span> {selectedSensor.deploymentError}
                          </AlertDescription>
                        </Alert>
                      )}
                    </div>
                  )}

                  {/* Activity Section */}
                  <div>
                    <h3 className="text-sm font-semibold mb-3 text-foreground">Activity</h3>
                    <div className="grid grid-cols-2 gap-4">
                      {selectedSensor.type === 'pipeline' && (
                        <div>
                          <p className="text-sm text-muted-foreground">Messages Published</p>
                          <p className="text-sm font-medium mt-1">
                            {selectedSensor.messagesPublished.toLocaleString()}
                          </p>
                        </div>
                      )}
                      <div>
                        <p className="text-sm text-muted-foreground">Last Activity</p>
                        <p className="text-sm font-medium mt-1">
                          {selectedSensor.lastActivity 
                            ? new Date(selectedSensor.lastActivity).toLocaleString()
                            : 'Never'}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Error Section */}
                  {selectedSensor.lastError && selectedSensor.state !== 'PENDING' && (
                    <Alert variant="destructive">
                      <AlertDescription>
                        <span className="font-medium">Last Error:</span> {selectedSensor.lastError}
                      </AlertDescription>
                    </Alert>
                  )}

                  {/* Configuration Section */}
                  <div>
                    <h3 className="text-sm font-semibold mb-3 text-foreground">Configuration</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-sm text-muted-foreground">Type</p>
                        <p className="text-sm font-medium mt-1 capitalize">{selectedSensor.type || 'Unknown'}</p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Configured</p>
                        <p className="text-sm font-medium mt-1">{selectedSensor.configured ? '✓ Yes' : '✗ No'}</p>
                      </div>
                    </div>
                  </div>
                </TabsContent>

                {/* Data Points Tab */}
                <TabsContent value="datapoints" className="flex-1 overflow-y-auto mt-4">
                  {selectedSensor.dataPoints && selectedSensor.dataPoints.length > 0 ? (
                    <div>
                      <div className="mb-4">
                        <p className="text-sm text-muted-foreground">
                          Configured data points for this {selectedSensor.protocol?.toUpperCase()} sensor
                        </p>
                      </div>
                      <DataPointsViewer 
                        protocol={selectedSensor.protocol || 'unknown'} 
                        dataPoints={selectedSensor.dataPoints}
                      />
                    </div>
                  ) : (
                    <div className="text-center py-12 text-muted-foreground">
                      <p className="text-lg font-medium mb-2">No data points configured</p>
                      <p className="text-sm">Add data points to start collecting metrics from this sensor</p>
                    </div>
                  )}
                </TabsContent>

                {/* Anomaly Detection Tab */}
                <TabsContent value="anomaly" className="flex-1 overflow-y-auto mt-4">
                  <div className="space-y-4">
                    <div className="mb-4">
                      <p className="text-sm text-muted-foreground">
                        Configure anomaly detection rules for data points
                      </p>
                    </div>
                    
                    {selectedSensor.dataPoints && selectedSensor.dataPoints.length > 0 ? (
                      <div className="border border-border rounded-lg p-6 text-center">
                        <p className="text-sm font-medium text-muted-foreground mb-2">
                          Anomaly Detection (Coming Soon)
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Select data points from the list and configure threshold-based or ML-based anomaly detection rules
                        </p>
                      </div>
                    ) : (
                      <div className="text-center py-12 text-muted-foreground">
                        <p className="text-lg font-medium mb-2">No data points available</p>
                        <p className="text-sm">Configure data points first to enable anomaly detection</p>
                      </div>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};
