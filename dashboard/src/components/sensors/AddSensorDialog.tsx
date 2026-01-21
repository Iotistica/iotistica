/**
 * Unified Add Sensor Dialog
 * Handles both:
 * 1. Sensor-publish pipelines (local data collection via sockets/pipes)
 * 2. Protocol adapter devices (hardware sensors: Modbus, CAN, OPC-UA)
 */

import React, { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Info, AlertCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { canPerformDeviceActions, getDisabledActionMessage } from "@/utils/devicePermissions";


interface DataPoint {
  name: string;
  address?: number; // For Modbus
  type?: string; // 'coil' | 'discrete' | 'holding' | 'input' for Modbus, or data type
  dataType?: string; // 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64'
  unit?: string;
  scale?: number;
  offset?: number;
  // CAN-specific
  pgn?: number;
  spn?: number;
  // OPC-UA-specific
  nodeId?: string;
}

interface ProtocolAdapterDevice {
  name: string;
  protocol: 'modbus' | 'can' | 'opcua';
  enabled: boolean;
  pollInterval: number;
  connection: any;
  dataPoints?: DataPoint[];
  metadata?: Record<string, any>;
}

interface AddSensorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaveDevice: (device: ProtocolAdapterDevice) => Promise<void>;
  deviceUuid: string;
}

