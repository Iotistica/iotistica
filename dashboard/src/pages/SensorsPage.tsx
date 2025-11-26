/**
 * Sensors Page - User-Friendly Sensor Management
 * Hides technical pipeline details, focuses on sensor configuration and status
 */

import React, { useEffect, useState } from 'react';
import { Activity, Plus, Eye } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { AddSensorDialog } from '@/components/sensors/AddSensorDialog';
import { SensorSummaryCards } from '@/components/sensors/SensorSummaryCards';
import { toast } from 'sonner';
import { buildApiUrl } from '@/config/api';
import { canPerformDeviceActions } from "@/utils/devicePermissions";
import { Device } from "../components/DeviceSidebar";
import { useDeviceState } from '@/contexts/DeviceStateContext';


interface SensorsPageProps {
  deviceUuid: string;
  deviceStatus?: Device['status']; // Add device status for permission checks
  debugMode?: boolean;
  onDebugModeChange?: (enabled: boolean) => void;
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
  // Deployment tracking fields
  deploymentStatus?: 'pending' | 'deployed' | 'failed' | 'reconciling' | 'draft' | 'saved-draft';
  lastDeployedAt?: string | null;
  deploymentError?: string | null;
  deploymentAttempts?: number;
}

export const SensorsPage: React.FC<SensorsPageProps> = ({ 
  deviceUuid, 
  deviceStatus,
  debugMode = false, 
  onDebugModeChange 
}) => {
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addSensorDialogOpen, setAddSensorDialogOpen] = useState(false);
  const [selectedSensor, setSelectedSensor] = useState<Sensor | null>(null);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const canAddApp = canPerformDeviceActions(deviceStatus);
  const { addPendingSensor, getPendingConfig, getTargetConfig } = useDeviceState();

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
      
      // Merge pipelines and protocol adapter devices
      const pipelines = (data.pipelines || []).map((p: any) => ({
        ...p,
        type: 'pipeline' as const,
        protocol: p.protocolType, // Map protocolType to protocol for consistency
      }));
      
      const devices = (data.devices || []).map((d: any) => ({
        uuid: d.uuid || d.configId, // Use uuid from table, fallback to configId
        name: d.name,
        state: d.connected ? 'CONNECTED' : 'DISCONNECTED',
        healthy: d.connected,
        messagesPublished: 0, // Protocol adapters don't track messages
        lastActivity: d.lastSeen,
        lastError: d.lastError,
        configured: true,
        enabled: d.enabled !== undefined ? d.enabled : true, // Default to enabled
        type: 'device' as const,
        protocol: d.protocol,
        connected: d.connected,
        // Deployment tracking
        deploymentStatus: d.deploymentStatus,
        lastDeployedAt: d.lastDeployedAt,
        deploymentError: d.deploymentError,
        deploymentAttempts: d.deploymentAttempts,
      }));
      
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
    const interval = setInterval(fetchSensors, 10000);
    return () => clearInterval(interval);
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
      
      // Use uuid as identifier (preferred), fallback to name for backward compatibility
      const identifier = sensor.uuid || sensor.name;
      
      // Update sensor in backend
      const response = await fetch(
        buildApiUrl(`/api/v1/devices/${deviceUuid}/sensors/${encodeURIComponent(identifier)}`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: newEnabled })
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to update sensor: ${response.statusText}`);
      }

      // Refresh sensor list
      await fetchSensors();

      toast.success(`Sensor "${sensor.name}" ${newEnabled ? 'enabled' : 'disabled'}`);
    } catch (error: any) {
      toast.error(`Failed to toggle sensor: ${error.message}`);
    }
  };

  const getStatusBadge = (sensor: Sensor) => {
    // DRAFT state uses deployment status badge, not state badge
    if (sensor.state === 'DRAFT') {
      return null;
    }
    if (sensor.state === 'PENDING') {
      return <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-300">⏳ Starting...</Badge>;
    }
    if (sensor.state === 'CONNECTED' && sensor.healthy) {
      return <Badge variant="outline" className="bg-green-50 text-green-700 border-green-300">✓ Active</Badge>;
    }
    if (sensor.state === 'DISCONNECTED') {
      return <Badge variant="outline" className="bg-muted text-muted-foreground border-border">○ Inactive</Badge>;
    }
    return <Badge variant="outline" className="bg-red-50 text-red-700 border-red-300">✕ Error</Badge>;
  };

  const getDeploymentStatusBadge = (status?: string) => {
    switch (status) {
      case 'draft':
        return <Badge variant="outline" className="bg-gray-50 text-gray-700 border-gray-300">📝 Not Saved</Badge>;
      case 'saved-draft':
        return <Badge variant="outline" className="bg-gray-50 text-gray-700 border-gray-300">📝 Draft</Badge>;
      case 'pending':
        return <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-300">🟡 Pending</Badge>;
      case 'deployed':
        return <Badge variant="outline" className="bg-green-50 text-green-700 border-green-300">🟢 Deployed</Badge>;
      case 'failed':
        return <Badge variant="destructive">🔴 Failed</Badge>;
      case 'reconciling':
        return <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-300">🔄 Reconciling</Badge>;
      default:
        return null;
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
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Endpoints</h1>
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

       
        {/* Sensors List */}
        <Card>
          <CardHeader>
            <CardTitle>Configured Endpoints</CardTitle>
            <CardDescription>
              {sensors.length === 0 
                ? 'No endpoints configured yet.' 
                : `${sensors.length} endpoint(s) configured`}
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
                {sensors.map((sensor) => (
                  <div
                    key={sensor.name}
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
                        {sensor.type === 'device' && sensor.deploymentStatus && getDeploymentStatusBadge(sensor.deploymentStatus)}
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
                      {/* Enable/Disable Toggle - only show for deployed sensors */}
                      {sensor.type === 'device' && 
                       sensor.deploymentStatus !== 'draft' && 
                       sensor.deploymentStatus !== 'saved-draft' && (
                        <div className="flex items-center gap-2 border border-gray-200 rounded-md px-3 py-1.5">
                          <span className="text-sm text-gray-700">
                            {sensor.enabled ? 'Enabled' : 'Disabled'}
                          </span>
                          <Switch
                            checked={sensor.enabled !== undefined ? sensor.enabled : true}
                            onCheckedChange={() => handleToggleSensorEnabled(sensor, sensor.enabled !== undefined ? sensor.enabled : true)}
                            className="data-[state=checked]:bg-green-500 data-[state=unchecked]:bg-gray-300"
                          />
                        </div>
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
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Sensor Details: {selectedSensor?.name}</DialogTitle>
              <DialogDescription>
                View detailed information about this sensor
              </DialogDescription>
            </DialogHeader>
            
            {selectedSensor && (
              <div className="space-y-6">
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
                      {selectedSensor.deploymentStatus && (
                        <div>
                          <p className="text-sm text-muted-foreground">Status</p>
                          <div className="mt-1">{getDeploymentStatusBadge(selectedSensor.deploymentStatus)}</div>
                        </div>
                      )}
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
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};
