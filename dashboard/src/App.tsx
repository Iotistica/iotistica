import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { DeviceSidebar, Device } from "./components/AgentSidebar";
import { AddEditDeviceDialog } from "./components/AddEditAgentDialog";
import { useWebSocketConnection, useWebSocket } from "./hooks/useWebSocket";
import type { NetworkInterfaceData } from "./services/websocket";
import { SystemMetrics } from "./components/SystemMetrics";
import { MqttPage } from "./pages/MqttPage";
import { JobsPage } from "./pages/JobsPage";
import { ApplicationsPage } from "./pages/ApplicationsPage";
import { UsagePage } from "./pages/UsagePage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { SecurityPage } from "./pages/SecurityPage";
import { Toaster } from "./components/ui/sonner";
import { Sheet, SheetContent } from "./components/ui/sheet";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Menu, Activity, BarChart3, Radio, CalendarClock, Package, Shield, FileText, Terminal, Layers, Plus, Home, Bell, HelpCircle } from "lucide-react";
import { buildApiUrl } from "./config/api";
import { SensorHealthDashboard } from "./pages/DeviceHealthDashboard";
import { SensorsPage } from "./pages/DevicesPage";
import { EndpointsVisualizationPage } from "./pages/EndpointsVisualizationPage";
import HousekeeperPage from "./pages/HousekeeperPage";
import AgentSettingsPage from "./pages/AgentSettingsPage";
import AccountPage from "./pages/AccountPage";
import { LogsPage } from "./pages/LogsPage";
import { RemoteAccessPage } from "./pages/RemoteAccessPage";
import { ProfilePage } from "./pages/ProfilePage";
import { GlobalDashboardPage } from "./pages/GlobalDashboardPage";
import DeviceTagsPage from "./pages/AgentTagsPage";
import TagDefinitionsPage from "./pages/TagDefinitionsPage";
import { DigitalTwinPage } from "./pages/DigitalTwinPage";
import { EventDebuggerPage } from "./pages/EventDebuggerPage";
import { AuditPage } from "./pages/audit";
import { FleetsPage } from "./pages/FleetsPage";

import { toast } from "sonner";
import { Header } from "./components/Header";
import { useDeviceState } from "./contexts/DeviceStateContext";
import { useFleet } from "./contexts/FleetContext";
import { useAuth } from "./contexts/AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { UserManagementPage } from "./pages/UserManagementPage";
import { useRouting } from "./hooks/useRouting";

// Initialize API traffic tracking
import "./lib/apiInterceptor";
// Initialize auth interceptor
import "./lib/authInterceptor";

// Initial mock applications for each device

