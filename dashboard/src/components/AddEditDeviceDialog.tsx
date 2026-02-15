import { useState, useEffect } from "react";
import { Copy, Check, RefreshCw, X, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { toast } from "sonner";
import { Device } from "./DeviceSidebar";
import { buildApiUrl } from "../config/api";
import { getTagDefinitions, type TagDefinition } from "../services/deviceTags";
import { useFleet } from "../contexts/FleetContext";

const UNASSIGNED_FLEET_ID = "__unassigned__";

interface AddEditDeviceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  device?: Device | null;
  onSave: (device: Omit<Device, "id"> & { id?: string; provisioningKeyId?: string; tags?: Record<string, string> }) => void;
}

// Helper function to generate UUID v4
const generateUuid = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

export function AddEditDeviceDialog({
  open,
  onOpenChange,
  device,
  onSave,
}: AddEditDeviceDialogProps) {
  const isEditMode = !!device;
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [provisioningKey, setProvisioningKey] = useState("");
  const [provisioningKeyId, setProvisioningKeyId] = useState<string | null>(null);
  const [isLoadingKey, setIsLoadingKey] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [tags, setTags] = useState<Record<string, string>>({});
  const [tagDefinitions, setTagDefinitions] = useState<TagDefinition[]>([]);
  const [newTagKey, setNewTagKey] = useState("");
  const [newTagValue, setNewTagValue] = useState("");
  const [selectedTagDefinition, setSelectedTagDefinition] = useState<TagDefinition | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    type: "virtual" as Device['type'],
    description: "",
    ipAddress: "",
    macAddress: "",
    lastSeen: "Never",
    status: "offline" as Device['status'],
    cpu: 0,
    memory: 0,
    disk: 0,
  });
  const { selectedFleetId: contextFleetId } = useFleet();
  const [fleetOptions, setFleetOptions] = useState<Array<{ fleet_id: string; fleet_name: string }>>([]);
  const [selectedFleetId, setSelectedFleetId] = useState<string>(UNASSIGNED_FLEET_ID);

  // Install command
  const installCommand = `curl -sfL https://apps.iotistica.com/agent/install | sh`;

  // Load tag definitions
  const loadTagDefinitions = async () => {
    try {
      const definitions = await getTagDefinitions();
      setTagDefinitions(definitions);
    } catch (error) {
      console.error('Error loading tag definitions:', error);
      toast.error('Failed to load tag definitions');
    }
  };

  // Get available tag keys (exclude already used ones)
  const availableTagKeys = tagDefinitions.filter(
    def => !tags[def.key]
  );

  // Fetch provisioning key from API
  const fetchProvisioningKey = async (isRegenerate = false) => {
    setIsLoadingKey(true);
    try {
      const provisioningFleetId = selectedFleetId === UNASSIGNED_FLEET_ID ? 'unassigned' : selectedFleetId;
      const response = await fetch(buildApiUrl('/api/v1/provisioning-keys/generate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fleetId: provisioningFleetId,
          newKey: isRegenerate,
          previousKeyId: isRegenerate ? provisioningKeyId : undefined,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to generate provisioning key');
      }

      const data = await response.json();
      setProvisioningKey(data.key);
      setProvisioningKeyId(data.id);
      
      if (isRegenerate) {
        toast.success("New provisioning key generated and old key invalidated");
      }
    } catch (error: any) {
      console.error('Error generating provisioning key:', error);
      toast.error(error.message || 'Failed to generate provisioning key');
    } finally {
      setIsLoadingKey(false);
    }
  };

  const loadFleets = async () => {
    try {
      const token = localStorage.getItem('accessToken');
      const response = await fetch(buildApiUrl('/api/v1/fleets'), {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) {
        const data = await response.json();
        setFleetOptions(data.fleets || []);
      } else {
        setFleetOptions([]);
      }
    } catch (error) {
      console.error('Error loading fleets:', error);
      setFleetOptions([]);
    }
  };

  // Separate effect for initializing form when dialog opens
  useEffect(() => {
    if (!open) {
      // Reset when dialog closes (optional - helps with cleanup)
      return;
    }

    // Only initialize formData when dialog first opens
    console.log('[DEBUG] Dialog opened - initializing form data');
    
    if (device) {
      console.log('[DEBUG] Setting formData for device:', device.name);
      setFormData({
        name: device.name,
        type: device.type,
        description: "",
        ipAddress: device.ipAddress,
        macAddress: device.macAddress || "",
        lastSeen: device.lastSeen,
        status: device.status,
        cpu: device.cpu,
        memory: device.memory,
        disk: device.disk,
      });
      setSelectedFleetId(device.fleet_id || UNASSIGNED_FLEET_ID);
      
      // Fetch tags from API for this device
      const fetchDeviceTags = async () => {
        try {
          const response = await fetch(buildApiUrl(`/api/v1/devices/${device.deviceUuid}/tags`));
          if (response.ok) {
            const data = await response.json();
            setTags(data.tags || {});
          } else {
            setTags({});
          }
        } catch (error) {
          console.error('Error fetching device tags:', error);
          setTags({});
        }
      };
      
      fetchDeviceTags();
    } else {
      setFormData({
        name: "",
        type: "virtual",
        description: "",
        ipAddress: "",
        macAddress: "",
        lastSeen: "Never",
        status: "offline",
        cpu: 0,
        memory: 0,
        disk: 0,
      });
      setTags({});
      setSelectedFleetId(contextFleetId || UNASSIGNED_FLEET_ID);
    }

    loadTagDefinitions();
    loadFleets();
  }, [open]); // Only re-run when dialog opens/closes

  // Generate key when switching to standalone type
  useEffect(() => {
    if (open && !isEditMode && formData.type === 'standalone') {
      fetchProvisioningKey(false);
    }
  }, [open, formData.type, isEditMode, selectedFleetId]);

  const handleSave = () => {
    // Required field validation
    if (formData.type === 'virtual' && !formData.name) {
      toast.error("Please enter a device name for virtual agent");
      return;
    }
    if (formData.type === 'standalone' && !provisioningKey) {
      toast.error("Provisioning key not generated. Please try again.");
      return;
    }

    // IP/MAC validation only required in edit mode (when fields are visible)
    if (isEditMode) {
      if (!formData.ipAddress || !formData.macAddress) {
        toast.error("Please fill in all required fields");
        return;
      }

      // Validate IP address format
      const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
      if (!ipRegex.test(formData.ipAddress)) {
        toast.error("Please enter a valid IP address");
        return;
      }

      // Validate MAC address format
      const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
      if (!macRegex.test(formData.macAddress)) {
        toast.error("Please enter a valid MAC address (e.g., 00:1B:44:11:3A:B7)");
        return;
      }
    }

    const fleetIdForSave = selectedFleetId === UNASSIGNED_FLEET_ID ? undefined : selectedFleetId;
    const deviceDataToSave = {
      ...(device?.id ? { id: device.id } : {}),
      deviceUuid: device?.deviceUuid || generateUuid(),
      name: formData.type === 'virtual' ? formData.name : '', // Name only for virtual agents
      type: formData.type,
      ipAddress: formData.ipAddress,
      macAddress: formData.macAddress,
      lastSeen: formData.lastSeen,
      status: formData.status,
      cpu: formData.cpu,
      memory: formData.memory,
      disk: formData.disk,
      fleet_id: fleetIdForSave,
      tags: tags,
      ...(formData.type === 'standalone' && provisioningKey ? { provisioningKey } : {}),
    };
    
    console.log('[DEBUG AddEditDeviceDialog] Saving device with data:', {
      ...deviceDataToSave,
      deviceProp: device,
      deviceId: device?.id,
      deviceUuid: device?.deviceUuid,
      tagsCount: Object.keys(tags).length
    });
    
    onSave(deviceDataToSave);

    // Note: Don't show success toast here - let the parent handle it since it's async now
    onOpenChange(false);
  };

  const handleDelete = async () => {
    if (!device || !device.deviceUuid) {
      toast.error('No device to delete');
      return;
    }

    // Show confirmation dialog
    setShowDeleteConfirm(true);
  };

  const confirmDelete = async () => {
    if (!device || !device.deviceUuid) return;

    setShowDeleteConfirm(false);
    setIsDeleting(true);

    try {
      const url = buildApiUrl(`/api/v1/devices/${device.deviceUuid}/virtual`);
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to delete device');
      }

      const result = await response.json();
      toast.success(result.message || 'Device deleted successfully');
      
      // Close dialog and notify the app to refresh its device list
      onOpenChange(false);
      window.dispatchEvent(new CustomEvent('device-deleted', {
        detail: { deviceUuid: device.deviceUuid }
      }));

    } catch (error: any) {
      console.error('Error deleting device:', error);
      toast.error(error.message || 'Failed to delete device');
    } finally {
      setIsDeleting(false);
    }
  };

  const copyInstallCommand = () => {
    navigator.clipboard.writeText(installCommand);
    setCopiedCommand(true);
    toast.success("Install command copied to clipboard");
    setTimeout(() => setCopiedCommand(false), 2000);
  };

  const copyProvisioningKey = () => {
    navigator.clipboard.writeText(provisioningKey);
    setCopiedKey(true);
    toast.success("Provisioning key copied to clipboard");
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const regenerateProvisioningKey = async () => {
    await fetchProvisioningKey(true);
  };

  const handleAddTag = () => {
    console.log('[DEBUG handleAddTag] Called with:', { newTagKey, newTagValue, currentTags: tags });
    
    if (!newTagKey.trim()) {
      toast.error("Please select a tag key");
      return;
    }
    if (!newTagValue.trim()) {
      toast.error("Tag value cannot be empty");
      return;
    }
    if (tags[newTagKey]) {
      toast.error(`Tag "${newTagKey}" already exists`);
      return;
    }

    // Warn if value is not in allowed values (but still allow it)
    if (selectedTagDefinition?.allowedValues && selectedTagDefinition.allowedValues.length > 0) {
      if (!selectedTagDefinition.allowedValues.includes(newTagValue)) {
        toast.warning(`Note: Value "${newTagValue}" is not in the suggested values list`, {
          description: `Suggested: ${selectedTagDefinition.allowedValues.join(', ')}`
        });
      }
    }
    
    const updatedTags = { ...tags, [newTagKey]: newTagValue };
    console.log('[DEBUG handleAddTag] Setting tags to:', updatedTags);
    setTags(updatedTags);
    setNewTagKey("");
    setNewTagValue("");
    setSelectedTagDefinition(null);
    toast.success(`Tag "${newTagKey}" added`);
  };

  const handleTagKeyChange = (key: string) => {
    setNewTagKey(key);
    const definition = tagDefinitions.find(def => def.key === key);
    setSelectedTagDefinition(definition || null);
    setNewTagValue(""); // Reset value when key changes
  };

  const handleRemoveTag = (key: string) => {
    const newTags = { ...tags };
    delete newTags[key];
    setTags(newTags);
    toast.success(`Tag "${key}" removed`);
  };

  const handleTagKeyKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (newTagKey.trim() && newTagValue.trim()) {
        handleAddTag();
      }
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[95vh] overflow-hidden flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>{isEditMode ? "Edit Agent" : "Add Agent"}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? "Update agent information and settings"
              : "Add a new agent to your fleet"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isEditMode && (
            <>
              <div className="space-y-2">
                <Label htmlFor="agent-uuid">Agent UUID</Label>
                <Input
                  id="agent-uuid"
                  value={device?.deviceUuid || ""}
                  readOnly
                  disabled
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fleet-name">Fleet Name</Label>
                <Input
                  id="fleet-name"
                  value={device?.fleet_id 
                    ? fleetOptions.find(f => f.fleet_id === device.fleet_id)?.fleet_name || "Loading..." 
                    : "Unassigned"}
                  readOnly
                  disabled
                />
              </div>
            </>
          )}
          {!isEditMode && (
            <div className="space-y-2 text-left">
              <Label htmlFor="device-type" className="text-left">Agent Type *</Label>
              <Select
                value={formData.type}
                onValueChange={(value: Device['type']) => setFormData(prev => ({ ...prev, type: value }))}
              >
                <SelectTrigger id="device-type" className="h-11">
                  <SelectValue placeholder="Select agent type" className="leading-none" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standalone">
                    <div className="flex flex-col">
                      <span>Standalone Agent</span>
                      <span className="text-xs text-muted-foreground">Physical device or VM with manual installation</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="virtual">
                    <div className="flex flex-col">
                      <span>Virtual Agent</span>
                      <span className="text-xs text-muted-foreground">Cloud-hosted agent with automatic deployment</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {!isEditMode && (
            <div className="space-y-2 text-left">
              <Label htmlFor="fleet-select" className="text-left">Fleet</Label>
              <Select
                value={selectedFleetId}
                onValueChange={setSelectedFleetId}
              >
                <SelectTrigger id="fleet-select" className="h-11">
                  <SelectValue placeholder="Select fleet" className="leading-none" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED_FLEET_ID}>
                    <div className="flex flex-col">
                      <span>Unassigned</span>
                      <span className="text-xs text-muted-foreground">Not linked to a fleet</span>
                    </div>
                  </SelectItem>
                  {fleetOptions.map((fleet) => (
                    <SelectItem key={fleet.fleet_id} value={fleet.fleet_id}>
                      <div className="flex flex-col">
                        <span>{fleet.fleet_name}</span>
                        <span className="text-xs text-muted-foreground">{fleet.fleet_id}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Defaults to the current fleet filter in the sidebar.
              </p>
            </div>
          )}

          {formData.type === 'virtual' && (
            <div className="space-y-2">
              <Label htmlFor="device-name">Agent Name *</Label>
              <Input
                id="device-name"
                placeholder="virtual-agent-001"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              />
            </div>
          )}

          {formData.type !== 'standalone' && (
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="Enter agent description (optional)"
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                rows={3}
              />
            </div>
          )}

          {formData.type !== 'standalone' && isEditMode && (
            <>
              <div className="space-y-2">
                <Label>Device Tags</Label>
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2 min-h-[40px] p-2 border border-border rounded-md bg-muted/30">
                {Object.keys(tags).length === 0 ? (
                  <span className="text-sm text-muted-foreground">No tags added yet</span>
                ) : (
                  Object.entries(tags).map(([key, value]) => (
                    <Badge
                      key={key}
                      variant="secondary"
                      className="gap-1 pr-1 bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800"
                    >
                      <span className="font-semibold">{key}</span>
                      <span>=</span>
                      <span>{value}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveTag(key)}
                        className="ml-1 rounded-sm hover:bg-blue-200 dark:hover:bg-blue-800 p-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))
                )}
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Select value={newTagKey} onValueChange={handleTagKeyChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select tag key" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableTagKeys.length === 0 ? (
                        <div className="p-2 text-sm text-muted-foreground">
                          {tagDefinitions.length === 0 
                            ? "No tag definitions available" 
                            : "All tag keys are already used"}
                        </div>
                      ) : (
                        availableTagKeys.map((def) => (
                          <SelectItem key={def.key} value={def.key}>
                            <div className="flex flex-col">
                              <span>{def.key}</span>
                              {def.description && (
                                <span className="text-xs text-muted-foreground">{def.description}</span>
                              )}
                            </div>
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>

                <Input
                  placeholder={
                    selectedTagDefinition?.allowedValues && selectedTagDefinition.allowedValues.length > 0
                      ? `Value (e.g., ${selectedTagDefinition.allowedValues.slice(0, 2).join(', ')})`
                      : "Value (e.g., production)"
                  }
                  value={newTagValue}
                  onChange={(e) => setNewTagValue(e.target.value)}
                  onKeyPress={handleTagKeyKeyPress}
                  disabled={!newTagKey}
                />

                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAddTag}
                  disabled={!newTagKey.trim() || !newTagValue.trim()}
                >
                  Add Tag
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {selectedTagDefinition ? (
                  <>
                    {selectedTagDefinition.description}
                    {selectedTagDefinition.allowedValues && selectedTagDefinition.allowedValues.length > 0 && (
                      <span className="block mt-1">
                        Suggested values: {selectedTagDefinition.allowedValues.join(', ')}
                      </span>
                    )}
                    {selectedTagDefinition.isRequired && (
                      <span className="text-orange-600 dark:text-orange-400 ml-1">(Required)</span>
                    )}
                  </>
                ) : (
                  "Select a predefined tag key and enter a value"
                )}
              </p>
            </div>
          </div>
            </>
          )}

          {isEditMode && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ip-address">IP Address *</Label>
              <Input
                id="ip-address"
                placeholder="192.168.1.10"
                value={formData.ipAddress}
                onChange={(e) => setFormData(prev => ({ ...prev, ipAddress: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="mac-address">MAC Address *</Label>
              <Input
                id="mac-address"
                placeholder="00:1B:44:11:3A:B7"
                value={formData.macAddress}
                onChange={(e) => setFormData(prev => ({ ...prev, macAddress: e.target.value }))}
              />
            </div>
          </div>
          )}
    

          {!isEditMode && formData.type === 'standalone' && (
            <div className="space-y-4 pt-4 border-t border-border">
              <div className="space-y-2">
                <Label htmlFor="provisioning-key" className="text-sm font-semibold text-foreground">Provisioning Key</Label>
                <div className="relative bg-muted border border-border rounded-md px-3 py-2.5">
                  <code className="block font-mono text-xs text-foreground select-all break-all leading-relaxed pr-20">
                    {isLoadingKey ? "Generating..." : (provisioningKey || "Loading...")}
                  </code>
                  <div className="absolute top-2 right-2 flex gap-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={copyProvisioningKey}
                      disabled={isLoadingKey || !provisioningKey}
                    >
                      {copiedKey ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4 text-muted-foreground" />}
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 hover:bg-gray-200"
                      onClick={regenerateProvisioningKey}
                      disabled={isLoadingKey}
                    >
                      <RefreshCw className={`w-4 h-4 text-gray-600 ${isLoadingKey ? 'animate-spin' : ''}`} />
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-gray-500">
                  Use this key during device provisioning. You can regenerate it if needed.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="install-command" className="text-sm font-semibold text-foreground">Install Command</Label>
                <div className="relative bg-black border border-gray-700 rounded-md px-4 py-3" style={{ backgroundColor: '#0d1117' }}>
                  <code className="block font-mono text-sm whitespace-pre-wrap break-all select-all pr-10" style={{ color: '#00ff41' }}>
                    {installCommand}
                  </code>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="absolute top-2 right-2 h-8 w-8 hover:bg-gray-800/50"
                    style={{ color: '#00ff41' }}
                    onClick={copyInstallCommand}
                  >
                    {copiedCommand ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
                <p className="text-xs text-gray-500">
                  Run this command on the device to install the agent and connect it to Iotistic
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {!isEditMode && formData.type === 'standalone' ? (
            <Button onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : (
            <div className="flex w-full justify-between items-center">
              {isEditMode && device?.type === 'virtual' ? (
                <>
                  <Button 
                    variant="destructive" 
                    onClick={handleDelete}
                    disabled={isDeleting}
                  >
                    {isDeleting ? (
                      <>
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                        Deleting...
                      </>
                    ) : (
                      <>
                        <Trash2 className="w-4 h-4 mr-2" />
                        Delete Agent
                      </>
                    )}
                  </Button>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                      Cancel
                    </Button>
                    <Button onClick={handleSave}>
                      {isEditMode ? "Update" : "Add"}
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex gap-2 ml-auto">
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleSave}>
                    {isEditMode ? "Update" : "Add"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Agent</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{device?.name || device?.deviceUuid}"?
              <br /><br />
              This will remove the agent and everything running with it, including its devices.
              <br /><br />
              It will also delete its data and keys.
              <br />
              <strong className="text-destructive">This action cannot be undone.</strong>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete Agent
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
