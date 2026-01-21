/**
 * Add Sensor Dialog
 * 
 * Tabbed interface for protocol-specific device configuration.
 * Supports: Modbus TCP/RTU, OPC-UA
 * Uses React Hook Form with validation.
 */

import React, { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
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
      return modbusFormValid && modbusDataPoints.length > 0;
    } else if (selectedProtocol === 'opcua') {
      return opcuaFormValid && opcuaDataPoints.length > 0;
    }
    return false;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Add Device</DialogTitle>
          <DialogDescription>
            Configure a protocol device to collect sensor data
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Tabs value={selectedProtocol} onValueChange={(v) => setSelectedProtocol(v as 'modbus' | 'opcua')} className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="modbus">Modbus TCP/RTU</TabsTrigger>
            <TabsTrigger value="opcua">OPC-UA</TabsTrigger>
          </TabsList>

          <TabsContent value="modbus" className="flex-1 overflow-y-auto space-y-6 mt-4">
            <ModbusConfigForm 
              value={modbusConfig || undefined}
              onChange={setModbusConfig}
              onValidationChange={setModbusFormValid}
            />

            <DataPointsTable
              value={modbusDataPoints}
              onChange={setModbusDataPoints}
            />
          </TabsContent>

          <TabsContent value="opcua" className="flex-1 overflow-y-auto space-y-6 mt-4">
            <OPCUAConfigForm 
              value={opcuaConfig || undefined}
              onChange={setOpcuaConfig}
              onValidationChange={setOpcuaFormValid}
            />

            <OPCUADataPointsTable
              dataPoints={opcuaDataPoints}
              onChange={setOpcuaDataPoints}
            />
          </TabsContent>
        </Tabs>

        <DialogFooter>
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
