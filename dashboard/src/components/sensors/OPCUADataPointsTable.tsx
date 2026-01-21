/**
 * OPC-UA Data Points Table
 * 
 * Visual editor for OPC-UA node configuration with Add/Edit/Delete functionality.
 * Provides validated input fields with automatic data type suggestions.
 */

import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { OPCUADataPoint } from '@/schemas/sensor-schemas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PlusIcon, TrashIcon, PencilIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface OPCUADataPointsTableProps {
  dataPoints: OPCUADataPoint[];
  onChange: (dataPoints: OPCUADataPoint[]) => void;
}

export const OPCUADataPointsTable: React.FC<OPCUADataPointsTableProps> = ({
  dataPoints,
  onChange,
}) => {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<OPCUADataPoint>({
    defaultValues: {
      name: '',
      nodeId: '',
      dataType: 'Double',
      namespace: 0,
      scale: 1,
      offset: 0,
      unit: '',
    },
  });

  const handleAdd = () => {
    reset({
      name: '',
      nodeId: '',
      dataType: 'Double',
      namespace: 0,
      scale: 1,
      offset: 0,
      unit: '',
    });
    setEditingIndex(null);
    setIsDialogOpen(true);
  };

  const handleEdit = (index: number) => {
    const point = dataPoints[index];
    reset(point);
    setEditingIndex(index);
    setIsDialogOpen(true);
  };

  const handleDelete = (index: number) => {
    const updated = dataPoints.filter((_, i) => i !== index);
    onChange(updated);
  };

  const onSubmit = (data: OPCUADataPoint) => {
    let updated: OPCUADataPoint[];
    
    if (editingIndex !== null) {
      // Edit existing
      updated = dataPoints.map((point, i) => (i === editingIndex ? data : point));
    } else {
      // Add new
      updated = [...dataPoints, data];
    }
    
    onChange(updated);
    setIsDialogOpen(false);
    reset();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Node IDs ({dataPoints.length})
        </h3>
        <Button onClick={handleAdd} size="sm" variant="outline">
          <PlusIcon className="w-4 h-4 mr-2" />
          Add Node
        </Button>
      </div>

      {dataPoints.length === 0 ? (
        <div className="text-center p-8 border border-dashed border-border rounded-lg">
          <p className="text-sm text-muted-foreground">
            No nodes configured yet. Click "Add Node" to get started.
          </p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Node ID</TableHead>
                <TableHead>Namespace</TableHead>
                <TableHead>Data Type</TableHead>
                <TableHead>Scale</TableHead>
                <TableHead>Offset</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead className="w-24">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dataPoints.map((point, index) => (
                <TableRow key={index}>
                  <TableCell className="font-medium">{point.name}</TableCell>
                  <TableCell className="font-mono text-xs">{point.nodeId}</TableCell>
                  <TableCell>{point.namespace}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                      {point.dataType}
                    </span>
                  </TableCell>
                  <TableCell>{point.scale !== 1 ? point.scale : '-'}</TableCell>
                  <TableCell>{point.offset !== 0 ? point.offset : '-'}</TableCell>
                  <TableCell>{point.unit || '-'}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button
                        onClick={() => handleEdit(index)}
                        size="sm"
                        variant="ghost"
                      >
                        <PencilIcon className="w-4 h-4" />
                      </Button>
                      <Button
                        onClick={() => handleDelete(index)}
                        size="sm"
                        variant="ghost"
                        className="text-red-600 hover:text-red-700"
                      >
                        <TrashIcon className="w-4 h-4" />
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
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingIndex !== null ? 'Edit Node' : 'Add Node'}
            </DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="node-name">
                Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="node-name"
                {...register('name', { required: 'Name is required' })}
                placeholder="e.g., temperature"
              />
              {errors.name && (
                <p className="text-sm text-red-500">{errors.name.message}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Variable identifier (letters, numbers, underscores)
              </p>
            </div>

            {/* Node ID and Namespace */}
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2 space-y-2">
                <Label htmlFor="nodeId">
                  Node ID <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="nodeId"
                  {...register('nodeId', { required: 'Node ID is required' })}
                  placeholder="e.g., Temperature or 1001"
                />
                {errors.nodeId && (
                  <p className="text-sm text-red-500">{errors.nodeId.message}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  String identifier or numeric ID
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="namespace">Namespace</Label>
                <Input
                  id="namespace"
                  type="number"
                  {...register('namespace', { valueAsNumber: true })}
                  placeholder="0"
                />
                <p className="text-xs text-muted-foreground">
                  Default: 0
                </p>
              </div>
            </div>

            {/* Data Type */}
            <div className="space-y-2">
              <Label htmlFor="dataType">
                Data Type <span className="text-red-500">*</span>
              </Label>
              <select
                id="dataType"
                {...register('dataType', { required: 'Data type is required' })}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <optgroup label="Boolean">
                  <option value="Boolean">Boolean</option>
                </optgroup>
                <optgroup label="Integer Types">
                  <option value="SByte">SByte (8-bit signed)</option>
                  <option value="Byte">Byte (8-bit unsigned)</option>
                  <option value="Int16">Int16 (16-bit signed)</option>
                  <option value="UInt16">UInt16 (16-bit unsigned)</option>
                  <option value="Int32">Int32 (32-bit signed)</option>
                  <option value="UInt32">UInt32 (32-bit unsigned)</option>
                  <option value="Int64">Int64 (64-bit signed)</option>
                  <option value="UInt64">UInt64 (64-bit unsigned)</option>
                </optgroup>
                <optgroup label="Floating Point">
                  <option value="Float">Float (32-bit)</option>
                  <option value="Double">Double (64-bit, recommended)</option>
                </optgroup>
                <optgroup label="Other Types">
                  <option value="String">String (text)</option>
                  <option value="DateTime">DateTime</option>
                  <option value="ByteString">ByteString (binary)</option>
                </optgroup>
              </select>
              {errors.dataType && (
                <p className="text-sm text-red-500">{errors.dataType.message}</p>
              )}
            </div>

            {/* Scale and Offset */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="scale">Scale</Label>
                <Input
                  id="scale"
                  type="number"
                  step="any"
                  {...register('scale', { valueAsNumber: true })}
                  placeholder="1"
                />
                <p className="text-xs text-muted-foreground">
                  Multiply raw value by this (default: 1)
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="offset">Offset</Label>
                <Input
                  id="offset"
                  type="number"
                  step="any"
                  {...register('offset', { valueAsNumber: true })}
                  placeholder="0"
                />
                <p className="text-xs text-muted-foreground">
                  Add to scaled value (default: 0)
                </p>
              </div>
            </div>

            {/* Unit */}
            <div className="space-y-2">
              <Label htmlFor="unit">Unit</Label>
              <Input
                id="unit"
                {...register('unit')}
                placeholder="e.g., °C, bar, rpm"
              />
              <p className="text-xs text-muted-foreground">
                Optional unit of measurement
              </p>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit">
                {editingIndex !== null ? 'Update' : 'Add'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};
