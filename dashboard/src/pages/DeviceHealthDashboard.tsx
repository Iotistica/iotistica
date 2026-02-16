/**
 * Sensor Health Dashboard - Main Overview Page
 * Shows all sensors with their connection status and health metrics
 */

import React, { useEffect, useState } from 'react';
import { Activity, Plus } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SensorSummaryCards } from '@/components/devices/DeviceSummaryCards';
import { SensorTable } from '@/components/devices/DeviceTable';
import { PipelineHealth } from '@/components/devices/PipelineHealth';
import { DeviceDetailPage } from './DeviceDetailPage';
import { AddSensorDialog } from '@/components/devices/AddDeviceDialog';
import { useSensorHealth } from '@/hooks/useSensorHealth';
import { toast } from 'sonner';
import { useDeviceState } from '@/contexts/DeviceStateContext';

interface SensorHealthDashboardProps {
  deviceUuid: string;
}

export const SensorHealthDashboard: React.FC<SensorHealthDashboardProps> = ({ deviceUuid }) => {
  const { data, loading, error, refetch } = useSensorHealth(deviceUuid);
  const [selectedSensor, setSelectedSensor] = useState<string | null>(null);
  const [addSensorDialogOpen, setAddSensorDialogOpen] = useState(false);
  
  // Use context for config changes
  const { updatePendingConfig, getPendingConfig } = useDeviceState();

  // Auto-refresh every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      refetch();
    }, 10000);
    
    return () => clearInterval(interval);
  }, [refetch]);

  const handleAddProtocolDevice = async (device: any) => {
    try {
      console.log('📡 Adding protocol device via context:', device);
      
      // Get current config
      const currentConfig = getPendingConfig(deviceUuid);
      const existingDevices = currentConfig.sensors || [];
      
      // Add new device to config (marks as pending change)
      updatePendingConfig(deviceUuid, 'sensors', [
        ...existingDevices,
        {
          ...device,
          enabled: true,
          metadata: {
            createdAt: new Date().toISOString(),
            createdBy: 'dashboard',
          }
        }
      ]);
      
      toast.success(`Protocol device "${device.name}" added (not saved yet - click Save Draft)`);
      
      // Refresh sensor list
      refetch();
    } catch (error: any) {
      toast.error(`Failed to add protocol device: ${error.message}`);
      throw error;
    }
  };

  // Only show loading spinner on initial load (when there's no data yet)
  if (loading && !data) {
    return (
      <div className="flex-1 bg-background overflow-auto">
        <div className="flex items-center justify-center min-h-[400px]">
          <Activity className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // Show error only if we have no data to display
  if (error && !data) {
    return (
      <div className="flex-1 bg-background overflow-auto p-6">
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load sensor health data: {error.message}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Sensors</h1>
            <p className="text-sm text-muted-foreground">
              Monitor and manage your connected sensors
            </p>
          </div>
          <Button onClick={() => setAddSensorDialogOpen(true)} className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Add Sensor
          </Button>
        </div>

      {/* Summary Cards */}
      <SensorSummaryCards summary={data.summary} />

      {/* Sensor Status Table */}
      <Card>
        <CardHeader>
          <CardTitle>Sensors</CardTitle>
          <CardDescription>{data.devices.length} sensor(s) configured</CardDescription>
        </CardHeader>
        <CardContent>
          <SensorTable 
            sensors={data.devices} 
            onViewDetails={(sensorName) => setSelectedSensor(sensorName)}
          />
        </CardContent>
      </Card>

      {/* Pipeline Infrastructure */}
      <PipelineHealth pipelines={data.pipelines} />

      {/* Sensor Detail Modal */}
      <Dialog open={selectedSensor !== null} onOpenChange={(open) => !open && setSelectedSensor(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          {selectedSensor && (
            <DeviceDetailPage 
              deviceUuid={deviceUuid}
              sensorName={selectedSensor}
              onClose={() => setSelectedSensor(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Add Sensor Dialog - Unified */}
      <AddSensorDialog
        open={addSensorDialogOpen}
        onOpenChange={setAddSensorDialogOpen}
        onSaveDevice={handleAddProtocolDevice}
        deviceUuid={deviceUuid}
      />
      </div>
    </div>
  );
};
