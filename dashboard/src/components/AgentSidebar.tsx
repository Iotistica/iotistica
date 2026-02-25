import { useState, useEffect, useMemo } from "react";
import { getDeviceTags, invalidateDeviceTagsCache } from "@/services/deviceTags";
import { buildApiUrl } from "@/config/api";
import { useFleet } from "@/contexts/FleetContext";
import { useRouting } from "@/hooks/useRouting";
import { Monitor, Smartphone, Server, Laptop, Search, Plus, Filter, Edit, X, ChevronRight, Container, Layers } from "lucide-react";
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
  location?: string;
  lastSeen: string;
  lastConnectivity?: string; // Store raw timestamp
  cpu: number;
  memory: number;
  disk: number;
  fleet_uuid?: string; // Optional fleet assignment (UUID)
}

interface DeviceSidebarProps {
  devices: Device[];
  selectedDeviceId: string;
  onSelectDevice: (deviceId: string) => void;
  onAddDevice: () => void;
  onEditDevice: (device: Device) => void;
  hasPendingChanges?: (deviceUuid: string) => boolean;
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
    // Stagger requests with random delay to prevent overwhelming API
    const delay = Math.random() * 2000; // 0-2 second random delay
    const timer = setTimeout(() => {
      fetchTags();
    }, delay);
    
