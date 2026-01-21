/**
 * Data Points Table Component
 * 
 * Visual editor for Modbus register configurations.
 * Supports Add/Edit/Delete operations with validation.
 */

import React, { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import {
  type ModbusDataPoint,
  type ModbusRegisterType,
  getRegisterCount,
  requiresByteOrder,
  getFunctionCodeInfo,
  getDefaultDataPoint,
} from '@/schemas/sensor-schemas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Plus, Edit, Trash2, Info } from 'lucide-react';

interface DataPointsTableProps {
  value: ModbusDataPoint[];
  onChange: (dataPoints: ModbusDataPoint[]) => void;
}

export const DataPointsTable: React.FC<DataPointsTableProps> = ({
  value,
  onChange,
}) => {
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const {
    register,
    control,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<ModbusDataPoint>();

  const selectedDataType = watch('dataType');
  const selectedRegisterType = watch('type');

  const handleAdd = () => {
    setEditingIndex(null);
    reset(getDefaultDataPoint('modbus') as ModbusDataPoint);
    setEditDialogOpen(true);
  };

  const handleEdit = (index: number) => {
    setEditingIndex(index);
    reset(value[index]);
    setEditDialogOpen(true);
  };

  const handleDelete = (index: number) => {
    const newDataPoints = value.filter((_, i) => i !== index);
    onChange(newDataPoints);
  };

  const onSubmit = (data: ModbusDataPoint) => {
    // Auto-set count based on data type if not string
    if (data.dataType !== 'string') {
      data.count = getRegisterCount(data.dataType);
    }

    if (editingIndex !== null) {
      // Update existing
      const newDataPoints = [...value];
      newDataPoints[editingIndex] = data;
      onChange(newDataPoints);
    } else {
      // Add new
      onChange([...value, data]);
    }
    
    setEditDialogOpen(false);
  };

  const getFunctionCodeBadge = (type: ModbusRegisterType) => {
    const info = getFunctionCodeInfo(type);
    const label = `FC${info.read}${info.write ? `/${info.write}` : ''}`;
    const variant = info.readonly ? 'secondary' : 'default';
    
    return (
      <Badge variant={variant} className="text-xs">
        {label}
      </Badge>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Data Points (Registers)</h3>
          <p className="text-xs text-muted-foreground">
            Configure Modbus registers to read/write
          </p>
        </div>
        <Button onClick={handleAdd} size="sm">
          <Plus className="h-4 w-4 mr-2" />
          Add Data Point
        </Button>
      </div>

      {value.length === 0 ? (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            No data points configured. Click "Add Data Point" to start monitoring Modbus registers.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Data Type</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {value.map((dataPoint, index) => (
                <TableRow key={index}>
                  <TableCell className="font-medium">{dataPoint.name}</TableCell>
                  <TableCell>{dataPoint.address}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="capitalize">{dataPoint.type}</span>
                      {getFunctionCodeBadge(dataPoint.type)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="uppercase">{dataPoint.dataType}</span>
                      {requiresByteOrder(dataPoint.dataType) && dataPoint.byteOrder && (
                        <Badge variant="outline" className="text-xs">
                          {dataPoint.byteOrder}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{dataPoint.unit || '-'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleEdit(index)}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(index)}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingIndex !== null ? 'Edit Data Point' : 'Add Data Point'}
            </DialogTitle>
            <DialogDescription>
              Configure a Modbus register to monitor
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="dp-name">
                Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="dp-name"
                {...register('name', { required: 'Name is required' })}
                placeholder="e.g., temperature, voltage"
              />
              {errors.name && (
                <p className="text-sm text-red-500">{errors.name.message}</p>
              )}
            </div>

            {/* Address and Type */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="dp-address">
                  Register Address <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="dp-address"
                  type="number"
                  {...register('address', { 
                    required: 'Address is required',
                    valueAsNumber: true,
                    min: { value: 0, message: 'Address must be 0 or greater' },
                    max: { value: 65535, message: 'Address must be 65535 or less' }
                  })}
                  placeholder="0"
                />
                {errors.address && (
                  <p className="text-sm text-red-500">{errors.address.message}</p>
                )}
                <p className="text-xs text-muted-foreground">0-65535</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="dp-type">
                  Register Type <span className="text-red-500">*</span>
                </Label>
                <Controller
                  name="type"
                  control={control}
                  rules={{ required: 'Register type is required' }}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="dp-type">
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="holding">Holding (FC3/FC16)</SelectItem>
                        <SelectItem value="input">Input (FC4 - Read Only)</SelectItem>
                        <SelectItem value="coil">Coil (FC1/FC5)</SelectItem>
                        <SelectItem value="discrete">Discrete (FC2 - Read Only)</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.type && (
                  <p className="text-sm text-red-500">{errors.type.message}</p>
                )}
                {selectedRegisterType && getFunctionCodeInfo(selectedRegisterType).readonly && (
                  <p className="text-xs text-yellow-600">Read-only register type</p>
                )}
              </div>
            </div>

            {/* Data Type and Byte Order */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="dp-dataType">
                  Data Type <span className="text-red-500">*</span>
                </Label>
                <Controller
                  name="dataType"
                  control={control}
                  rules={{ required: 'Data type is required' }}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="dp-dataType">
                        <SelectValue placeholder="Select data type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="int16">INT16 (1 register)</SelectItem>
                        <SelectItem value="uint16">UINT16 (1 register)</SelectItem>
                        <SelectItem value="int32">INT32 (2 registers)</SelectItem>
                        <SelectItem value="uint32">UINT32 (2 registers)</SelectItem>
                        <SelectItem value="float32">FLOAT32 (2 registers)</SelectItem>
                        <SelectItem value="boolean">Boolean (1 register)</SelectItem>
                        <SelectItem value="string">String (multi-register)</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.dataType && (
                  <p className="text-sm text-red-500">{errors.dataType.message}</p>
                )}
              </div>

              {selectedDataType && requiresByteOrder(selectedDataType) && (
                <div className="space-y-2">
                  <Label htmlFor="dp-byteOrder">Byte Order</Label>
                  <Controller
                    name="byteOrder"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id="dp-byteOrder">
                          <SelectValue placeholder="Select byte order" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ABCD">ABCD (Big-endian)</SelectItem>
                          <SelectItem value="CDAB">CDAB (Word-swapped)</SelectItem>
                          <SelectItem value="BADC">BADC (Byte-swapped)</SelectItem>
                          <SelectItem value="DCBA">DCBA (Little-endian)</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <p className="text-xs text-muted-foreground">
                    Common: ABCD (Modbus standard) or CDAB (inverters/meters)
                  </p>
                </div>
              )}

              {selectedDataType === 'string' && (
                <div className="space-y-2">
                  <Label htmlFor="dp-count">Register Count</Label>
                  <Input
                    id="dp-count"
                    type="number"
                    {...register('count', { valueAsNumber: true })}
                    placeholder="1"
                  />
                  <p className="text-xs text-muted-foreground">
                    Number of registers for string (max 125)
                  </p>
                </div>
              )}
            </div>

            {/* Unit, Scale, Offset */}
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="dp-unit">Unit</Label>
                <Input
                  id="dp-unit"
                  {...register('unit')}
                  placeholder="e.g., °C, V, A"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="dp-scale">Scale Factor</Label>
                <Input
                  id="dp-scale"
                  type="number"
                  step="any"
                  {...register('scale', { valueAsNumber: true })}
                  placeholder="1"
                />
                <p className="text-xs text-muted-foreground">value × scale</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="dp-offset">Offset</Label>
                <Input
                  id="dp-offset"
                  type="number"
                  step="any"
                  {...register('offset', { valueAsNumber: true })}
                  placeholder="0"
                />
                <p className="text-xs text-muted-foreground">+ offset</p>
              </div>
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="dp-description">Description</Label>
              <Input
                id="dp-description"
                {...register('description')}
                placeholder="Optional description"
              />
            </div>

            {/* String Encoding (if string type) */}
            {selectedDataType === 'string' && (
              <div className="space-y-2">
                <Label htmlFor="dp-encoding">Encoding</Label>
                <Controller
                  name="encoding"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="dp-encoding">
                        <SelectValue placeholder="Select encoding" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ascii">ASCII</SelectItem>
                        <SelectItem value="utf8">UTF-8</SelectItem>
                        <SelectItem value="latin1">Latin-1</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit">
                {editingIndex !== null ? 'Update' : 'Add'} Data Point
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};
