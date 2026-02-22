/**
 * Add Sensor Dialog
 * 
 * Tabbed interface for protocol-specific device configuration.
 * Supports: Modbus TCP/RTU, OPC-UA
 * Uses React Hook Form with validation.
 */

import React, { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { ModbusConfigForm } from './ModbusConfigForm';
import { DataPointsTable } from './DataPointsTable';
import { OPCUAConfigForm } from './OPCUAConfigForm';
import { OPCUADataPointsTable } from './OPCUADataPointsTable';
import type { ModbusDeviceConfig, ModbusDataPoint, OPCUADeviceConfig, OPCUADataPoint } from '@/schemas/sensor-schemas';

interface AddSensorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaveDevice: (device: any) => Promise<void>;
  deviceUuid: string;
}

export const AddSensorDialog: React.FC<AddSensorDialogProps> = ({ 
  open, 
  onOpenChange, 
  onSaveDevice
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedProtocol, setSelectedProtocol] = useState<'modbus' | 'opcua'>('modbus');
  
  // Modbus form state
  const [modbusConfig, setModbusConfig] = useState<ModbusDeviceConfig | null>(null);
  const [modbusFormValid, setModbusFormValid] = useState(false);
  const [modbusDataPoints, setModbusDataPoints] = useState<ModbusDataPoint[]>([]);

  // OPC-UA form state
  const [opcuaConfig, setOpcuaConfig] = useState<OPCUADeviceConfig | null>(null);
  const [opcuaFormValid, setOpcuaFormValid] = useState(false);
  const [opcuaDataPoints, setOpcuaDataPoints] = useState<OPCUADataPoint[]>([]);

  const handleSave = async () => {
    setError(null);

    // Validate based on selected protocol
    if (selectedProtocol === 'modbus') {
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
        await onSaveDevice(finalConfig);
        handleClose();
      } catch (err: any) {
        setError(err.message || 'Failed to save device');
      } finally {
        setLoading(false);
      }
    } else if (selectedProtocol === 'opcua') {
      if (!opcuaConfig || !opcuaFormValid) {
        setError('Please complete all required fields');
        return;
      }

      // OPC UA uses auto-discovery, nodes are optional
      // User can add nodes manually or let discovery populate them

      // Combine config with data points (omit dataPoints if empty for auto-discovery)
      const finalConfig: OPCUADeviceConfig = {
        ...opcuaConfig,
        ...(opcuaDataPoints.length > 0 && { dataPoints: opcuaDataPoints }),
      } as OPCUADeviceConfig;

      try {
        setLoading(true);
        await onSaveDevice(finalConfig);
        handleClose();
      } catch (err: any) {
        setError(err.message || 'Failed to save device');
      } finally {
        setLoading(false);
      }
    }
  };

  const handleClose = () => {
    setError(null);
    setModbusConfig(null);
    setModbusDataPoints([]);
    setOpcuaConfig(null);
    setOpcuaDataPoints([]);
    setSelectedProtocol('modbus');
    onOpenChange(false);
  };

  const canSave = () => {
    if (selectedProtocol === 'modbus') {
      // Modbus requires at least one register mapping
      return modbusFormValid && modbusDataPoints.length > 0;
    } else if (selectedProtocol === 'opcua') {
      // OPC UA uses auto-discovery, nodes are optional
      return opcuaFormValid;
    }
    return false;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="!grid !grid-rows-[auto,1fr,auto] !gap-0 !h-[85vh] !max-h-[85vh] w-[720px] max-w-[95vw] sm:max-w-[95vw] !p-0 overflow-hidden">
        <DialogHeader className="px-6 py-4">
          <DialogTitle>Add Device</DialogTitle>
          <DialogDescription>
            Configure a protocol device to collect device data
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-6">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2 text-left">
            <label className="text-sm font-medium text-foreground" htmlFor="protocol-select">
              Protocol
            </label>
            <Select
              value={selectedProtocol}
              onValueChange={(value) => setSelectedProtocol(value as 'modbus' | 'opcua')}
            >
              <SelectTrigger id="protocol-select" className="h-11 text-left">
                <SelectValue placeholder="Select protocol" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="modbus">Modbus TCP/RTU</SelectItem>
                <SelectItem value="opcua">OPC-UA</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {selectedProtocol === 'modbus' && (
            <div className="space-y-6">
              <ModbusConfigForm
                onChange={setModbusConfig}
                onValidationChange={setModbusFormValid}
                onDataPointsChange={setModbusDataPoints}
              />

              <DataPointsTable
                value={modbusDataPoints}
                onChange={setModbusDataPoints}
              />
            </div>
          )}

          {selectedProtocol === 'opcua' && (
            <div className="space-y-6">
              <OPCUAConfigForm
                onChange={setOpcuaConfig}
                onValidationChange={setOpcuaFormValid}
              />

              <OPCUADataPointsTable
                dataPoints={opcuaDataPoints}
                onChange={setOpcuaDataPoints}
              />
            </div>
          )}
        </div>

        <DialogFooter className="px-6 py-4">
          <Button variant="outline" onClick={handleClose} disabled={loading}>
            Cancel
          </Button>
          <Button 
            onClick={handleSave} 
            disabled={!canSave() || loading}
          >
            {loading ? 'Saving...' : 'Save Device'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
