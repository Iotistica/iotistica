/**
 * Modbus Configuration Form
 * 
 * React Hook Form component for configuring Modbus TCP/RTU devices.
 * Provides validated input fields with real-time error feedback.
 */

import React, { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import {
  type ModbusDeviceConfig,
  type ModbusConnectionType,
  getDefaultConnection,
} from '@/schemas/sensor-schemas';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';

interface ModbusConfigFormProps {
  value?: ModbusDeviceConfig;
  onChange?: (config: ModbusDeviceConfig) => void;
  onValidationChange?: (isValid: boolean) => void;
  onDataPointsChange?: (dataPoints: any[]) => void;
}

export const ModbusConfigForm: React.FC<ModbusConfigFormProps> = ({
  value,
  onChange,
  onValidationChange,
}) => {
  const {
    register,
    control,
    watch,
    formState: { errors },
    setValue,
    getValues,
    reset,
  } = useForm<ModbusDeviceConfig>({
    mode: 'onChange',
    defaultValues: value || {
      name: '',
      protocol: 'modbus',
      enabled: true,
      pollInterval: 5000,
      connection: getDefaultConnection('modbus') as ModbusDeviceConfig['connection'],
      dataPoints: [],
    },
  });

  // Reset form only when component first mounts with initial value
  // Using a ref to track if we've already initialized prevents resetting on every parent re-render
  const initializedRef = React.useRef(false);
  useEffect(() => {
    if (value && !initializedRef.current) {
      reset(value);
      initializedRef.current = true;
    }
  }, [value?.name, reset]); // Only re-initialize if device name changes (different device)

  const connectionType = watch('connection.type');

  // Notify parent of validation state changes
  useEffect(() => {
    const formData = getValues();
    let isValid = false;
    
    // Check name is filled
    if (!formData.name || formData.name.trim() === '') {
      isValid = false;
    } else if (formData.connection.type === 'tcp') {
      // Validate TCP connection
      const conn = formData.connection as any;
      isValid = !!(conn.host && conn.host.trim() !== '' && conn.port);
    } else if (formData.connection.type === 'rtu') {
      // Validate RTU connection
      const conn = formData.connection as any;
      isValid = !!(conn.serialPort && conn.serialPort.trim() !== '' && conn.baudRate);
    }
    
    onValidationChange?.(isValid);
  }, [watch('name'), watch('connection'), onValidationChange, getValues]);

  // Notify parent of form value changes
  useEffect(() => {
    const handleChange = () => {
      const formData = getValues();
      onChange?.(formData as ModbusDeviceConfig);
    };
    
    const subscription = watch(handleChange);
    return () => {
      if (subscription && 'unsubscribe' in subscription) {
        (subscription as any).unsubscribe();
      }
    };
  }, [watch, onChange, getValues]);

  const handleConnectionTypeChange = (type: ModbusConnectionType) => {
    const currentConnection = getValues('connection');
    
    if (type === 'tcp') {
      setValue('connection', {
        type: 'tcp',
        host: (currentConnection as any).host || '10.0.0.60',
        port: (currentConnection as any).port || 502,
        slaveId: (currentConnection as any).slaveId || 1,
        timeout: currentConnection.timeout || 5000,
      });
    } else if (type === 'rtu') {
      setValue('connection', {
        type: 'rtu',
        serialPort: (currentConnection as any).serialPort || '/dev/ttyUSB0',
        baudRate: (currentConnection as any).baudRate || 9600,
        dataBits: (currentConnection as any).dataBits || 8,
        stopBits: (currentConnection as any).stopBits || 1,
        parity: (currentConnection as any).parity || 'none',
        slaveId: (currentConnection as any).slaveId || 1,
        timeout: currentConnection.timeout || 5000,
      });
    }
  };

  return (
    <div className="space-y-3">
      {/* Device Name */}
      <div className="space-y-1.5">
        <Label htmlFor="name" className="text-sm">
          Device Name <span className="text-red-500">*</span>
        </Label>
        <Input
          id="name"
          {...register('name')}
          placeholder="e.g., power_meter_1"
          className="h-9"
        />
        {errors.name && (
          <p className="text-xs text-red-500">{errors.name.message}</p>
        )}
        <p className="text-xs text-muted-foreground">
          Unique identifier (letters, numbers, hyphens, underscores only)
        </p>
      </div>

      {/* Connection Type */}
      <div className="space-y-3">
        <Label>
          Connection Type <span className="text-red-500">*</span>
        </Label>
        <Controller
          name="connection.type"
          control={control}
          render={({ field }) => (
            <RadioGroup
              value={field.value}
              onValueChange={(value) => {
                field.onChange(value);
                handleConnectionTypeChange(value as ModbusConnectionType);
              }}
              className="flex gap-4"
            >
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="tcp" id="tcp" />
                <Label htmlFor="tcp" className="font-normal cursor-pointer">
                  Modbus TCP
                </Label>
              </div>
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="rtu" id="rtu" />
                <Label htmlFor="rtu" className="font-normal cursor-pointer">
                  Modbus RTU (Serial)
                </Label>
              </div>
            </RadioGroup>
          )}
        />
      </div>

      {/* TCP Connection Fields */}
      {connectionType === 'tcp' && (
        <div className="space-y-3 p-3 border border-border rounded-lg">
          <h3 className="text-sm font-semibold">TCP Connection</h3>
          
          {/* Single row for Host, Port, Slave ID - truly horizontal */}
          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="host" className="text-xs">
                Host <span className="text-red-500">*</span>
              </Label>
              <Input
                id="host"
                {...register('connection.host')}
                placeholder="10.0.0.60"
                className="h-9"
              />
            </div>

            <div className="w-24 space-y-1.5">
              <Label htmlFor="port" className="text-xs">
                Port <span className="text-red-500">*</span>
              </Label>
              <Input
                id="port"
                type="number"
                {...register('connection.port', { valueAsNumber: true })}
                placeholder="502"
                className="h-9"
              />
            </div>

            <div className="w-24 space-y-1.5">
              <Label htmlFor="tcp-slaveId" className="text-xs">
                Slave ID <span className="text-red-500">*</span>
              </Label>
              <Input
                id="tcp-slaveId"
                type="number"
                {...register('connection.slaveId', { valueAsNumber: true })}
                placeholder="1"
                min="1"
                max="247"
                disabled={!!watch('connection.slaveRange')}
                className="h-9"
              />
            </div>
          </div>

          {/* Slave Range for Discovery - Compact */}
          <div className="space-y-2 pt-2">
            <div className="flex items-center gap-1.5">
              <input
                type="checkbox"
                id="tcp-useSlaveRange"
                checked={!!watch('connection.slaveRange')}
                onChange={(e) => {
                  if (e.target.checked) {
                    setValue('connection.slaveRange', { start: 1, end: 247 });
                    setValue('connection.slaveId', undefined as any);
                  } else {
                    setValue('connection.slaveRange', undefined as any);
                    setValue('connection.slaveId', 1);
                  }
                }}
              />
              <Label htmlFor="tcp-useSlaveRange" className="text-xs cursor-pointer">
                Scan slave range
              </Label>
            </div>
            {watch('connection.slaveRange') && (
              <div className="grid grid-cols-2 gap-3 ml-6">
                <div className="space-y-1.5">
                  <Label htmlFor="tcp-slaveRange-start" className="text-xs">Start ID</Label>
                  <Input
                    id="tcp-slaveRange-start"
                    type="number"
                    {...register('connection.slaveRange.start', { valueAsNumber: true })}
                    placeholder="1"
                    min="1"
                    max="247"
                    className="h-9"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tcp-slaveRange-end" className="text-xs">End ID</Label>
                  <Input
                    id="tcp-slaveRange-end"
                    type="number"
                    {...register('connection.slaveRange.end', { valueAsNumber: true })}
                    placeholder="247"
                    min="1"
                    max="247"
                    className="h-9"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 pt-2">
            <div className="space-y-1.5">
              <Label htmlFor="timeout" className="text-xs">Timeout</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="timeout"
                  type="number"
                  {...register('connection.timeout', { valueAsNumber: true })}
                  placeholder="5000"
                  className="h-9"
                />
                <span className="text-xs text-muted-foreground">ms</span>
              </div>
              {errors.connection?.timeout && (
                <p className="text-xs text-red-500">{errors.connection.timeout.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pollInterval" className="text-xs">Poll Interval</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="pollInterval"
                  type="number"
                  {...register('pollInterval', { valueAsNumber: true })}
                  placeholder="5000"
                  className="h-9"
                />
                <span className="text-xs text-muted-foreground">ms</span>
              </div>
              {errors.pollInterval && (
                <p className="text-xs text-red-500">{errors.pollInterval.message}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* RTU Connection Fields */}
      {connectionType === 'rtu' && (
        <div className="space-y-4 p-4 border border-border rounded-lg">
          <h3 className="text-sm font-semibold">RTU Serial Connection Settings</h3>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="serialPort">
                Serial Port <span className="text-red-500">*</span>
              </Label>
              <Input
                id="serialPort"
                {...register('connection.serialPort')}
                placeholder="/dev/ttyUSB0 (Linux) or COM3 (Windows)"
              />
              <p className="text-xs text-muted-foreground">
                Device path (e.g., /dev/ttyUSB0, /dev/ttyS0, COM3)
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="baudRate">Baud Rate</Label>
                <Controller
                  name="connection.baudRate"
                  control={control}
                  render={({ field }) => (
                    <Select
                      value={field.value?.toString()}
                      onValueChange={(value) => field.onChange(parseInt(value))}
                    >
                      <SelectTrigger id="baudRate">
                        <SelectValue placeholder="Select baud rate" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="9600">9600</SelectItem>
                        <SelectItem value="19200">19200</SelectItem>
                        <SelectItem value="38400">38400</SelectItem>
                        <SelectItem value="57600">57600</SelectItem>
                        <SelectItem value="115200">115200</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="parity">Parity</Label>
                <Controller
                  name="connection.parity"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="parity">
                        <SelectValue placeholder="Select parity" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="even">Even</SelectItem>
                        <SelectItem value="odd">Odd</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="dataBits">Data Bits</Label>
                <Input
                  id="dataBits"
                  type="number"
                  {...register('connection.dataBits', { valueAsNumber: true })}
                  placeholder="8"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="stopBits">Stop Bits</Label>
                <Input
                  id="stopBits"
                  type="number"
                  {...register('connection.stopBits', { valueAsNumber: true })}
                  placeholder="1"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="rtu-slaveId">
                Slave ID <span className="text-red-500">*</span>
              </Label>
              <Input
                id="rtu-slaveId"
                type="number"
                {...register('connection.slaveId', { valueAsNumber: true })}
                placeholder="1"
                min="1"
                max="247"
                disabled={!!watch('connection.slaveRange')}
              />
              <p className="text-xs text-muted-foreground">
                Modbus device address (1-247)
              </p>
            </div>

            {/* Slave Range for Discovery */}
            <div className="space-y-2">
              <div className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  id="rtu-useSlaveRange"
                  checked={!!watch('connection.slaveRange')}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setValue('connection.slaveRange', { start: 1, end: 247 });
                      setValue('connection.slaveId', undefined as any);
                    } else {
                      setValue('connection.slaveRange', undefined as any);
                      setValue('connection.slaveId', 1);
                    }
                  }}
                />
                <Label htmlFor="rtu-useSlaveRange" className="cursor-pointer">
                  Scan slave range
                </Label>
              </div>
              {watch('connection.slaveRange') && (
                <div className="grid grid-cols-2 gap-4 ml-6">
                  <div className="space-y-2">
                    <Label htmlFor="rtu-slaveRange-start">
                      Start Slave ID
                    </Label>
                    <Input
                      id="rtu-slaveRange-start"
                      type="number"
                      {...register('connection.slaveRange.start', { valueAsNumber: true })}
                      placeholder="1"
                      min="1"
                      max="247"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rtu-slaveRange-end">
                      End Slave ID
                    </Label>
                    <Input
                      id="rtu-slaveRange-end"
                      type="number"
                      {...register('connection.slaveRange.end', { valueAsNumber: true })}
                      placeholder="247"
                      min="1"
                      max="247"
                    />
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Scans a range of slave IDs to find devices
              </p>
            </div>
          </div>
        </div>
      )}

      <div
        className="flex items-center"
        style={{ columnGap: '12px', paddingTop: '10px', paddingBottom: '20px' }}
      >
        <Controller
          name="enabled"
          control={control}
          render={({ field }) => (
            <>
              <Checkbox
                id="enabled"
                checked={field.value}
                onCheckedChange={field.onChange}
              />
              <Label htmlFor="enabled" className="font-normal cursor-pointer text-sm">
                Enabled
              </Label>
            </>
          )}
        />
      </div>
    </div>
  );
};
