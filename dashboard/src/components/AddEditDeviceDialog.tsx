import { useState, useEffect } from "react";
import { X } from "lucide-react";
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
        macAddress: "00:1B:44:11:3A:B7",
        lastSeen: device.lastSeen,
        status: device.status,
        cpu: device.cpu,
        memory: device.memory,
        disk: device.disk,
      });
      
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
    }

    loadTagDefinitions();
  }, [open]); // Only re-run when dialog opens/closes

  const handleSave = () => {
    // Required field validation
    if (!formData.name) {
      toast.error("Please fill in all required fields");
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

    const deviceDataToSave = {
      ...(device?.id ? { id: device.id } : {}),
      deviceUuid: device?.deviceUuid || generateUuid(),
      name: formData.name,
      type: formData.type,
      ipAddress: formData.ipAddress,
      macAddress: formData.macAddress,
      lastSeen: formData.lastSeen,
      status: formData.status,
      cpu: formData.cpu,
      memory: formData.memory,
      disk: formData.disk,
      tags: tags,
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[95vh] overflow-hidden flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>{isEditMode ? "Edit Device" : "Add Virtual Agent"}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? "Update agent information and settings"
              : "Deploy a containerized agent to your Kubernetes cluster"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="device-name">Agent Name *</Label>
            <Input
              id="device-name"
              placeholder="virtual-agent-001"
              value={formData.name}
              onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
            />
          </div>

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
    

          {!isEditMode && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950">
              <div className="flex gap-3">
                <div className="flex-shrink-0">
                  <svg className="h-5 w-5 text-blue-600 dark:text-blue-400" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                  </svg>
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-medium text-blue-900 dark:text-blue-100">Virtual Agent Deployment</h3>
                  <div className="mt-2 text-sm text-blue-700 dark:text-blue-300">
                    <p>A containerized agent will be automatically deployed to your Kubernetes cluster and will self-provision on startup.</p>
                    <ul className="mt-2 list-disc list-inside space-y-1">
                      <li>No manual installation required</li>
                      <li>Automatic provisioning with cloud platform</li>
                      <li>Managed via Kubernetes/Helm</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            {isEditMode ? "Update Device" : "Add Device"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
