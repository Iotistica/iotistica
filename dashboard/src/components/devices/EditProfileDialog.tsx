/**
 * Edit/Add Profile Dialog
 * 
 * Separate component for managing protocol device profiles.
 * Uses exact same styling and pattern as AddDeviceDialog.
 */

import React, { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface EditProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaveProfile: () => Promise<void>;
  profileData: {
    profile_name: string;
    protocol: string;
    description: string;
    data_points: string;
  };
  onProfileDataChange: (data: any) => void;
  isEditing: boolean;
  isLoading: boolean;
  dataPointsError: string;
  onDataPointsErrorChange: (error: string) => void;
  onLoadTemplate: () => void;
  onValidateDataPoints: () => void;
  onProfileNameReset?: () => void;
}

export const EditProfileDialog: React.FC<EditProfileDialogProps> = ({
  open,
  onOpenChange,
  onSaveProfile,
  profileData,
  onProfileDataChange,
  isEditing,
  isLoading,
  dataPointsError,
  onDataPointsErrorChange,
  onLoadTemplate,
  onValidateDataPoints,
  onProfileNameReset,
}) => {
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    setError(null);
    onOpenChange(false);
    if (onProfileNameReset) {
      onProfileNameReset();
    }
  };

  const handleSave = async () => {
    setError(null);

    // Validate required fields
    if (!profileData.profile_name.trim()) {
      setError('Profile name is required');
      return;
    }

    if (!profileData.protocol) {
      setError('Protocol is required');
      return;
    }

    // Validate data points JSON
    try {
      const dataPoints = JSON.parse(profileData.data_points);
      if (!Array.isArray(dataPoints)) {
        setError('Data points must be a JSON array');
        return;
      }

      const autoDiscoveryProtocols = ['opcua', 'snmp'];
      if (dataPoints.length === 0 && !autoDiscoveryProtocols.includes(profileData.protocol)) {
        setError('At least one data point is required for this protocol');
        return;
      }
    } catch (err) {
      setError('Invalid JSON in data points');
      return;
    }

    try {
      await onSaveProfile();
      handleClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save profile');
    }
  };

  const canSave = () => {
    return profileData.profile_name.trim() && profileData.protocol;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="!grid !grid-rows-[auto,1fr,auto] !gap-0 !h-[85vh] !max-h-[85vh] max-w-5xl !p-0 overflow-hidden">
        <DialogHeader className="px-6 py-4">
          <DialogTitle>
            {isEditing ? 'Edit Profile' : 'Create Profile'}
          </DialogTitle>
          <DialogDescription>
            {isEditing 
              ? 'Update the profile configuration' 
              : 'Create a reusable configuration profile for protocol devices'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-6">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Profile Name */}
          <div className="space-y-2">
            <Label htmlFor="profile-name">Profile Name *</Label>
            <Input
              id="profile-name"
              value={profileData.profile_name}
              onChange={(e) => onProfileDataChange({ ...profileData, profile_name: e.target.value })}
              placeholder="e.g., COMAP-IG-NT"
              disabled={isEditing}
              className="h-11"
            />
          </div>

          {/* Protocol */}
          <div className="space-y-2 text-left">
            <Label htmlFor="protocol-select">Protocol *</Label>
            <Select
              value={profileData.protocol}
              onValueChange={(value) => onProfileDataChange({
                ...profileData,
                protocol: value,
              })}
              disabled={isEditing}
            >
              <SelectTrigger id="protocol-select" className="h-11 text-left">
                <SelectValue placeholder="Select protocol" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="modbus">Modbus TCP/RTU</SelectItem>
                <SelectItem value="opcua">OPC-UA</SelectItem>
                <SelectItem value="mqtt">MQTT</SelectItem>
                <SelectItem value="can">CAN Bus</SelectItem>
                <SelectItem value="snmp">SNMP</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="profile-description">Description</Label>
            <Textarea
              id="profile-description"
              value={profileData.description}
              onChange={(e) => onProfileDataChange({ ...profileData, description: e.target.value })}
              placeholder="e.g., COMAP InteliGen NT controller configuration"
              rows={2}
            />
          </div>

          {/* Data Points */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="profile-datapoints">
                Data Points {profileData.protocol === 'modbus' && '*'}
              </Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onLoadTemplate}
                >
                  Template
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onValidateDataPoints}
                >
                  Validate
                </Button>
              </div>
            </div>
            <Textarea
              id="profile-datapoints"
              value={profileData.data_points}
              onChange={(e) => {
                onProfileDataChange({ ...profileData, data_points: e.target.value });
                onDataPointsErrorChange('');
              }}
              placeholder="JSON array of data points..."
              rows={10}
              className={`font-mono text-xs ${dataPointsError ? 'border-red-500' : ''}`}
            />
            {dataPointsError && (
              <p className="text-sm text-red-500">{dataPointsError}</p>
            )}
          </div>
        </div>

        <DialogFooter className="px-6 py-4">
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!canSave() || isLoading}
          >
            {isLoading ? 'Saving...' : (isEditing ? 'Update Profile' : 'Create Profile')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
