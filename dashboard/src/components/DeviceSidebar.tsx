import { useState, useEffect, useMemo } from "react";
import { getDeviceTags } from "@/services/deviceTags";
import { Monitor, Smartphone, Server, Laptop, Search, Plus, Filter, Edit, X, ChevronRight, Container } from "lucide-react";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { cn } from "./ui/utils";

export interface Device {
  id: string;
  deviceUuid: string;
  name: string;
  type: "desktop" | "laptop" | "mobile" | "server" | "gateway" | "edge-device" | "iot-hub" | "plc" | "controller" | "sensor-node" | "standalone" | "virtual";
  status: "online" | "offline" | "warning" | "pending";
  ipAddress: string;
  macAddress?: string;
  lastSeen: string;
  lastConnectivity?: string; // Store raw timestamp
  cpu: number;
  memory: number;
  disk: number;
}

interface DeviceSidebarProps {
  devices: Device[];
  selectedDeviceId: string;
  onSelectDevice: (deviceId: string) => void;
  onAddDevice: () => void;
  onEditDevice: (device: Device) => void;
}

const deviceIcons = {
  desktop: Monitor,
  laptop: Laptop,
  mobile: Smartphone,
  server: Server,
  gateway: Server,
  "edge-device": Monitor,
  "iot-hub": Server,
  plc: Monitor,
  controller: Server,
  "sensor-node": Smartphone,
  standalone: Monitor,
  virtual: Container, // Containerized K8s pod
};

const statusColors = {
  online: "bg-green-500",
  offline: "bg-gray-400",
  warning: "bg-yellow-500",
  pending: "bg-yellow-500",
};

const statusBadgeColors = {
  online: "bg-green-100 text-green-700 border-green-200",
  offline: "bg-gray-100 text-gray-700 border-gray-200",
  warning: "bg-yellow-100 text-yellow-700 border-yellow-200",
  pending: "bg-yellow-100 text-yellow-700 border-yellow-200",
};

// Device Tags Pills Component - shows 2-3 preview tags with "View all" link
function DeviceTagsPills({ deviceUuid }: { deviceUuid: string }) {
  const [tags, setTags] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const fetchTags = async () => {
    if (!deviceUuid) return;
    
    try {
      setLoading(true);
      const deviceTags = await getDeviceTags(deviceUuid);
      setTags(deviceTags);
    } catch (error) {
      console.error('Error fetching device tags:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTags();
  }, [deviceUuid]);

  // Listen for tag updates from other components (e.g., AddEditDeviceDialog)
  useEffect(() => {
    const handleTagsUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{ deviceUuid: string }>;
      if (customEvent.detail.deviceUuid === deviceUuid) {
        console.log('[DeviceTagsPills] Tags updated externally, reloading...');
        fetchTags();
      }
    };

    window.addEventListener('device-tags-updated', handleTagsUpdated);
    return () => window.removeEventListener('device-tags-updated', handleTagsUpdated);
  }, [deviceUuid]);

  const tagEntries = Object.entries(tags);
  const visibleTags = tagEntries.slice(0, 2);
  const remainingCount = tagEntries.length - visibleTags.length;

  if (loading || tagEntries.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-1 mt-2 flex-wrap">
      {visibleTags.map(([key, value]) => (
        <Badge
          key={key}
          variant="outline"
          className="text-xs bg-blue-50 text-blue-700 border-blue-200"
        >
          {key}: {value}
        </Badge>
      ))}
      {remainingCount > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('open-device-tags', { 
              detail: { deviceUuid } 
            }));
          }}
          className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
        >
          +{remainingCount} more <ChevronRight className="w-3 h-3" />
        </button>
      )}
      {remainingCount === 0 && tagEntries.length > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('open-device-tags', { 
              detail: { deviceUuid } 
            }));
          }}
          className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
        >
          View all <ChevronRight className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

