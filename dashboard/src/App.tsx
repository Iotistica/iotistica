import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { DeviceSidebar, Device } from "./components/DeviceSidebar";
import { AddEditDeviceDialog } from "./components/AddEditDeviceDialog";
import { useWebSocketConnection, useWebSocket } from "./hooks/useWebSocket";
import type { NetworkInterfaceData } from "./services/websocket";
import { SystemMetrics } from "./components/SystemMetrics";
import { MqttPage } from "./pages/MqttPage";
import { JobsPage } from "./pages/JobsPage";
import { ApplicationsPage } from "./pages/ApplicationsPage";
import { TimelinePage } from "./components/TimelinePage";
import { UsagePage } from "./pages/UsagePage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { SecurityPage } from "./pages/SecurityPage";
import { Toaster } from "./components/ui/sonner";
import { Sheet, SheetContent } from "./components/ui/sheet";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Menu, Activity, BarChart3, Radio, CalendarClock, Clock, Package, TrendingUp, LineChart, Shield, Settings, FileText, Tag } from "lucide-react";
import { buildApiUrl } from "./config/api";
import { SensorHealthDashboard } from "./pages/SensorHealthDashboard";
import { SensorsPage } from "./pages/SensorsPage";
import HousekeeperPage from "./pages/HousekeeperPage";
import DeviceSettingsPage from "./pages/DeviceSettingsPage";
import AccountPage from "./pages/AccountPage";
import { LogsPage } from "./pages/LogsPage";
import { ProfilePage } from "./pages/ProfilePage";
import { GlobalDashboardPage } from "./pages/GlobalDashboardPage";
import DeviceTagsPage from "./pages/DeviceTagsPage";
import TagDefinitionsPage from "./pages/TagDefinitionsPage";
import { DigitalTwinPage } from "./pages/DigitalTwinPage";
import { EventDebuggerPage } from "./pages/EventDebuggerPage";

