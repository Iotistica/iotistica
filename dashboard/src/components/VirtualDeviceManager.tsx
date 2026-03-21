/**
 * Virtual Device Manager Component
 * 
 * Allows creating and managing virtual protocol simulators (sidecars)
 * that run alongside agents for testing and development.
 * 
 * Features:
 * - Create virtual Modbus/OPC-UA devices with profile selection
 * - Auto-assigned ports (502, 503, 504... for Modbus)
 * - Profile-based data point configuration
 * - Agent connects to virtual devices via localhost like physical devices
 */

import { useState, useEffect } from 'react';
import { Plus, Trash2, Beaker, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Alert, AlertDescription } from './ui/alert';
import { toast } from 'sonner';
import { buildApiUrl } from '../config/api';

interface VirtualDevice {
  uuid: string;
  name: string;
  protocol: string;
  profile: string;
  connection: {
    host: string;
    port: number;
  };
  image: string;
}

interface Profile {
  profile_name: string;
  protocol: string;
  data_points: any[];
}

interface VirtualDeviceManagerProps {
  deviceUuid: string;
}

export const VirtualDeviceManager = ({
  deviceUuid,
}: VirtualDeviceManagerProps) => {
  const [virtualDevices, setVirtualDevices] = useState<VirtualDevice[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [openDialog, setOpenDialog] = useState(false);
  const [loading, setLoading] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    protocol: 'modbus',
    profile: '',
    slaveCount: 40,
  });

  // Fetch virtual devices
  const fetchVirtualDevices = async () => {
    try {
      const response = await fetch(buildApiUrl(`/api/v1/agents/${deviceUuid}/virtual-devices`));
      if (!response.ok) throw new Error('Failed to fetch virtual devices');
      const data = await response.json();
      setVirtualDevices(data.virtualDevices || []);
    } catch (err) {
      console.error('Failed to fetch virtual devices:', err);
      toast.error('Failed to fetch virtual devices');
    }
  };

  // Fetch available profiles
  const fetchProfiles = async (protocol: string) => {
    try {
      const response = await fetch(buildApiUrl(`/api/v1/profiles?protocol=${protocol}`));
      if (!response.ok) throw new Error('Failed to fetch profiles');
      const data = await response.json();
      setProfiles(data || []);
      
      // Auto-select first profile if available
      if (data && data.length > 0 && !formData.profile) {
        setFormData(prev => ({ ...prev, profile: data[0].profile_name }));
      }
    } catch (err) {
      console.error('Failed to fetch profiles:', err);
      toast.error('Failed to fetch profiles');
    }
  };

  useEffect(() => {
    fetchVirtualDevices();
  }, [deviceUuid]);

  useEffect(() => {
    if (formData.protocol) {
      fetchProfiles(formData.protocol);
    }
  }, [formData.protocol]);

  const handleOpenDialog = () => {
    setFormData({
      name: `Virtual ${formData.protocol.toUpperCase()} Device ${virtualDevices.length + 1}`,
      protocol: 'modbus',
      profile: '',
      slaveCount: 40,
    });
    setOpenDialog(true);
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
  };

  const handleCreate = async () => {
    setLoading(true);

    try {
      const response = await fetch(buildApiUrl(`/api/v1/agents/${deviceUuid}/virtual-devices`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create virtual device');
      }
      
      toast.success('Virtual device created successfully');
      
      // Refresh list
      await fetchVirtualDevices();
      
      // Close dialog
      handleCloseDialog();
    } catch (err) {
      console.error('Failed to create virtual device:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to create virtual device');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (virtualDeviceUuid: string, name: string) => {
    if (!confirm(`Delete virtual device "${name}"?`)) {
      return;
    }

    try {
      const response = await fetch(
        buildApiUrl(`/api/v1/agents/${deviceUuid}/virtual-devices/${virtualDeviceUuid}`),
        { method: 'DELETE' }
      );

      if (!response.ok) throw new Error('Failed to delete virtual device');
      
      toast.success('Virtual device deleted');
      
      // Refresh list
      await fetchVirtualDevices();
    } catch (err) {
      console.error('Failed to delete virtual device:', err);
      toast.error('Failed to delete virtual device');
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Beaker className="h-5 w-5" />
              <CardTitle>Virtual Devices</CardTitle>
              <Badge variant="secondary">{virtualDevices.length}</Badge>
            </div>
            <Button onClick={handleOpenDialog} size="sm">
              <Plus className="h-4 w-4 mr-2" />
              Add Device
            </Button>
          </div>
        </CardHeader>

        <CardContent>
          {virtualDevices.length === 0 ? (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                No virtual devices configured. Virtual devices are protocol simulators that run as
                sidecars and can be accessed by the agent via localhost.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-2">
              {virtualDevices.map((vd) => (
                <Card key={vd.uuid} className="border">
                  <CardContent className="py-3">
                    <div className="flex items-center justify-between">
                      <div className="space-y-1">
                        <div className="font-medium">{vd.name}</div>
                        <div className="flex items-center gap-2 text-sm">
                          <Badge variant="outline">{vd.protocol.toUpperCase()}</Badge>
                          <Badge variant="secondary">Profile: {vd.profile}</Badge>
                          <Badge variant="outline">
                            {vd.connection.host}:{vd.connection.port}
                          </Badge>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(vd.uuid, vd.name)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Virtual Device Dialog */}
      <Dialog open={openDialog} onOpenChange={setOpenDialog}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Add Device</DialogTitle>
            <DialogDescription>
              Virtual devices are protocol simulators that run as sidecar containers.
              The agent connects to them via localhost just like physical devices.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Device Name</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Virtual PLC 1"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="protocol">Protocol</Label>
              <Select
                value={formData.protocol}
                onValueChange={(value) => setFormData({ ...formData, protocol: value, profile: '' })}
              >
                <SelectTrigger id="protocol">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="modbus">Modbus TCP</SelectItem>
                  <SelectItem value="opcua">OPC-UA</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="profile">Profile</Label>
              <Select
                value={formData.profile}
                onValueChange={(value) => setFormData({ ...formData, profile: value })}
                disabled={profiles.length === 0}
              >
                <SelectTrigger id="profile">
                  <SelectValue placeholder="Select a profile" />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((profile) => (
                    <SelectItem key={profile.profile_name} value={profile.profile_name}>
                      {profile.profile_name} ({profile.data_points?.length || 0} data points)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {formData.protocol === 'modbus' && (
              <div className="space-y-2">
                <Label htmlFor="slaveCount">Slave Count</Label>
                <Input
                  id="slaveCount"
                  type="number"
                  value={formData.slaveCount}
                  onChange={(e) => setFormData({ ...formData, slaveCount: parseInt(e.target.value) })}
                />
                <p className="text-sm text-muted-foreground">
                  Number of Modbus slave IDs to simulate
                </p>
              </div>
            )}

            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                <div className="font-medium mb-1">Auto-Configuration:</div>
                <ul className="list-disc list-inside space-y-1 text-sm">
                  <li>Port will be auto-assigned (502, 503, 504... for Modbus)</li>
                  <li>
                    Agent will connect via localhost:
                    {virtualDevices.length === 0 ? '502' : `${502 + virtualDevices.filter(v => v.protocol === 'modbus').length}`}
                  </li>
                  <li>Data points defined by selected profile</li>
                </ul>
              </AlertDescription>
            </Alert>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleCloseDialog} disabled={loading}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={loading || !formData.name || !formData.profile}
            >
              {loading ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