export function DeviceSidebar({ devices, selectedDeviceId, onAddDevice, onEditDevice , onSelectDevice }: DeviceSidebarProps) {
  // Get unique statuses and types from actual devices using useMemo for performance
  const availableStatuses = useMemo<Device['status'][]>(() => 
    Array.from(new Set(devices.map(d => d.status))) as Device['status'][], 
    [devices]
  );
  
  const availableTypes = useMemo<Device['type'][]>(() => 
    Array.from(new Set(devices.map(d => d.type))) as Device['type'][], 
    [devices]
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilters, setStatusFilters] = useState<Device['status'][]>([]);
  const [typeFilters, setTypeFilters] = useState<Device['type'][]>([]);
  const [filtersInitialized, setFiltersInitialized] = useState(false);

  // Initialize filters once, then only remove invalid selections on refresh
  useEffect(() => {
    if (!filtersInitialized) {
      if (availableStatuses.length > 0 || availableTypes.length > 0) {
        setStatusFilters([...availableStatuses]);
        setTypeFilters([...availableTypes]);
        setFiltersInitialized(true);
      }
      return;
    }

    setStatusFilters(prev => prev.filter(s => availableStatuses.includes(s)));
    setTypeFilters(prev => prev.filter(t => availableTypes.includes(t)));
  }, [availableStatuses, availableTypes, filtersInitialized]);

  const toggleStatusFilter = (status: Device['status']) => {
    setStatusFilters(prev =>
      prev.includes(status) ? prev.filter(s => s !== status) : [...prev, status]
    );
  };

  const toggleTypeFilter = (type: Device['type']) => {
    setTypeFilters(prev =>
      prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
    );
  };

  const allStatusesSelected = availableStatuses.length > 0 && statusFilters.length === availableStatuses.length;
  const allTypesSelected = availableTypes.length > 0 && typeFilters.length === availableTypes.length;

  const filteredDevices = devices.filter(device => {
    const matchesSearch = device.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         device.ipAddress.includes(searchQuery);
    const matchesStatus = statusFilters.length === 0 || statusFilters.includes(device.status);
    const matchesType = typeFilters.length === 0 || typeFilters.includes(device.type);
    return matchesSearch && matchesStatus && matchesType;
  }).sort((a, b) => {
    if (a.status === b.status) return 0;
    if (a.status === 'online') return -1;
    if (b.status === 'online') return 1;
    return 0;
  });

  const hasActiveFilters = statusFilters.length < availableStatuses.length || 
                           typeFilters.length < availableTypes.length || 
                           searchQuery.length > 0;

  const clearFilters = () => {
    setSearchQuery("");
    setStatusFilters(availableStatuses);
    setTypeFilters(availableTypes);
  };

  return (
    <TooltipProvider>
      <div className="w-full lg:w-80 lg:border-r border-border bg-card h-full flex flex-col overflow-hidden">
        <div className="p-6 border-b border-border flex-shrink-0">
        <div className="flex items-start justify-between mb-2">
          <div>
            <h2 className="text-foreground mb-1">Agents</h2>
            <p className="text-muted-foreground">
              {devices.filter(d => d.status === "online").length} of {devices.length} online
            </p>
          </div>
          <Button size="sm" onClick={onAddDevice}>
            <Plus className="w-4 h-4 mr-1" />
            Add
          </Button>
        </div>
      </div>

      {/* Search and Filter */}
      <div className="p-4 space-y-3 border-b border-border flex-shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            type="search"
            placeholder="Search agents..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>

        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="flex-1">
                <Filter className="w-4 h-4 mr-2" />
                Filters
                {hasActiveFilters && (
                  <Badge className="ml-2 bg-blue-600" variant="secondary">
                    {statusFilters.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(', ')}
                    {statusFilters.length > 0 && typeFilters.length > 0 && ' • '}
                    {typeFilters.map(t => t.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')).join(', ')}
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Status</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={allStatusesSelected}
                onCheckedChange={(checked) =>
                  setStatusFilters(checked ? [...availableStatuses] : [])
                }
              >
                Select all
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              {availableStatuses.map(status => (
                <DropdownMenuCheckboxItem
                  key={status}
                  checked={statusFilters.includes(status)}
                  onCheckedChange={() => toggleStatusFilter(status)}
                >
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                </DropdownMenuCheckboxItem>
              ))}
              
              <DropdownMenuSeparator />
              
              <DropdownMenuLabel>Device Type</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={allTypesSelected}
                onCheckedChange={(checked) =>
                  setTypeFilters(checked ? [...availableTypes] : [])
                }
              >
                Select all
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              {availableTypes.map(type => {
                // Format type labels nicely
                const label = type
                  .split('-')
                  .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                  .join(' ');
                
                return (
                  <DropdownMenuCheckboxItem
                    key={type}
                    checked={typeFilters.includes(type)}
                    onCheckedChange={() => toggleTypeFilter(type)}
                  >
                    {label}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>

        <p className="text-muted-foreground">
          Showing {filteredDevices.length} of {devices.length} agents
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-3">
          {filteredDevices.map((device) => {
            const Icon = deviceIcons[device.type];
            const isSelected = device.id === selectedDeviceId;
            
            return (
              <Card
                key={device.id}
                className={cn(
                  "p-4 transition-all hover:shadow-md relative group",
                  isSelected ? "ring-2 ring-blue-500 shadow-md" : ""
                )}
              >
                <div 
                  className="flex items-start gap-3 cursor-pointer"
                  onClick={() => onSelectDevice(device.id)}
                >
                  <div className="relative">
                    <div className="w-10 h-10 bg-muted rounded-lg flex items-center justify-center">
                      <Icon className="w-5 h-5 text-muted-foreground" />
                    </div>
                    <div
                      className={cn(
                        "absolute -top-1 -right-1 w-3 h-3 rounded-full border-2 border-card",
                        statusColors[device.status]
                      )}
                    />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <h3 className="text-foreground truncate">
                            {device.name.length > 15 
                              ? `${device.name.substring(0, 15)}...` 
                              : device.name}
                          </h3>
                        </TooltipTrigger>
                        {device.name.length > 15 && (
                          <TooltipContent>
                            <p>{device.name}</p>
                          </TooltipContent>
                        )}
                      </Tooltip>
                    </div>
                    
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="outline" className={cn("text-xs", statusBadgeColors[device.status])}>
                        {device.status}
                      </Badge>
                      <span className="text-muted-foreground">{device.ipAddress}</span>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-muted-foreground">
                        <span>CPU</span>
                        <span>{device.cpu}%</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className={cn(
                            "h-full transition-all rounded-full",
                            device.cpu > 80 ? "bg-red-500" : device.cpu > 60 ? "bg-yellow-500" : "bg-blue-500"
                          )}
                          style={{ width: `${device.cpu}%` }}
                        />
                      </div>
                    </div>

                    <div className="text-muted-foreground mt-2">
                      Last seen: {device.lastSeen}
                    </div>

                    {/* Device Tags */}
                    <DeviceTagsPills deviceUuid={device.deviceUuid} />
                  </div>
                </div>

                {/* Edit Button - appears on hover */}
                <Button
                  size="icon"
                  variant="ghost"
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditDevice(device);
                  }}
                >
                  <Edit className="w-4 h-4" />
                </Button>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
    </TooltipProvider>
  );
}