export default function App() {
  // Device state context
  const { fetchDeviceState } = useDeviceState();
  
  // Auth context
  const { user, isAuthenticated, isLoading: isAuthLoading, login, logout } = useAuth();
  
  // Fleet context - for auto-assigning devices to selected fleet
  const { selectedFleetId, setSelectedFleetId } = useFleet();
  
  // Initialize selectedDeviceId from localStorage if available
  const [selectedDeviceId, setSelectedDeviceId] = useState(() => {
    return localStorage.getItem('selectedDeviceId') || "";
  });
  const viewOptions = [
    'home',
    'fleets',
    'metrics',
    'sensors',
    'endpoints',
    'mqtt',
    'jobs',
    'applications',
    'audit',
    'usage',
    'analytics',
    'security',
    'maintenance',
    'logs',
    'remote-access',
    'settings',
    'tags',
    'tag-definitions',
    'account',
    'users',
    'profile',
    'dashboard',
    'digital-twin',
    'event-debugger'
  ] as const;
  type View = typeof viewOptions[number];
  const agentViews: View[] = [
    'metrics',
    'sensors',
    'endpoints',
    'jobs',
    'applications',
    'logs',
    'remote-access',
    'settings',
    'tags',
    'event-debugger'
  ];

  const [devices, setDevices] = useState<Device[]>([]);
  const devicesRef = useRef<Device[]>([]); // Ref to access devices without causing re-renders
  const [isLoadingDevices, setIsLoadingDevices] = useState(true);
  const [networkInterfaces, setNetworkInterfaces] = useState<any[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [deviceDialogOpen, setDeviceDialogOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [currentView, setCurrentView] = useState<View>(() => {
    const stored = localStorage.getItem('currentView');
    return stored && viewOptions.includes(stored as View) ? (stored as View) : 'metrics';
  });
  const [fleetNameById, setFleetNameById] = useState<Record<string, string>>({});
  const [fleetUuidById, setFleetUuidById] = useState<Record<string, string>>({});
  const [fleetIdByUuid, setFleetIdByUuid] = useState<Record<string, string>>({});
  const isGlobalView = currentView === 'dashboard' || currentView === 'mqtt' || currentView === 'audit' || currentView === 'security' || currentView === 'fleets';
  const [debugMode, setDebugMode] = useState(false);
  const [isKioskMode, setIsKioskMode] = useState<boolean>(() => {
    return localStorage.getItem('dashboard-kiosk-mode') === 'true';
  });
  
  // Track last URL fleet ID to prevent overriding manual selections
  const lastUrlFleetIdRef = useRef<string | undefined>(undefined);
  
  // Track last viewed agent/fleet for restoration when returning from global views
  const [lastViewedAgent, setLastViewedAgent] = useState<{deviceId: string, deviceUuid: string, fleetUuid: string} | null>(() => {
    try {
      const stored = localStorage.getItem('lastViewedAgent');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });
  
  // Persist last viewed agent to localStorage
  useEffect(() => {
    if (lastViewedAgent) {
      localStorage.setItem('lastViewedAgent', JSON.stringify(lastViewedAgent));
    }
  }, [lastViewedAgent]);
  
  // Memoize selected device to prevent unnecessary re-renders
  const selectedDevice = useMemo(() => {
    return devices.find((d) => d.id === selectedDeviceId) || devices[0];
  }, [devices, selectedDeviceId]);

  // URL routing integration (no UI changes, just URL sync)
  const { currentPath, navigateToAgent, navigateToGlobal, navigateToFleet } = useRouting();

  // Sync URL with current view and selected device
  useEffect(() => {
    if (currentPath.type === 'agent' && currentPath.agentId) {
      // Agent view from URL
      const device = devices.find(d => d.deviceUuid === currentPath.agentId);
      const routeView = currentPath.view as View | undefined;
      const targetView = routeView && agentViews.includes(routeView) ? routeView : 'metrics';
      if (device) {
        const mappedFleetId = currentPath.fleetId
          ? fleetIdByUuid[currentPath.fleetId] || device.fleet_uuid || ''
          : device.fleet_uuid || '';
        setSelectedDeviceId(device.id);
        
        // Save as last viewed agent for restoration when returning from global views
        setLastViewedAgent({
          deviceId: device.id,
          deviceUuid: device.deviceUuid,
          fleetUuid: currentPath.fleetId || device.fleet_uuid || ''
        });
        
        // Only update fleet if URL fleet ID actually changed (not just device poll)
        if (lastUrlFleetIdRef.current !== currentPath.fleetId) {
          console.log('[URL SYNC] URL fleet ID changed:', { 
            from: lastUrlFleetIdRef.current, 
            to: currentPath.fleetId,
            mappedTo: mappedFleetId 
          });
          lastUrlFleetIdRef.current = currentPath.fleetId;
          setSelectedFleetId(mappedFleetId);
        }
        
        setCurrentView(targetView);
      }
    } else if (currentPath.type === 'fleet' && currentPath.fleetId) {
      // Fleet view from URL: show agents view with fleet preselected
      const mappedFleetId = fleetIdByUuid[currentPath.fleetId] || '';
      
      // Only update fleet if URL fleet ID actually changed
      if (lastUrlFleetIdRef.current !== currentPath.fleetId) {
        console.log('[URL SYNC] URL fleet ID changed (fleet view):', { 
          from: lastUrlFleetIdRef.current, 
          to: currentPath.fleetId,
          mappedTo: mappedFleetId 
        });
        lastUrlFleetIdRef.current = currentPath.fleetId;
        setSelectedFleetId(mappedFleetId);
      }
      
      setCurrentView('metrics');
    } else if (currentPath.type === 'global') {
      // Global view from URL
      const view = currentPath.view as View;
      if (viewOptions.includes(view)) {
        setCurrentView(view);
      }
      
      // Only clear fleet if URL type actually changed to global
      if (lastUrlFleetIdRef.current !== undefined) {
        console.log('[URL SYNC] Switched to global view, clearing fleet');
        lastUrlFleetIdRef.current = undefined;
        setSelectedFleetId('');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentViews, currentPath, devices, fleetIdByUuid, setSelectedFleetId]);

  useEffect(() => {
    const fleetId = currentPath.type === 'agent'
      ? currentPath.fleetId
      : currentPath.type === 'fleet'
      ? currentPath.fleetId
      : undefined;

    if (!fleetId || fleetNameById[fleetId]) {
      return;
    }

    const loadFleetName = async () => {
      try {
        const token = localStorage.getItem('accessToken');
        const response = await fetch(buildApiUrl(`/api/v1/fleets/${fleetId}`), {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (!response.ok) {
          throw new Error('Failed to load fleet');
        }

        const data = await response.json();
        const resolvedFleetId = data?.fleet_id || fleetId;
        const resolvedFleetUuid = data?.fleet_uuid as string | undefined;
        const fleetName = data?.fleet_name || fleetId;

        setFleetNameById((prev) => {
          if (prev[fleetId] && (!resolvedFleetUuid || prev[resolvedFleetUuid])) {
            return prev;
          }
          const next = { ...prev, [fleetId]: fleetName, [resolvedFleetId]: fleetName };
          if (resolvedFleetUuid) {
            next[resolvedFleetUuid] = fleetName;
          }
          return next;
        });

        if (resolvedFleetUuid && resolvedFleetId) {
          setFleetUuidById((prev) => (prev[resolvedFleetId] ? prev : { ...prev, [resolvedFleetId]: resolvedFleetUuid }));
          setFleetIdByUuid((prev) => (prev[resolvedFleetUuid] ? prev : { ...prev, [resolvedFleetUuid]: resolvedFleetId }));
        }
      } catch (error) {
        setFleetNameById((prev) => (prev[fleetId] ? prev : { ...prev, [fleetId]: fleetId }));
      }
    };

    loadFleetName();
  }, [currentPath, fleetNameById]);

  const handleGlobalViewChange = useCallback((view: View) => {
    if (view === 'home') {
      // Try to restore last viewed agent first
      if (lastViewedAgent && devices.some(d => d.id === lastViewedAgent.deviceId)) {
        const device = devices.find(d => d.id === lastViewedAgent.deviceId);
        if (device) {
          setSelectedDeviceId(device.id);
          // Use the fleet from lastViewedAgent to restore exact fleet selection
          const fleetUuid = lastViewedAgent.fleetUuid || device.fleet_uuid || '';
          const fleetId = fleetIdByUuid[fleetUuid] || fleetUuid;
          setSelectedFleetId(fleetId);
          setCurrentView('metrics');
          navigateToAgent(device.deviceUuid, fleetUuid, 'metrics');
          return;
        }
      }
      // Fallback: Show agents sidebar with all fleets, select first agent
      setSelectedFleetId('');
      setCurrentView('metrics');
      if (devices.length > 0) {
        setSelectedDeviceId(devices[0].id);
        navigateToAgent(devices[0].deviceUuid, devices[0].fleet_uuid, 'metrics');
      } else {
        navigateToGlobal('home');
      }
    } else {
      // Don't clear fleet selection when going to global view - preserve for later restoration
      navigateToGlobal(view);
    }
  }, [navigateToGlobal, setSelectedFleetId, devices, setCurrentView, navigateToAgent, lastViewedAgent, setSelectedDeviceId, fleetIdByUuid]);

  const handleAgentViewChange = useCallback((view: View) => {
    if (selectedDevice?.deviceUuid) {
      const fleetUuid = selectedDevice.fleet_uuid
        ? selectedDevice.fleet_uuid
        : undefined;
      navigateToAgent(selectedDevice.deviceUuid, fleetUuid, view);
    }
  }, [fleetUuidById, navigateToAgent, selectedDevice]);

  const resolveFleetUuid = useCallback(async (fleetId?: string) => {
    if (!fleetId) {
      return undefined;
    }

    const cached = fleetUuidById[fleetId];
    if (cached) {
      return cached;
    }

    try {
      const token = localStorage.getItem('accessToken');
      const response = await fetch(buildApiUrl(`/api/v1/fleets/${fleetId}`), {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to load fleet');
      }

      const data = await response.json();
      const resolvedFleetId = data?.fleet_id || fleetId;
      const resolvedFleetUuid = data?.fleet_uuid as string | undefined;
      const fleetName = data?.fleet_name || fleetId;

      setFleetNameById((prev) => {
        if (prev[fleetId] && (!resolvedFleetUuid || prev[resolvedFleetUuid])) {
          return prev;
        }
        const next = { ...prev, [fleetId]: fleetName, [resolvedFleetId]: fleetName };
        if (resolvedFleetUuid) {
          next[resolvedFleetUuid] = fleetName;
        }
        return next;
      });

      if (resolvedFleetUuid && resolvedFleetId) {
        setFleetUuidById((prev) => (prev[resolvedFleetId] ? prev : { ...prev, [resolvedFleetId]: resolvedFleetUuid }));
        setFleetIdByUuid((prev) => (prev[resolvedFleetUuid] ? prev : { ...prev, [resolvedFleetUuid]: resolvedFleetId }));
      }

      return resolvedFleetUuid;
    } catch (error) {
      return undefined;
    }
  }, [fleetUuidById]);

  const formatViewLabel = useCallback((view: string) => {
    // Special mappings for views with different display names
    const viewLabelMap: Record<string, string> = {
      'sensors': 'Devices',
      'metrics': 'System',
      'devices': 'Devices',
      'system': 'System',
      'endpoints': 'Endpoints',
      'mqtt': 'MQTT',
      'jobs': 'Jobs',
      'applications': 'Applications',
      'logs': 'Logs',
      'remote-access': 'Remote Access',
      'settings': 'Settings',
      'dashboard': 'Dashboards',
      'home': 'Home',
      'fleets': 'Fleets',
      'audit': 'Audit & Activity',
      'security': 'Security'
    };
    
    // Return mapped label if exists, otherwise capitalize the view
    return viewLabelMap[view] || view
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }, []);

  const breadcrumbs = useMemo(() => {
    if (currentPath.type === 'agent') {
      const fleetLabel = fleetNameById[currentPath.fleetId || ''] || currentPath.fleetId || 'Unassigned';
      const crumbs = [
        { label: 'Home', onClick: () => handleGlobalViewChange('home') },
        { label: fleetLabel, onClick: () => navigateToFleet(currentPath.fleetId || 'unassigned') },
        { label: selectedDevice?.name || currentPath.agentId || 'Agent', onClick: currentPath.view ? () => navigateToAgent(currentPath.agentId || '', currentPath.fleetId) : undefined }
      ];
      
      // Add the sub-view if present (System, Devices, Jobs, Logs, etc.)
      if (currentPath.view) {
        crumbs.push({ label: formatViewLabel(currentPath.view), onClick: undefined });
      }
      
      return crumbs;
    }

    if (currentPath.type === 'fleet') {
      const fleetLabel = fleetNameById[currentPath.fleetId || ''] || currentPath.fleetId || 'Fleet';
      return [
        { label: 'Home', onClick: () => handleGlobalViewChange('home') },
        { label: fleetLabel }
      ];
    }

    if (currentPath.type === 'global') {
      return [{ label: formatViewLabel(currentPath.view || 'home') }];
    }

    return [{ label: 'Home' }];
  }, [currentPath, formatViewLabel, handleGlobalViewChange, navigateToFleet, navigateToAgent, selectedDevice]);

  // Persist selectedDeviceId to localStorage whenever it changes
  // Always save (even empty string) to maintain consistency
  useEffect(() => {
    localStorage.setItem('selectedDeviceId', selectedDeviceId || "");
  }, [selectedDeviceId]);

  // Persist current view to localStorage so refresh keeps agent view
  useEffect(() => {
    localStorage.setItem('currentView', currentView);
  }, [currentView]);

  // Fetch devices from API
  useEffect(() => {
    // Don't fetch devices if not authenticated
    if (!isAuthenticated) {
      setIsLoadingDevices(false);
      return;
    }

    let isFirstLoad = true;
    
    const fetchDevices = async () => {
      try {
        // Only show loading spinner on first load
        if (isFirstLoad) {
          setIsLoadingDevices(true);
          isFirstLoad = false;
        }
        
        // Get auth token from localStorage
        const accessToken = localStorage.getItem('accessToken');
        const apiUrl = buildApiUrl('/api/v1/devices?limit=100');
        console.log('[DEBUG] API URL:', apiUrl);
        console.log('[DEBUG] Fetching devices with token:', accessToken ? `${accessToken.substring(0, 20)}...` : 'NULL');
        console.log('[DEBUG] Full auth header:', `Bearer ${accessToken}`);
        
        const response = await fetch(apiUrl, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
        });
        
        console.log('[DEBUG] Fetch response status:', response.status, response.statusText);
        console.log('[DEBUG] Response headers:', Object.fromEntries(response.headers.entries()));
        
        // Try to get error details if not ok
        if (!response.ok) {
          const errorText = await response.text();
          console.log('[DEBUG] Error response body:', errorText);
          throw new Error(`Failed to fetch devices: ${response.statusText}`);
        }

        const data = await response.json();
        
        console.log('Devices API response:', data);
        console.log('[FLEET DEBUG] Raw devices with fleet_uuid:', data.devices.map((d: any) => ({ uuid: d.uuid, name: d.device_name, fleet_uuid: d.fleet_uuid })));
        
        // Transform API response to match Device interface
        // CRITICAL: Use stable UUID as ID instead of index to prevent React remounts
        const transformedDevices: Device[] = data.devices.map((apiDevice: any) => ({
          id: apiDevice.uuid, // Use stable UUID instead of index
          deviceUuid: apiDevice.uuid,
          name: apiDevice.device_name || 'Unnamed Device',
          type: apiDevice.device_type || 'gateway',
          status: apiDevice.provisioning_state === 'pending'
            ? 'pending'
            : (apiDevice.is_online ? 'online' : 'offline'),
          ipAddress: apiDevice.ip_address || 'N/A',
          macAddress: apiDevice.mac_address || 'N/A',
          lastSeen: formatLastSeen(apiDevice.last_connectivity_event),
          lastConnectivity: apiDevice.last_connectivity_event,
          cpu: Math.round(parseFloat(apiDevice.cpu_usage) || 0),
          memory: apiDevice.memory_usage && apiDevice.memory_total 
            ? Math.round((parseFloat(apiDevice.memory_usage) / parseFloat(apiDevice.memory_total) * 100)) 
            : 0,
          disk: apiDevice.storage_usage && apiDevice.storage_total 
            ? Math.round((parseFloat(apiDevice.storage_usage) / parseFloat(apiDevice.storage_total) * 100)) 
            : 0,
          fleet_uuid: apiDevice.fleet_uuid || undefined, // API returns fleet_uuid
        }));

        // Only update state if devices actually changed (use callback for React optimization)
        setDevices((prev) => {
          if (JSON.stringify(prev) !== JSON.stringify(transformedDevices)) {
            devicesRef.current = transformedDevices; // Keep ref in sync
            return transformedDevices;
          }
          // No changes - return previous state to prevent re-render
          devicesRef.current = prev; // Ensure ref stays in sync
          return prev;
        });
        
        // ONLY set fallback device on initial load (not on subsequent polls)
        // This preserves user's selection across refreshes and prevents auto-switching
        if (isFirstLoad && transformedDevices.length > 0) {
          // Check if the currently selected device exists in the fetched list
          const selectedExists = selectedDeviceId && transformedDevices.some(d => d.id === selectedDeviceId);
          
          if (!selectedExists) {
            // If no valid selection, prefer first online device, then fall back to first device
            const firstOnline = transformedDevices.find(d => d.status === 'online');
            const fallbackDevice = firstOnline || transformedDevices[0];
            setSelectedDeviceId(fallbackDevice.id);
          }
          // If selectedExists is true, keep the current selection (preserves user's choice on refresh)
        }
      } catch (error) {
        console.error('Error fetching devices:', error);
        // Set all devices to offline if API is unreachable
        setDevices((prev) => prev.map(device => ({ ...device, status: 'offline' })));
      } finally {
        setIsLoadingDevices(false);
      }
    };

    fetchDevices();
    
    // Refresh devices every 30 seconds
    const interval = setInterval(fetchDevices, 30000);
    return () => clearInterval(interval);
  }, [isAuthenticated]); // Only run when authentication status changes

  // Fetch device state from context when device changes
  useEffect(() => {
    // Don't fetch device state if not authenticated
    if (!isAuthenticated) return;
    if (!selectedDeviceId) return;
    
    const selectedDevice = devices.find((d) => d.id === selectedDeviceId);
    if (!selectedDevice?.deviceUuid) return;

    // Initial fetch
    fetchDeviceState(selectedDevice.deviceUuid);
    
    // Poll every 10 seconds for updates
    const interval = setInterval(() => {
      fetchDeviceState(selectedDevice.deviceUuid);
    }, 10000);
    
    return () => clearInterval(interval);
  }, [selectedDeviceId, devices, isAuthenticated]); // fetchDeviceState is stable (useCallback with []), safe to omit

  // Get selected device UUID for WebSocket connection
  const currentDevice = useMemo(() => 
    devices.find(d => d.id === selectedDeviceId),
    [devices, selectedDeviceId]
  );

  // Only establish WebSocket connection if device is online
  // Prevents connection errors for offline/pending devices
  const wsDeviceUuid = useMemo(() => {
    if (!currentDevice) return null;
    // Only connect if device is online (not offline, pending, or warning)
    return currentDevice.status === 'online' ? currentDevice.deviceUuid : null;
  }, [currentDevice]);

  useWebSocketConnection(wsDeviceUuid);

  // Handle network interfaces updates via WebSocket
  const handleNetworkInterfaces = useCallback((data: { interfaces: NetworkInterfaceData[] }) => {
    console.log('[WebSocket] Received network interfaces:', data);
    if (data.interfaces && Array.isArray(data.interfaces)) {
      const interfaces = data.interfaces.map((iface: any) => {
        // Normalize type: "wired" -> "ethernet"
        let type = iface.type || 'ethernet';
        if (type === 'wired') type = 'ethernet';
        
        return {
          id: iface.id || iface.name,
          name: iface.name,
          type,
          ipAddress: iface.ipAddress,
          status: iface.status,
          speed: iface.speed,
          signal: iface.signal,
          mac: iface.mac,
          default: iface.default,
          virtual: iface.virtual,
        };
      });
      setNetworkInterfaces(interfaces);
    }
  }, []);

  // Subscribe to WebSocket channels (only for online devices)
  useWebSocket(wsDeviceUuid, 'network-interfaces', handleNetworkInterfaces);

  // Clear data when device changes
  useEffect(() => {
    if (!selectedDeviceId) {
      setNetworkInterfaces([]);
    }
  }, [selectedDeviceId]);

  // Listen for custom event to open tags page
  useEffect(() => {
    const handleOpenTags = (event: Event) => {
      const customEvent = event as CustomEvent<{ deviceUuid: string }>;
      // Find device by UUID and select it, then switch to tags view
      const device = devices.find(d => d.deviceUuid === customEvent.detail.deviceUuid);
      if (device) {
        setSelectedDeviceId(device.id);
        setCurrentView('tags');
        const fleetUuid = device.fleet_uuid
          ? device.fleet_uuid
          : undefined;
        navigateToAgent(device.deviceUuid, fleetUuid, 'tags');
      }
    };

    window.addEventListener('open-device-tags', handleOpenTags);
    return () => window.removeEventListener('open-device-tags', handleOpenTags);
  }, [devices]);

  // Listen for delete events to update device list without full refresh
  useEffect(() => {
    const handleDeviceDeleted = (event: Event) => {
      const customEvent = event as CustomEvent<{ deviceUuid: string }>;
      const deletedDevice = devices.find(d => d.deviceUuid === customEvent.detail.deviceUuid);

      if (!deletedDevice) return;

      setDevices(prev => prev.filter(d => d.deviceUuid !== customEvent.detail.deviceUuid));
      setSelectedDeviceId(prev => (prev === deletedDevice.id ? "" : prev));
    };

    window.addEventListener('device-deleted', handleDeviceDeleted);
    return () => window.removeEventListener('device-deleted', handleDeviceDeleted);
  }, [devices]);

  // Listen for kiosk mode changes
  useEffect(() => {
    const handleKioskModeChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ kioskMode: boolean }>;
      setIsKioskMode(customEvent.detail.kioskMode);
    };

    window.addEventListener('kiosk-mode-changed', handleKioskModeChange);
    return () => window.removeEventListener('kiosk-mode-changed', handleKioskModeChange);
  }, []);

  // Helper function to format last seen time
  const formatLastSeen = (timestamp: string | null): string => {
    if (!timestamp) return 'Never';
    
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  };


    const handleAddDevice = () => {
    setEditingDevice(null);
    setDeviceDialogOpen(true);
  };

  const handleEditDevice = (device: Device) => {
    setEditingDevice(device);
    setDeviceDialogOpen(true);
  };

  const handleSaveDevice = async (deviceData: Omit<Device, "id"> & { id?: string; tags?: Record<string, string> }) => {
    if (deviceData.id) {
      // Edit existing device - persist changes to API
      try {
        toast.loading('Updating device...', { id: 'update-device' });
        
        // Update device basic info
        const accessToken = localStorage.getItem('accessToken');
        const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceData.id}`), {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            deviceName: deviceData.name,
            deviceType: deviceData.type,
            ipAddress: deviceData.ipAddress,
            macAddress: deviceData.macAddress,
            location: (deviceData as any).location,
            fleet_uuid: deviceData.fleet_uuid || null
          })
        });
        
        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.message || 'Failed to update device');
        }
        
        await response.json();
        
        // Update tags if provided
        if (deviceData.tags !== undefined) {
          console.log('[DEBUG] Updating tags for device:', {
            deviceUuid: deviceData.deviceUuid,
            tags: deviceData.tags,
            url: buildApiUrl(`/api/v1/devices/${deviceData.deviceUuid}/tags`)
          });
          
          const tagsResponse = await fetch(buildApiUrl(`/api/v1/devices/${deviceData.deviceUuid}/tags`), {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              tags: deviceData.tags
            })
          });
          
          if (!tagsResponse.ok) {
            const error = await tagsResponse.json();
            console.error('[DEBUG] Failed to update tags:', error);
            // Don't throw - device update succeeded, just log tag update failure
            toast.warning('Device updated but tags may not have saved', { id: 'update-device' });
            return;
          }
          
          const tagsResult = await tagsResponse.json();
          console.log('[DEBUG] Tags updated successfully:', tagsResult);
          
          // Dispatch event to notify DeviceTagsPage to reload tags
          window.dispatchEvent(new CustomEvent('device-tags-updated', { 
            detail: { deviceUuid: deviceData.deviceUuid } 
          }));
        }
        
        setDevices(prev =>
          prev.map(d => (d.id === deviceData.id ? { ...d, ...deviceData } : d))
        );
        toast.success('Device updated successfully', { id: 'update-device' });
      } catch (error: any) {
        console.error('Error updating device:', error);
        toast.error(`Failed to update device: ${error.message}`, { id: 'update-device' });
      }
    } else {
      // Add new device - unified endpoint for all types
      try {
        const isVirtual = deviceData.type === 'virtual';
        
        toast.loading(isVirtual ? 'Deploying virtual agent...' : 'Registering device...', { id: 'register-device' });

        const accessToken = localStorage.getItem('accessToken');
        
        // Unified request body for all device types
        const requestBody: any = {
          deviceName: deviceData.name,
          deviceType: deviceData.type,
          fleet_uuid: deviceData.fleet_uuid || null,
        };
        
        // Add physical device fields
        if (!isVirtual) {
          requestBody.ipAddress = deviceData.ipAddress;
          requestBody.macAddress = deviceData.macAddress;
        }
        
        // Add tags if provided
        if (deviceData.tags && Object.keys(deviceData.tags).length > 0) {
          requestBody.tags = Object.entries(deviceData.tags).map(([key, value]) => ({ key, value }));
        }
        
        const response = await fetch(buildApiUrl('/api/v1/devices'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.message || 'Failed to register device');
        }

        const result = await response.json();
        
        // Extract device info based on response format
        const deviceUuid = result.deviceUuid || result.device?.uuid;
        const isVirtualResponse = result.deploymentStatus !== undefined;
        
        const successMessage = isVirtualResponse
          ? `Virtual agent deployment initiated (${result.deploymentStatus})` 
          : 'Device registered successfully! Waiting for agent to connect.';
        
        toast.success(successMessage, { id: 'register-device' });

        // Dispatch tag update event if tags were added
        if (deviceData.tags && Object.keys(deviceData.tags).length > 0) {
          window.dispatchEvent(new CustomEvent('device-tags-updated', { 
            detail: { deviceUuid } 
          }));
        }

        // Add device to local state with offline status
        const newDevice: Device = {
          id: deviceUuid,
          deviceUuid,
          name: deviceData.name,
          type: deviceData.type,
          ipAddress: deviceData.ipAddress || 'N/A',
          macAddress: deviceData.macAddress || 'N/A',
          status: 'offline', // Will update when agent/pod connects
          lastSeen: 'Never',
          cpu: 0,
          memory: 0,
          disk: 0,
          fleet_uuid: deviceData.fleet_uuid || undefined,
        };
        
        setDevices(prev => [...prev, newDevice]);
        setSelectedDeviceId(newDevice.id);

        // Refresh devices list after a short delay
        setTimeout(() => {
          setDevices(prev => [...prev]);
        }, 2000);

      } catch (error: any) {
        console.error('Error registering device:', error);
        toast.error(`Failed to register device: ${error.message}`, { id: 'register-device' });
      }
    }
  };

  const handleLogout = () => {
    logout();
  };

  const handleLogin = (accessToken: string, refreshToken: string, userData: any) => {
    login(accessToken, refreshToken, userData);
  };

  const handleSelectDevice = async (deviceId: string) => {
    const device = devices.find((d) => d.id === deviceId);
    setSidebarOpen(false); // Close sidebar on mobile after selection

    if (device) {
      const targetView = isGlobalView ? 'metrics' : currentView;
      const view = agentViews.includes(targetView) ? targetView : 'metrics';
      const fleetUuid = device.fleet_uuid || await resolveFleetUuid(device.fleet_uuid);
      
      // Save as last viewed agent for restoration
      setLastViewedAgent({
        deviceId: device.id,
        deviceUuid: device.deviceUuid,
        fleetUuid: fleetUuid || ''
      });
      
      navigateToAgent(device.deviceUuid, fleetUuid, view);
    }
  };

  // Deployment actions (agent-specific)
  const { syncTargetState, cancelDeployment, hasPendingChanges, saveTargetState, getDeviceState, discardPendingChanges } = useDeviceState();
  const needsDeployment = selectedDevice?.deviceUuid ? hasPendingChanges(selectedDevice.deviceUuid) : false;
  const deviceState = selectedDevice?.deviceUuid ? getDeviceState(selectedDevice.deviceUuid) : null;
  const hasUnsavedChanges = deviceState?.isDirty || false;

  // Calculate devices with pending changes for "Deploy All"
  const devicesWithPendingChanges = useMemo(() => {
    return devices.filter(d => d.deviceUuid && hasPendingChanges(d.deviceUuid));
  }, [devices, hasPendingChanges]);

  const handleDeployAll = async () => {
    if (devicesWithPendingChanges.length === 0) {
      toast.info("No devices have pending changes");
      return;
    }

    const totalDevices = devicesWithPendingChanges.length;
    toast.info(`Starting deployment to ${totalDevices} device(s)...`);

    let successCount = 0;
    let failCount = 0;

    for (const device of devicesWithPendingChanges) {
      try {
        const deviceState = getDeviceState(device.deviceUuid);
        
        // Save draft if there are unsaved changes
        if (deviceState?.isDirty) {
          await saveTargetState(device.deviceUuid);
        }
        
        // Deploy
        await syncTargetState(device.deviceUuid, 'dashboard');
        window.dispatchEvent(new CustomEvent('deployment-started', { detail: { deviceUuid: device.deviceUuid } }));
        successCount++;
        toast.success(`✓ ${device.name} deployed (${successCount}/${totalDevices})`);
      } catch (error: any) {
        failCount++;
        console.error(`Failed to deploy ${device.name}:`, error);
        toast.error(`✗ ${device.name} failed: ${error.message || 'Unknown error'}`);
      }
    }

    // Final summary
    if (failCount === 0) {
      toast.success(`🎉 All ${successCount} device(s) deployed successfully!`);
    } else {
      toast.warning(`Deployment complete: ${successCount} succeeded, ${failCount} failed`);
    }
  };

  const handleDeploy = async () => {
    if (!selectedDevice?.deviceUuid) {
      toast.error("No device selected");
      return;
    }

    try {
      if (hasUnsavedChanges) {
        toast.info("Saving changes...");
        try {
          await saveTargetState(selectedDevice.deviceUuid);
          toast.success("Changes saved");
        } catch (saveError: any) {
          console.error("Save error:", saveError);
          toast.error(`Failed to save changes: ${saveError.message || 'Unknown error'}`);
          throw saveError;
        }
      }

      const toastId = toast.loading("Deploying changes...");
      try {
        await syncTargetState(selectedDevice.deviceUuid, 'dashboard');
        window.dispatchEvent(new CustomEvent('deployment-started', { detail: { deviceUuid: selectedDevice.deviceUuid } }));
        toast.success("Changes deployed - waiting for agent confirmation", { id: toastId });
      } catch (deployError: any) {
        console.error("Deployment error:", deployError);
        toast.error(`Deployment failed: ${deployError.message || 'Unknown error'}`, { id: toastId });
        throw deployError;
      }
    } catch (error: any) {
      // Already handled above
    }
  };

  const handleCancelDeploy = async () => {
    if (!selectedDevice?.deviceUuid) {
      toast.error("No device selected");
      return;
    }

    try {
      // Check if we have unsaved local changes or saved deployment
      if (hasUnsavedChanges && !deviceState?.targetState?.needsDeployment) {
        // Only local changes - discard them
        discardPendingChanges(selectedDevice.deviceUuid);
        toast.success("Unsaved changes discarded");
      } else {
        // Saved deployment - cancel via API
        const toastId = toast.loading("Canceling deployment...");
        await cancelDeployment(selectedDevice.deviceUuid);
        toast.success("Deployment cancelled - reverted to last deployed state", { id: toastId });
      }
    } catch (error: any) {
      console.error("Cancel deployment error:", error);
      toast.error(`Failed to cancel: ${error.message || 'Unknown error'}`);
    }
  };

  const handleSaveDraft = async () => {
    if (!selectedDevice?.deviceUuid) {
      toast.error("No device selected");
      return;
    }

    try {
      await saveTargetState(selectedDevice.deviceUuid);
      toast.success("Changes saved as draft");
    } catch (error) {
      toast.error("Failed to save draft");
      console.error("Save draft error:", error);
    }
  };

  // Application management now handled entirely by DeviceStateContext via ApplicationsCard
  // All application handlers (add, update, remove, toggle) removed - managed by context

  // No history initialization - charts will populate only with real data from API updates
  // History arrays start empty and fill as new data arrives from device metrics

  // Disabled mock simulation - using real data from API only
  // Real device metrics are fetched every 30 seconds from /api/v1/devices

  // Show loading while checking auth
  if (isAuthLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // Show login page if not authenticated
  if (!isAuthenticated) {
    return (
      <>
        <LoginPage onLogin={handleLogin} />
        <Toaster />
      </>
    );
  }

  return (

    <div className="flex flex-col h-screen overflow-hidden">

           {/* Header - Hidden in kiosk mode */}
      {!isKioskMode && (
        <Header 
          isAuthenticated={isAuthenticated}
          onLogout={handleLogout}
          userEmail={user?.email || ''}
          userName={user?.username || ''}
          deviceUuid={selectedDevice?.deviceUuid}
          onHomeClick={() => handleGlobalViewChange('home')}
          onAccountClick={() => handleGlobalViewChange('account')}
          onUsersClick={() => handleGlobalViewChange('users')}
          onProfileClick={() => handleGlobalViewChange('profile')}
          onTagDefinitionsClick={() => handleGlobalViewChange('tag-definitions')}
          onDigitalTwinClick={() => handleGlobalViewChange('digital-twin')}
          userRole={user?.role || 'viewer'}
          needsDeployment={needsDeployment}
          hasUnsavedChanges={hasUnsavedChanges}
          onDeploy={handleDeploy}
          onCancelDeploy={handleCancelDeploy}
          onSaveDraft={handleSaveDraft}
          devicesWithPendingChanges={devicesWithPendingChanges.length}
          onDeployAll={handleDeployAll}
          isGlobalView={isGlobalView}
        />
      )}

      {/* Global Menu - Hidden in kiosk mode */}
      {!isKioskMode && (
        <div className="bg-card border-b border-border px-6 py-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button
              variant={currentView === 'home' ? 'default' : 'outline'}
              size="sm"
              onClick={() => handleGlobalViewChange('home')}
              style={{ fontSize: '1.1rem', padding: '0.6rem 1.25rem', cursor: 'pointer' }}
            >
              <Home className="w-5 h-5 mr-2" />
              Home
            </Button>
            <Button
              variant={currentView === 'fleets' ? 'default' : 'outline'}
              size="sm"
              onClick={() => handleGlobalViewChange('fleets')}
              style={{ fontSize: '1.1rem', padding: '0.6rem 1.25rem', cursor: 'pointer' }}
            >
              <Layers className="w-5 h-5 mr-2" />
              Fleets
            </Button>
            {/* <Button
              variant={!isGlobalView ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('metrics')}
            >
              <Activity className="w-4 h-4 mr-2" />
              Agents
            </Button> */}
            <div className="flex items-center gap-2 overflow-x-auto">
              <Button
                variant={currentView === 'dashboard' ? 'default' : 'outline'}
                size="sm"
                onClick={() => handleGlobalViewChange('dashboard')}
                style={{ fontSize: '1.1rem', padding: '0.6rem 1.25rem', cursor: 'pointer' }}
              >
                <BarChart3 className="w-5 h-5 mr-2" />
                Dashboards
              </Button>
              <Button
                variant={currentView === 'mqtt' ? 'default' : 'outline'}
                size="sm"
                onClick={() => handleGlobalViewChange('mqtt')}
                style={{ fontSize: '1.1rem', padding: '0.6rem 1.25rem', cursor: 'pointer' }}
              >
                <Radio className="w-5 h-5 mr-2" />
                MQTT
              </Button>
              <Button
                variant={currentView === 'audit' ? 'default' : 'outline'}
                size="sm"
                onClick={() => handleGlobalViewChange('audit')}
                style={{ fontSize: '1.1rem', padding: '0.6rem 1.25rem', cursor: 'pointer' }}
              >
                <FileText className="w-5 h-5 mr-2" />
                Audit & Activity
              </Button>
              <Button
                variant={currentView === 'security' ? 'default' : 'outline'}
                size="sm"
                onClick={() => handleGlobalViewChange('security')}
                style={{ fontSize: '1.1rem', padding: '0.6rem 1.25rem', cursor: 'pointer' }}
              >
                <Shield className="w-5 h-5 mr-2" />
                Security
              </Button>
            </div>
          </div>
          
          {/* Right Side Items */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => toast.info("Notifications")}
              style={{ fontSize: '1.1rem', padding: '0.6rem 1.25rem', cursor: 'pointer' }}
            >
              <Bell className="w-5 h-5 mr-2" />
              Notifications
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => toast.info("Help & Support")}
              style={{ fontSize: '1.1rem', padding: '0.6rem 1.25rem', cursor: 'pointer' }}
            >
              <HelpCircle className="w-5 h-5 mr-2" />
              Help & Support
            </Button>
          </div>
        </div>
      )}

      {!isKioskMode && (
        <div className="bg-card border-b border-border px-6 py-2 text-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-muted-foreground">
              {breadcrumbs.map((crumb, index) => (
                <div key={`${crumb.label}-${index}`} className="flex items-center gap-2">
                  {crumb.onClick ? (
                    <button
                      type="button"
                      onClick={crumb.onClick}
                      className="hover:text-foreground transition-colors"
                    >
                      {crumb.label}
                    </button>
                  ) : (
                    <span className="text-foreground">{crumb.label}</span>
                  )}
                  {index < breadcrumbs.length - 1 && (
                    <span className="text-muted-foreground">/</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
                {/* Desktop Sidebar - Hidden on mobile and in kiosk mode */}
        {!isKioskMode && !isGlobalView && (
          <div className="hidden lg:block">
            <DeviceSidebar
              devices={devices}
              selectedDeviceId={selectedDeviceId}
              onSelectDevice={handleSelectDevice}
              onAddDevice={handleAddDevice}
              onEditDevice={handleEditDevice}
              hasPendingChanges={hasPendingChanges}
            />
          </div>
        )}
        {/* Main Content Area */}
        <div className="flex-1 flex flex-col overflow-y-auto">
          {isGlobalView ? (
            <>
              {currentView === 'fleets' && (
                <FleetsPage />
              )}
              {currentView === 'dashboard' && (
                <div className="h-full overflow-hidden">
                  <GlobalDashboardPage 
                    devices={devices} 
                    onDeviceSelect={(device) => {
                      setSelectedDeviceId(device.id);
                      void resolveFleetUuid(device.fleet_uuid).then((fleetUuid) => {
                        navigateToAgent(device.deviceUuid, fleetUuid || device.fleet_uuid, 'metrics');
                      });
                    }} 
                  />
                </div>
              )}
              {currentView === 'mqtt' && (
                <MqttPage device={selectedDevice} devices={devices} />
              )}
              {currentView === 'audit' && (
                <AuditPage />
              )}
              {currentView === 'security' && (
                <div className="flex-1 bg-background overflow-auto p-6">
                  <SecurityPage />
                </div>
              )}
            </>
          ) : isLoadingDevices ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
                <p className="text-gray-600">Loading devices...</p>
              </div>
            </div>
          ) : devices.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-md px-4">
                <p className="text-xl font-semibold text-foreground mb-2">No Devices Found</p>
                <p className="text-muted-foreground mb-4">Get started by provisioning your first device.</p>
                <Button onClick={handleAddDevice}>Add Device</Button>
              </div>
            </div>
          ) : !selectedDevice ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-gray-600">Select a device from the sidebar</p>
            </div>
          ) : (
            <>
          {/* Mobile Header with Menu Button - Sticky at top - Hidden in kiosk mode */}
          {!isKioskMode && !isGlobalView && (
            <div className="lg:hidden bg-card border-b border-border p-4 flex items-center gap-3 sticky top-0 z-10">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu className="w-5 h-5" />
            </Button>
            <div className="flex-1 min-w-0">
              <h2 className="font-semibold text-foreground">{selectedDevice.name}</h2>
              <div className="flex items-center gap-2 mt-1">
                <Badge
                  variant="outline"
                  className={
                    selectedDevice.status === "online"
                      ? "bg-green-100 text-green-700 border-green-200 text-xs"
                      : selectedDevice.status === "warning"
                      ? "bg-yellow-100 text-yellow-700 border-yellow-200 text-xs"
                      : "bg-gray-100 text-gray-700 border-gray-200 text-xs"
                  }
                >
                  {selectedDevice.status}
                </Badge>
                <span className="text-xs text-muted-foreground">{selectedDevice.ipAddress}</span>
              </div>
            </div>
          </div>
          )}

          {/* View Toggle Buttons - Hidden in kiosk mode */}
          {!isKioskMode && !isGlobalView && (
            <div className="bg-card border-b border-border px-6 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 overflow-x-auto flex-1 pr-2">
            <Button
              variant={currentView === 'metrics' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => handleAgentViewChange('metrics')}
              className="text-sm"
            >
              <BarChart3 className="w-4 h-4 mr-2" />
              System
            </Button>
            <Button
              variant={currentView === 'sensors' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => handleAgentViewChange('sensors')}
              className="text-sm"
            >
              <Activity className="w-4 h-4 mr-2" />
              Devices
            </Button>
            {/* <Button              variant={currentView === 'endpoints' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('endpoints')}
            >
              <BarChart3 className="w-4 h-4 mr-2" />
              Endpoints Viz
            </Button> */}
            <Button
              variant={currentView === 'jobs' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => handleAgentViewChange('jobs')}
              className="text-sm"
            >
              <CalendarClock className="w-4 h-4 mr-2" />
              Jobs
            </Button>
            <Button
              variant={currentView === 'applications' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => handleAgentViewChange('applications')}
              className="text-sm"
            >
              <Package className="w-4 h-4 mr-2" />
              Applications
            </Button>
            {/* <Button
              variant={currentView === 'event-debugger' ? 'default' : 'outline'}}
              size="sm"
              onClick={() => setCurrentView('event-debugger')}
            >
              <Activity className="w-4 h-4 mr-2" />
              Event Debugger
            </Button> */}
            {/* <Button
              variant={currentView === 'usage' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('usage')}
            >
              <TrendingUp className="w-4 h-4 mr-2" />
              API Usage
            </Button> */}
            {/* <Button
              variant={currentView === 'analytics' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('analytics')}
            >
              <LineChart className="w-4 h-4 mr-2" />
              Traffic Monitor
            </Button> */}
            {/* <Button
              variant={currentView === 'maintenance' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('maintenance')}
            >
              <Settings className="w-4 h-4 mr-2" />
              Housekeeping
            </Button> */}
            <Button
              variant={currentView === 'logs' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => handleAgentViewChange('logs')}
              className="text-sm"
            >
              <FileText className="w-4 h-4 mr-2" />
              Logs
            </Button>
            <Button
              variant={currentView === 'remote-access' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => handleAgentViewChange('remote-access')}
              className="text-sm"
            >
              <Terminal className="w-4 h-4 mr-2" />
              Remote Access
            </Button>
            <Button
              variant={currentView === 'settings' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => handleAgentViewChange('settings')}
              className="text-sm"
            >
              <Shield className="w-4 h-4 mr-2" />
              Settings
            </Button>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                onClick={handleAddDevice}
                size="sm"
              >
                <Plus className="w-4 h-4 mr-1" />
                Add agent
              </Button>
            </div>
            {/* <Button
              variant={currentView === 'tags' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('tags')}
            >
              <Tag className="w-4 h-4 mr-2" />
              Tags
            </Button> */}
          </div>
          )}

          {/* Conditional Content */}
          {currentView === 'metrics' && (
            <SystemMetrics
              device={selectedDevice}
              networkInterfaces={networkInterfaces}
            />
          )}
          {currentView === 'applications' && (
            <ApplicationsPage
              device={selectedDevice}
            />
          )}
          {currentView === 'sensors' && (
            debugMode 
              ? <SensorHealthDashboard deviceUuid={selectedDevice.deviceUuid} />
              : <SensorsPage 
                  deviceUuid={selectedDevice.deviceUuid}
                  deviceStatus={selectedDevice.status}
                  deviceType={selectedDevice.type}
                  debugMode={debugMode}
                  onDebugModeChange={setDebugMode}
                />
          )}
          {currentView === 'endpoints' && (
            <EndpointsVisualizationPage />
          )}
          {currentView === 'jobs' && (
            <JobsPage device={selectedDevice} />
          )}
          {currentView === 'event-debugger' && (
            <EventDebuggerPage deviceUuid={selectedDevice.deviceUuid} />
          )}
          {currentView === 'usage' && (
            <UsagePage />
          )}
          {currentView === 'analytics' && (
            <AnalyticsPage device={selectedDevice} />
          )}
          {currentView === 'maintenance' && (
            <HousekeeperPage />
          )}
          {currentView === 'logs' && (
            <LogsPage deviceUuid={selectedDevice.deviceUuid} />
          )}
          {currentView === 'remote-access' && (
            <RemoteAccessPage deviceUuid={selectedDevice.deviceUuid} />
          )}
          {currentView === 'settings' && (
            <AgentSettingsPage deviceUuid={selectedDevice.deviceUuid} />
          )}
          {currentView === 'tags' && (
            <DeviceTagsPage deviceUuid={selectedDevice.deviceUuid} />
          )}
          {currentView === 'tag-definitions' && (
            <TagDefinitionsPage />
          )}
          {currentView === 'digital-twin' && (
            <DigitalTwinPage />
          )}
          {currentView === 'account' && (
            <AccountPage />
          )}
          {currentView === 'users' && (
            <UserManagementPage />
          )}
          {currentView === 'profile' && (
            <ProfilePage />
          )}
            </>
          )}
      </div>



        {/* Mobile Drawer - Opens from right */}
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="right" className="p-0 w-80">
            <DeviceSidebar
              devices={devices}
              selectedDeviceId={selectedDeviceId}
              onSelectDevice={handleSelectDevice}
              onAddDevice={handleAddDevice}
              onEditDevice={handleEditDevice}
              hasPendingChanges={hasPendingChanges}
            />
          </SheetContent>
        </Sheet>
      </div>

       {/* Add/Edit Device Dialog */}
      <AddEditDeviceDialog
        open={deviceDialogOpen}
        onOpenChange={setDeviceDialogOpen}
        device={editingDevice}
        onSave={handleSaveDevice}
      />

      <Toaster />
    </div>
  );
}