    return () => clearTimeout(timer);
  }, [deviceUuid]);

  // Listen for tag updates from other components (e.g., AddEditDeviceDialog)
  useEffect(() => {
    const handleTagsUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{ deviceUuid: string }>;
      if (customEvent.detail.deviceUuid === deviceUuid) {
        console.log('[DeviceTagsPills] Tags updated externally, reloading...');
        invalidateDeviceTagsCache(deviceUuid);
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

export function DeviceSidebar({ devices, selectedDeviceId, onAddDevice, onEditDevice , onSelectDevice, hasPendingChanges }: DeviceSidebarProps) {
  // Get fleet context
  const { selectedFleetId, setSelectedFleetId } = useFleet();
  
  // Get routing context
  const { currentPath, navigateToAgent } = useRouting();
  
  // Get unique statuses and types from actual devices using useMemo for performance
  const availableStatuses = useMemo<Device['status'][]>(() => 
    Array.from(new Set(devices.map(d => d.status))) as Device['status'][], 
    [devices]
  );
  
  const availableTypes = useMemo<Device['type'][]>(() => 
    Array.from(new Set(devices.map(d => d.type))) as Device['type'][], 
    [devices]
  );

  const [searchQuery, setSearchQuery] = useState(() => {
    return localStorage.getItem('deviceSidebar.searchQuery') || '';
  });
  const [statusFilters, setStatusFilters] = useState<Device['status'][]>([]);
  const [typeFilters, setTypeFilters] = useState<Device['type'][]>([]);
  const [fleets, setFleets] = useState<Array<{fleet_uuid: string; fleet_name: string; fleet_id?: string}>>([]);
  const [filtersInitialized, setFiltersInitialized] = useState(false);

  // Load available fleets
  useEffect(() => {
    const loadFleets = async () => {
      try {
        const token = localStorage.getItem('accessToken');
        // Skip if no token (not authenticated yet)
        if (!token) return;
        
        const response = await fetch(buildApiUrl('/api/v1/fleets'), {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
          const data = await response.json();
          console.log('[FLEET DEBUG] Loaded fleets:', data.fleets);
          setFleets(data.fleets || []);
        }
      } catch (error) {
        console.error('Error loading fleets:', error);
      }
    };
    loadFleets();
  }, []);

  // Persist search query to localStorage
  useEffect(() => {
    localStorage.setItem('deviceSidebar.searchQuery', searchQuery);
  }, [searchQuery]);

  // Initialize filters once from localStorage, then apply user intent when available options change
  useEffect(() => {
    // Read user's filter intent from localStorage
    const savedStatusFilters = localStorage.getItem('deviceSidebar.statusFilters');
    const savedTypeFilters = localStorage.getItem('deviceSidebar.typeFilters');
    
    let statusIntent: Device['status'][] = [];
    let typeIntent: Device['type'][] = [];
    
    if (savedStatusFilters) {
      try {
        statusIntent = JSON.parse(savedStatusFilters);
      } catch {
        statusIntent = [...availableStatuses];
      }
    } else {
      statusIntent = [...availableStatuses];
    }
    
    if (savedTypeFilters) {
      try {
        typeIntent = JSON.parse(savedTypeFilters);
      } catch {
        typeIntent = [...availableTypes];
      }
    } else {
      typeIntent = [...availableTypes];
    }

    if (!filtersInitialized && (availableStatuses.length > 0 || availableTypes.length > 0)) {
      // Save initial intent to localStorage if not already saved
      if (!savedStatusFilters) {
        localStorage.setItem('deviceSidebar.statusFilters', JSON.stringify(statusIntent));
      }
      if (!savedTypeFilters) {
        localStorage.setItem('deviceSidebar.typeFilters', JSON.stringify(typeIntent));
      }
      setFiltersInitialized(true);
    }
    
    // Apply only available filters from user intent
    setStatusFilters(prev => {
      const newFilters = statusIntent.filter(s => availableStatuses.includes(s));
      if (JSON.stringify(prev.sort()) === JSON.stringify(newFilters.sort())) return prev;
      return newFilters;
    });
    
    setTypeFilters(prev => {
      const newFilters = typeIntent.filter(t => availableTypes.includes(t));
      if (JSON.stringify(prev.sort()) === JSON.stringify(newFilters.sort())) return prev;
      return newFilters;
    });
  }, [availableStatuses, availableTypes, filtersInitialized]);

  const toggleStatusFilter = (status: Device['status']) => {
    // Read current intent from localStorage
    const savedStatusFilters = localStorage.getItem('deviceSidebar.statusFilters');
    let currentIntent: Device['status'][] = [];
    
    if (savedStatusFilters) {
      try {
        currentIntent = JSON.parse(savedStatusFilters);
      } catch {
        currentIntent = [...availableStatuses];
      }
    } else {
      currentIntent = [...availableStatuses];
    }
    
    // Toggle the status in intent
    const newIntent = currentIntent.includes(status)
      ? currentIntent.filter(s => s !== status)
      : [...currentIntent, status];
    
    // Save new intent to localStorage
    localStorage.setItem('deviceSidebar.statusFilters', JSON.stringify(newIntent));
    
    // Update active filters (only available ones)
    setStatusFilters(newIntent.filter(s => availableStatuses.includes(s)));
  };

  const toggleTypeFilter = (type: Device['type']) => {
    // Read current intent from localStorage
    const savedTypeFilters = localStorage.getItem('deviceSidebar.typeFilters');
    let currentIntent: Device['type'][] = [];
    
    if (savedTypeFilters) {
      try {
        currentIntent = JSON.parse(savedTypeFilters);
      } catch {
        currentIntent = [...availableTypes];
      }
    } else {
      currentIntent = [...availableTypes];
    }
    
    // Toggle the type in intent
    const newIntent = currentIntent.includes(type)
      ? currentIntent.filter(t => t !== type)
      : [...currentIntent, type];
    
    // Save new intent to localStorage
    localStorage.setItem('deviceSidebar.typeFilters', JSON.stringify(newIntent));
    
    // Update active filters (only available ones)
    setTypeFilters(newIntent.filter(t => availableTypes.includes(t)));
  };

  const allStatusesSelected = availableStatuses.length > 0 && statusFilters.length === availableStatuses.length;
  const allTypesSelected = availableTypes.length > 0 && typeFilters.length === availableTypes.length;

  const filtersEnabled = false;

  const normalizedFleetId = selectedFleetId === 'unassigned' || selectedFleetId === '__unassigned__'
    ? ''
    : selectedFleetId;

  const filteredDevices = useMemo(() => {
    console.log('[FILTER INPUT]', {
      totalDevices: devices.length,
      selectedFleetId: normalizedFleetId,
      searchQuery,
      deviceFleetIds: devices.map(d => ({
        name: d.name,
        fleet_uuid: (d as any).fleet_uuid,
        fleet_id: (d as any).fleet_id,
        status: d.status,
        type: d.type
      }))
    });

    const filtered = devices.filter(device => {
      const matchesSearch = device.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           device.ipAddress.includes(searchQuery);
      
      // Fleet matching: check both fleet_uuid and fleet_id (legacy support)
      const deviceFleetId = (device as any).fleet_uuid || (device as any).fleet_id;
      const matchesFleet = !normalizedFleetId || deviceFleetId === normalizedFleetId;
  
      
      // Status and type filters are disabled - only apply search and fleet filters
      return matchesSearch && matchesFleet;
    }).sort((a, b) => {
      if (a.status === b.status) return 0;
      if (a.status === 'online') return -1;
      if (b.status === 'online') return 1;
      return 0;
    });


    return filtered;
  }, [devices, normalizedFleetId, searchQuery]);


  return (
    <TooltipProvider>
      <div className="w-full lg:w-80 lg:border-r border-border bg-card h-full flex flex-col overflow-hidden">
      {/* Fleet Filter */}
      {fleets.length > 0 && (
        <div className="px-4 py-3 border-b border-border flex-shrink-0">
          <div className="relative">
            <Layers className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <select
              value={selectedFleetId}
              onChange={(e) => {
                const newFleetId = e.target.value;
                console.log('[FLEET DEBUG] Fleet selected:', newFleetId);
                console.log('[FLEET DEBUG] Current path:', currentPath);
                
                // Update context
                setSelectedFleetId(newFleetId);
                
                // If viewing an agent AND selecting a specific fleet (not "All Fleets"), update URL
                // IMPORTANT: Reset view to 'metrics' when switching fleets to avoid showing
                // tabs/views from agents in the previous fleet
                if (currentPath.type === 'agent' && currentPath.agentId && newFleetId) {
                  console.log('[FLEET DEBUG] Navigating to agent with fleet:', newFleetId, 'resetting view to metrics');
                  navigateToAgent(currentPath.agentId, newFleetId, 'metrics');
                }
                // If selecting "All Fleets" while on agent view, stay on current URL but context updated
                // The filter will show all devices, and URL sync won't override because we're not changing URL
              }}
              className="w-full h-9 pl-10 pr-3 text-sm border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">All Fleets</option>
              {fleets.map((fleet) => (
                <option key={fleet.fleet_uuid || fleet.fleet_id} value={fleet.fleet_uuid || fleet.fleet_id}>
                  {fleet.fleet_name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Search and Filter */}
      <div className="px-4 py-3 space-y-3 border-b border-border flex-shrink-0">
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

        {/* Status and Type Filters - Disabled */}
        {/* <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="flex-1">
                <Filter className="w-4 h-4 mr-2" />
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
        </div> */}
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
                        "absolute -top-1 -right-1 w-4 h-4 rounded-full border-2 border-card",
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
                    
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <Badge variant="outline" className={cn("text-xs", statusBadgeColors[device.status])}>
                        {device.status}
                      </Badge>
                      {hasPendingChanges && hasPendingChanges(device.deviceUuid) && (
                        <Badge className="text-xs text-white" style={{ backgroundColor: 'rgb(217, 119, 6)' }}>
                          Pending
                        </Badge>
                      )}
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
