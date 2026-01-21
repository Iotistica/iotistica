/**
 * Edit Sensor Dialog
 * 
 * Tabbed interface for editing existing protocol devices.
 * Supports: Modbus TCP/RTU, OPC-UA
 * Pre-populates form with existing configuration and allows updates.
 */

import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Trash2 } from 'lucide-react';
import { ModbusConfigForm } from './ModbusConfigForm';
import { DataPointsTable } from './DataPointsTable';
import { OPCUAConfigForm } from './OPCUAConfigForm';
import { OPCUADataPointsTable } from './OPCUADataPointsTable';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import type { ModbusDeviceConfig, ModbusDataPoint, OPCUADeviceConfig, OPCUADataPoint } from '@/schemas/sensor-schemas';

interface EditSensorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdateDevice: (deviceName: string, updates: any) => Promise<void>;
  onDeleteDevice?: (deviceName: string) => Promise<void>;
  device: any | null; // Existing device configuration
}

export const EditSensorDialog: React.FC<EditSensorDialogProps> = ({ 
  open, 
  onOpenChange, 
  onUpdateDevice,
  onDeleteDevice,
  device
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  
  // Modbus form state
  const [modbusConfig, setModbusConfig] = useState<ModbusDeviceConfig | null>(null);
  const [modbusFormValid, setModbusFormValid] = useState(false);
  const [modbusDataPoints, setModbusDataPoints] = useState<ModbusDataPoint[]>([]);

  // OPC-UA form state
  const [opcuaConfig, setOpcuaConfig] = useState<OPCUADeviceConfig | null>(null);
  const [opcuaFormValid, setOpcuaFormValid] = useState(false);
  const [opcuaDataPoints, setOpcuaDataPoints] = useState<OPCUADataPoint[]>([]);

  // Initialize form with existing device data
  useEffect(() => {
    if (device && open) {
      console.log('[EditSensorDialog] Initializing with device:', device);
      
      if (device.protocol === 'modbus') {
        // Device structure from API is already parsed
        const config: ModbusDeviceConfig = {
          name: device.name,
          protocol: 'modbus',
          enabled: device.enabled ?? true,
          pollInterval: device.pollInterval || 1000,
          connection: device.connection,
          dataPoints: device.dataPoints || [],
        };
        
        console.log('[EditSensorDialog] Modbus config:', config);
        setModbusConfig(config);
        setModbusDataPoints(device.dataPoints || []);
        setModbusFormValid(true); // Assume valid since it was saved before
      } else if (device.protocol === 'opcua') {
        // Device structure from API is already parsed
        const config: OPCUADeviceConfig = {
          name: device.name,
          protocol: 'opcua',
          enabled: device.enabled ?? true,
          pollInterval: device.pollInterval || 1000,
          connection: device.connection,
          dataPoints: device.dataPoints || [],
        };
        
        console.log('[EditSensorDialog] OPC-UA config:', config);
        setOpcuaConfig(config);
        setOpcuaDataPoints(device.dataPoints || []);
        setOpcuaFormValid(true); // Assume valid since it was saved before
      }
    }
  }, [device, open]);

  const handleSave = async () => {
    setError(null);

    if (!device) {
      setError('No device selected');
      return;
    }

    const protocol = device.protocol;

    // Validate based on protocol
    if (protocol === 'modbus') {
      if (!modbusConfig || !modbusFormValid) {
        setError('Please complete all required fields');
        return;
      }

      if (modbusDataPoints.length === 0) {
        setError('Please add at least one data point');
        return;
      }

      // Combine config with data points
      const finalConfig: ModbusDeviceConfig = {
        ...modbusConfig,
        dataPoints: modbusDataPoints,
      };

      try {
        setLoading(true);
        await onUpdateDevice(device.name, finalConfig);
        handleClose();
      } catch (err: any) {
        setError(err.message || 'Failed to update device');
      } finally {
        setLoading(false);
      }
    } else if (protocol === 'opcua') {
      if (!opcuaConfig || !opcuaFormValid) {
        setError('Please complete all required fields');
        return;
      }

      if (opcuaDataPoints.length === 0) {
        setError('Please add at least one node');
        return;
      }

      // Combine config with data points
      const finalConfig: OPCUADeviceConfig = {
        ...opcuaConfig,
        dataPoints: opcuaDataPoints,
      };

      try {
        setLoading(true);
        await onUpdateDevice(device.name, finalConfig);
        handleClose();
      } catch (err: any) {
        setError(err.message || 'Failed to update device');
      } finally {
        setLoading(false);
      }
    }
  };

  const handleClose = () => {
    setError(null);
    setShowDeleteConfirm(false);
    onOpenChange(false);
  };

  const handleDelete = async () => {
    if (!device || !onDeleteDevice) return;

    try {
      setDeleting(true);
      setError(null);
      await onDeleteDevice(device.name);
      setShowDeleteConfirm(false);
      handleClose();
    } catch (err: any) {
      setError(err.message || 'Failed to delete device');
      setShowDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
  };

  const canSave = () => {
    if (!device) return false;
    
    if (device.protocol === 'modbus') {
      return modbusFormValid && modbusDataPoints.length > 0;
    } else if (device.protocol === 'opcua') {
      return opcuaFormValid && opcuaDataPoints.length > 0;
    }
    return false;
  };

  if (!device) {
    return null;
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Edit Device: {device.name}</DialogTitle>
            <DialogDescription>
              Update configuration for this {device.protocol?.toUpperCase()} device
            </DialogDescription>
          </DialogHeader>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {device.protocol === 'modbus' && (
            <div className="flex-1 overflow-y-auto space-y-6 mt-4">
              <ModbusConfigForm 
                value={modbusConfig || undefined}
                onChange={setModbusConfig}
                onValidationChange={setModbusFormValid}
              />

              <DataPointsTable
                value={modbusDataPoints}
                onChange={setModbusDataPoints}
              />
            </div>
          )}

          {device.protocol === 'opcua' && (
            <div className="flex-1 overflow-y-auto space-y-6 mt-4">
              <OPCUAConfigForm 
                value={opcuaConfig || undefined}
                onChange={setOpcuaConfig}
                onValidationChange={setOpcuaFormValid}
              />

              <OPCUADataPointsTable
                dataPoints={opcuaDataPoints}
                onChange={setOpcuaDataPoints}
              />
            </div>
          )}

          <DialogFooter className="flex justify-between items-center">
            {onDeleteDevice ? (
              <Button 
                variant="destructive" 
                onClick={() => setShowDeleteConfirm(true)}
                disabled={loading || deleting}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Device
              </Button>
            ) : (
              <div />
            )}
            <div className="flex gap-2 ml-auto">
              <Button variant="outline" onClick={handleClose} disabled={loading || deleting}>
                Cancel
              </Button>
              <Button 
                onClick={handleSave} 
                disabled={!canSave() || loading || deleting}
              >
                {loading ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Device</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{device?.name}</strong>? This action cannot be undone and will remove all associated data points and historical data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