import { toast } from "sonner";
import { Header } from "./components/Header";
import { useDeviceState } from "./contexts/DeviceStateContext";
import { useAuth } from "./contexts/AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { UserManagementPage } from "./pages/UserManagementPage";

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
  
  // Initialize selectedDeviceId from localStorage if available
  const [selectedDeviceId, setSelectedDeviceId] = useState(() => {
    return localStorage.getItem('selectedDeviceId') || "";
  });
  const [devices, setDevices] = useState<Device[]>([]);
  const devicesRef = useRef<Device[]>([]); // Ref to access devices without causing re-renders
  const [isLoadingDevices, setIsLoadingDevices] = useState(true);
  const [networkInterfaces, setNetworkInterfaces] = useState<any[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [deviceDialogOpen, setDeviceDialogOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [currentView, setCurrentView] = useState<'metrics' | 'sensors' | 'mqtt' | 'jobs' | 'applications' | 'timeline' | 'usage' | 'analytics' | 'security' | 'maintenance' | 'logs' | 'settings' | 'tags' | 'tag-definitions' | 'account' | 'users' | 'profile' | 'dashboard' | 'digital-twin' | 'event-debugger'>('dashboard');
  const [debugMode, setDebugMode] = useState(false);
  
  // Memoize selected device to prevent unnecessary re-renders
  const selectedDevice = useMemo(() => {
    return devices.find((d) => d.id === selectedDeviceId) || devices[0];
  }, [devices, selectedDeviceId]);

  // Persist selectedDeviceId to localStorage whenever it changes
  useEffect(() => {
    if (selectedDeviceId) {
      localStorage.setItem('selectedDeviceId', selectedDeviceId);
    }
  }, [selectedDeviceId]);

  // Fetch devices from API
  useEffect(() => {
    let isFirstLoad = true;
    
    const fetchDevices = async () => {
      try {
        // Only show loading spinner on first load
        if (isFirstLoad) {
          setIsLoadingDevices(true);
          isFirstLoad = false;
        }
        
        const response = await fetch(buildApiUrl('/api/v1/devices'));
        
        if (!response.ok) {
          throw new Error(`Failed to fetch devices: ${response.statusText}`);
        }

        const data = await response.json();
        
        console.log('Devices API response:', data);
        
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
        
        // Select first device if none selected (and update localStorage)
        if (!selectedDeviceId && transformedDevices.length > 0) {
          setSelectedDeviceId(transformedDevices[0].id);
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
  }, []);

  // Fetch device state from context when device changes
  useEffect(() => {
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
  }, [selectedDeviceId, devices, fetchDeviceState]);

  // Get selected device UUID for WebSocket connection
  const currentDevice = useMemo(() => 
    devices.find(d => d.id === selectedDeviceId),
    [devices, selectedDeviceId]
  );

  // Establish WebSocket connection for selected device
  useWebSocketConnection(currentDevice?.deviceUuid || null);

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

  // Subscribe to WebSocket channels
  useWebSocket(currentDevice?.deviceUuid || null, 'network-interfaces', handleNetworkInterfaces);

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
      }
    };

    window.addEventListener('open-device-tags', handleOpenTags);
    return () => window.removeEventListener('open-device-tags', handleOpenTags);
  }, [devices]);

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
        const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceData.id}`), {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            deviceName: deviceData.name,
            deviceType: deviceData.type,
            ipAddress: deviceData.ipAddress,
            macAddress: deviceData.macAddress
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
      // Add new device - register via API
      try {
        toast.loading('Registering device...', { id: 'register-device' });

        const response = await fetch(buildApiUrl('/api/v1/devices'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            deviceName: deviceData.name,
            deviceType: deviceData.type,
            ipAddress: deviceData.ipAddress,
            macAddress: deviceData.macAddress
          })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.message || 'Failed to register device');
        }

        const result = await response.json();
        
        // Add tags if provided
        if (deviceData.tags && Object.keys(deviceData.tags).length > 0) {
          const tagsResponse = await fetch(buildApiUrl(`/api/v1/devices/${result.device.uuid}/tags`), {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              tags: deviceData.tags
            })
          });
          
          if (!tagsResponse.ok) {
            const error = await tagsResponse.json();
            console.error('Failed to add tags:', error);
            // Don't throw - device creation succeeded
          } else {
            // Dispatch event to notify DeviceTagsPage to reload tags
            window.dispatchEvent(new CustomEvent('device-tags-updated', { 
              detail: { deviceUuid: result.device.uuid } 
            }));
          }
        }
        
        toast.success('Device registered successfully! Waiting for agent to connect.', { id: 'register-device' });

        // Add device to local state with offline status
        const newDevice: Device = {
          id: result.device.uuid,
          deviceUuid: result.device.uuid,
          name: result.device.deviceName,
          type: result.device.deviceType,
          ipAddress: result.device.ipAddress || 'N/A',
          macAddress: result.device.macAddress || 'N/A',
          status: 'offline', // Will be offline until agent connects
          lastSeen: 'Never',
          cpu: 0,
          memory: 0,
          disk: 0,
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

  const handleSelectDevice = (deviceId: string) => {
    setSelectedDeviceId(deviceId);
    setSidebarOpen(false); // Close sidebar on mobile after selection
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

           {/* Header */}
      <Header 
        isAuthenticated={isAuthenticated}
        onLogout={handleLogout}
        userEmail={user?.email || ''}
        userName={user?.username || ''}
        deviceUuid={selectedDevice?.deviceUuid}
        onAccountClick={() => setCurrentView('account')}
        onUsersClick={() => setCurrentView('users')}
        onProfileClick={() => setCurrentView('profile')}
        onTagDefinitionsClick={() => setCurrentView('tag-definitions')}
        onDigitalTwinClick={() => setCurrentView('digital-twin')}
        userRole={user?.role || 'viewer'}
      />

      <div className="flex flex-1 overflow-hidden">
                {/* Desktop Sidebar - Hidden on mobile, positioned on right */}
        <div className="hidden lg:block">
          <DeviceSidebar
            devices={devices}
            selectedDeviceId={selectedDeviceId}
            onSelectDevice={handleSelectDevice}
            onAddDevice={handleAddDevice}
            onEditDevice={handleEditDevice}
          />
        </div>
        {/* Main Content Area */}
        <div className="flex-1 flex flex-col overflow-y-auto">
          {isLoadingDevices ? (
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
          {/* Mobile Header with Menu Button - Sticky at top */}
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

          {/* View Toggle Buttons */}
          <div className="bg-card border-b border-border px-6 py-3 flex gap-2 overflow-x-auto">
            <Button
              variant={currentView === 'dashboard' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('dashboard')}
            >
              <BarChart3 className="w-4 h-4 mr-2" />
              Dashboard
            </Button>
            <Button
              variant={currentView === 'metrics' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('metrics')}
            >
              <BarChart3 className="w-4 h-4 mr-2" />
              System Metrics
            </Button>
            <Button
              variant={currentView === 'sensors' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('sensors')}
            >
              <Activity className="w-4 h-4 mr-2" />
              Endpoints
            </Button>
            <Button
              variant={currentView === 'mqtt' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('mqtt')}
            >
              <Radio className="w-4 h-4 mr-2" />
              MQTT
            </Button>
            <Button
              variant={currentView === 'jobs' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('jobs')}
            >
              <CalendarClock className="w-4 h-4 mr-2" />
              Jobs
            </Button>
            <Button
              variant={currentView === 'applications' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('applications')}
            >
              <Package className="w-4 h-4 mr-2" />
              Applications
            </Button>
            <Button
              variant={currentView === 'timeline' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('timeline')}
            >
              <Clock className="w-4 h-4 mr-2" />
              Timeline
            </Button>
            <Button
              variant={currentView === 'event-debugger' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('event-debugger')}
            >
              <Activity className="w-4 h-4 mr-2" />
              Event Debugger
            </Button>
            <Button
              variant={currentView === 'usage' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('usage')}
            >
              <TrendingUp className="w-4 h-4 mr-2" />
              API Usage
            </Button>
            <Button
              variant={currentView === 'analytics' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('analytics')}
            >
              <LineChart className="w-4 h-4 mr-2" />
              Traffic Monitor
            </Button>
            <Button
              variant={currentView === 'security' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('security')}
            >
              <Shield className="w-4 h-4 mr-2" />
              Security
            </Button>
            <Button
              variant={currentView === 'maintenance' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('maintenance')}
            >
              <Settings className="w-4 h-4 mr-2" />
              Housekeeping
            </Button>
            <Button
              variant={currentView === 'logs' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('logs')}
            >
              <FileText className="w-4 h-4 mr-2" />
              Logs
            </Button>
            <Button
              variant={currentView === 'settings' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('settings')}
            >
              <Shield className="w-4 h-4 mr-2" />
              Settings
            </Button>
            <Button
              variant={currentView === 'tags' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentView('tags')}
            >
              <Tag className="w-4 h-4 mr-2" />
              Tags
            </Button>
          </div>

          {/* Conditional Content */}
          {currentView === 'dashboard' && (
            <GlobalDashboardPage 
              devices={devices} 
              onDeviceSelect={(device) => {
                setSelectedDeviceId(device.id);
              }} 
            />
          )}
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
                  debugMode={debugMode}
                  onDebugModeChange={setDebugMode}
                />
          )}
          {currentView === 'mqtt' && (
            <MqttPage device={selectedDevice} />
          )}
          {currentView === 'jobs' && (
            <JobsPage device={selectedDevice} />
          )}
          {currentView === 'timeline' && (
            <TimelinePage device={selectedDevice} />
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
          {currentView === 'security' && (
            <div className="flex-1 bg-background overflow-auto p-6">
              <SecurityPage />
            </div>
          )}
          {currentView === 'maintenance' && (
            <HousekeeperPage />
          )}
          {currentView === 'logs' && (
            <div className="flex-1 bg-background overflow-auto p-6">
              <LogsPage deviceUuid={selectedDevice.deviceUuid} />
            </div>
          )}
          {currentView === 'settings' && (
            <DeviceSettingsPage deviceUuid={selectedDevice.deviceUuid} />
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