export const AddSensorDialog: React.FC<AddSensorDialogProps> = ({ 
  open, 
  onOpenChange, 

  onSaveDevice
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Device form state

  const [deviceName, setDeviceName] = useState('');
  const [deviceProtocol, setDeviceProtocol] = useState<'modbus' | 'can' | 'opcua'>('modbus');
  const [deviceEnabled, setDeviceEnabled] = useState(true);
  const [devicePollInterval, setDevicePollInterval] = useState(5000);
  
  // JSON configuration (unified for all protocols)
  const [connectionJson, setConnectionJson] = useState('{\n  "type": "tcp",\n  "host": "192.168.1.100",\n  "port": 502,\n  "unitId": 1\n}');
  const [dataPointsJson, setDataPointsJson] = useState('[\n  {\n    "name": "temperature",\n    "address": 0,\n    "type": "holding",\n    "dataType": "float32",\n    "unit": "°C"\n  }\n]');

  const handleSaveDevice = async () => {
    setError(null);

    if (!deviceName.trim()) {
      setError('Device name is required');
      return;
    }

    // Parse and validate JSON
    let connection: any;
    let dataPoints: any;

    try {
      connection = JSON.parse(connectionJson);
    } catch (err) {
      setError('Invalid connection JSON: ' + (err as Error).message);
      return;
    }

    try {
      dataPoints = JSON.parse(dataPointsJson);
    } catch (err) {
      setError('Invalid data points JSON: ' + (err as Error).message);
      return;
    }

    const device: ProtocolAdapterDevice = {
      name: deviceName.trim(),
      protocol: deviceProtocol,
      enabled: deviceEnabled,
      pollInterval: devicePollInterval,
      connection,
      dataPoints,
      metadata: {
        createdAt: new Date().toISOString(),
        createdBy: 'dashboard'
      }
    };

    console.log('💾 Saving protocol adapter device:', JSON.stringify(device, null, 2));

    try {
      setLoading(true);
      await onSaveDevice(device);
      handleClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save protocol adapter device');
    } finally {
      setLoading(false);
    }
  };

  const getProtocolExamples = () => {
    switch (deviceProtocol) {
      case 'modbus':
        return {
          connection: '{\n  "type": "tcp",\n  "host": "192.168.1.100",\n  "port": 502,\n  "unitId": 1\n}',
          dataPoints: '[\n  {\n    "name": "temperature",\n    "address": 0,\n    "type": "holding",\n    "dataType": "float32",\n    "unit": "°C"\n  }\n]'
        };
      case 'can':
        return {
          connection: '{\n  "interface": "can0",\n  "bitrate": 500000,\n  "protocol": "j1939"\n}',
          dataPoints: '[\n  {\n    "pgn": 61444,\n    "name": "engine_speed",\n    "spn": 190,\n    "type": "uint16",\n    "unit": "rpm"\n  }\n]'
        };
      case 'opcua':
        return {
          connection: '{\n  "endpointUrl": "opc.tcp://192.168.1.50:4840",\n  "securityPolicy": "None",\n  "securityMode": "None"\n}',
          dataPoints: '[\n  {\n    "nodeId": "ns=2;s=Temperature",\n    "name": "temperature",\n    "type": "Double"\n  }\n]'
        };
    }
  };

  const loadProtocolExample = () => {
    const examples = getProtocolExamples();
    setConnectionJson(examples.connection);
    setDataPointsJson(examples.dataPoints);
  };

  const handleClose = () => {
    setDeviceName('');
    setError(null);
    setConnectionJson('{\n  "type": "tcp",\n  "host": "192.168.1.100",\n  "port": 502,\n  "unitId": 1\n}');
    setDataPointsJson('[\n  {\n    "name": "temperature",\n    "address": 0,\n    "type": "holding",\n    "dataType": "float32",\n    "unit": "°C"\n  }\n]');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Sensor</DialogTitle>
          <DialogDescription>
            Configure a hardware sensor device (Modbus RTU/TCP, CAN Bus, OPC-UA). The device will be polled automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                Configure a hardware sensor device (Modbus RTU/TCP, CAN Bus, OPC-UA). The device will be polled automatically.
              </AlertDescription>
            </Alert>

            <div className="space-y-4">
              {/* Device Name */}
              <div className="space-y-2">
                <Label htmlFor="deviceName">Device Name *</Label>
                <Input
                  id="deviceName"
                  placeholder="e.g., temperature-sensor, flow-meter"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                />
              </div>

              {/* Protocol */}
              <div className="space-y-2">
                <Label htmlFor="deviceProtocol">Protocol *</Label>
                <Select value={deviceProtocol} onValueChange={(value: any) => setDeviceProtocol(value)}>
                  <SelectTrigger id="deviceProtocol">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="modbus">Modbus (RTU/TCP)</SelectItem>
                    <SelectItem value="can">CAN Bus</SelectItem>
                    <SelectItem value="opcua">OPC-UA</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Enabled Checkbox */}
              <div className="flex items-center space-x-2">
                <Checkbox 
                  id="deviceEnabled" 
                  checked={deviceEnabled}
                  onCheckedChange={(checked) => setDeviceEnabled(checked as boolean)}
                />
                <Label htmlFor="deviceEnabled" className="cursor-pointer">
                  Enable device immediately after creation
                </Label>
              </div>

              {/* Poll Interval */}
              <div className="space-y-2">
                <Label htmlFor="devicePollInterval">Poll Interval (ms)</Label>
                <Input
                  id="devicePollInterval"
                  type="number"
                  value={devicePollInterval}
                  onChange={(e) => setDevicePollInterval(parseInt(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">How often to read data from the device</p>
              </div>

              {/* Protocol-specific configuration (JSON) */}
              <Card className="p-4 space-y-4 bg-muted/50">
                <div className="flex items-center justify-between">
                  <h4 className="font-medium">Configuration (JSON)</h4>
                  <Button 
                    type="button" 
                    size="sm" 
                    variant="outline" 
                    onClick={loadProtocolExample}
                  >
                    Load Example
                  </Button>
                </div>

                {/* Connection JSON */}
                <div className="space-y-2">
                  <Label htmlFor="connectionJson">Connection Configuration</Label>
                  <textarea
                    id="connectionJson"
                    className="w-full h-32 p-3 border border-input rounded-md font-mono text-sm bg-background text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    value={connectionJson}
                    onChange={(e) => setConnectionJson(e.target.value)}
                    placeholder="Enter connection configuration as JSON"
                  />
                  <p className="text-xs text-muted-foreground">
                    {deviceProtocol === 'modbus' && 'Example: {"type": "tcp", "host": "192.168.1.100", "port": 502, "unitId": 1}'}
                    {deviceProtocol === 'can' && 'Example: {"interface": "can0", "bitrate": 500000, "protocol": "j1939"}'}
                    {deviceProtocol === 'opcua' && 'Example: {"endpointUrl": "opc.tcp://....", "securityPolicy": "None"}'}
                  </p>
                </div>

                {/* Data Points JSON */}
                <div className="space-y-2">
                  <Label htmlFor="dataPointsJson">
                    {deviceProtocol === 'modbus' && 'Data Points (Registers)'}
                    {deviceProtocol === 'can' && 'Data Points (Messages)'}
                    {deviceProtocol === 'opcua' && 'Data Points (Nodes)'}
                  </Label>
                  <textarea
                    id="dataPointsJson"
                    className="w-full h-48 p-3 border border-input rounded-md font-mono text-sm bg-background text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    value={dataPointsJson}
                    onChange={(e) => setDataPointsJson(e.target.value)}
                    placeholder={`Enter ${deviceProtocol} data points as JSON array`}
                  />
                  <p className="text-xs text-muted-foreground">
                    {deviceProtocol === 'modbus' && 'Example: [{"name": "temperature", "address": 0, "type": "holding", "dataType": "float32"}]'}
                    {deviceProtocol === 'can' && 'Example: [{"pgn": 61444, "name": "engine_speed", "type": "uint16"}]'}
                    {deviceProtocol === 'opcua' && 'Example: [{"nodeId": "ns=2;s=Temperature", "name": "temp", "type": "Double"}]'}
                  </p>
                </div>

                {/* Protocol hints */}
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertDescription>
                    {deviceProtocol === 'modbus' && 'Modbus TCP/RTU protocol. Configure connection (TCP or serial) and register mappings.'}
                    {deviceProtocol === 'can' && 'CAN Bus protocol (J1939, CANopen). Configure interface, bitrate, and message definitions.'}
                    {deviceProtocol === 'opcua' && 'OPC-UA protocol. Configure endpoint URL, security settings, and node subscriptions.'}
                  </AlertDescription>
                </Alert>
              </Card>
            </div>
          </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={loading}>
            Cancel
          </Button>
          <Button 
            onClick={handleSaveDevice} 
            disabled={loading}
          >
            {loading ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
