import { useState, useEffect } from 'react';
import { Responsive, WidthProvider, Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { 
  Plus, 
  Save, 
  Trash2, 
  Lock, 
  Unlock,
  RotateCcw,
  Monitor,
  Activity,
  BarChart3,
  AlertTriangle,
  Clock,
  GripVertical,
  LayoutDashboard,
  Check,
  Star,
  Edit2,
  ChevronDown
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Device } from '../components/DeviceSidebar';
import { MetricDataCard, type MetricDataCardConfig } from '../components/MetricDataCard';
import { MetricDataCardConfigDialog } from '../components/MetricDataCardConfigDialog';

const ResponsiveGridLayout = WidthProvider(Responsive);

// Widget types for global dashboard
const WIDGET_TYPES = {
  DEVICE_CARD: {
    id: 'device',
    name: 'Device Card',
    icon: Monitor,
    minW: 3,
    minH: 2,
    defaultW: 4,
    defaultH: 3
  },
  FLEET_OVERVIEW: {
    id: 'fleet',
    name: 'Fleet Overview',
    icon: BarChart3,
    minW: 4,
    minH: 3,
    defaultW: 6,
    defaultH: 4
  },
  SYSTEM_HEALTH: {
    id: 'health',
    name: 'System Health',
    icon: Activity,
    minW: 3,
    minH: 2,
    defaultW: 4,
    defaultH: 3
  },
  ALERT_SUMMARY: {
    id: 'alerts',
    name: 'Alert Summary',
    icon: AlertTriangle,
    minW: 3,
    minH: 2,
    defaultW: 4,
    defaultH: 3
  },
  RECENT_EVENTS: {
    id: 'events',
    name: 'Recent Events',
    icon: Clock,
    minW: 4,
    minH: 3,
    defaultW: 6,
    defaultH: 4
  },
  METRIC_DATA: {
    id: 'metric-data',
    name: 'Metric Data Card',
    icon: BarChart3,
    minW: 3,
    minH: 3,
    defaultW: 4,
    defaultH: 4
  }
};

interface DashboardWidget extends Layout {
  type: keyof typeof WIDGET_TYPES;
  title: string;
  deviceId?: string; // For device-specific widgets
  metricConfig?: MetricDataCardConfig; // For metric data widgets
}

interface DashboardLayout {
  id: number;
  layoutName: string;
  widgetCount: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface GlobalDashboardPageProps {
  devices: Device[];
  onDeviceSelect: (device: Device) => void;
}

export function GlobalDashboardPage({ devices, onDeviceSelect }: GlobalDashboardPageProps) {
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [isEditMode, setIsEditMode] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedDeviceForWidget, setSelectedDeviceForWidget] = useState<string>('');
  const [availableLayouts, setAvailableLayouts] = useState<DashboardLayout[]>([]);
  const [currentLayoutId, setCurrentLayoutId] = useState<number | null>(null);
  const [currentLayoutName, setCurrentLayoutName] = useState<string>('Default');
  const [showNewDashboardDialog, setShowNewDashboardDialog] = useState(false);
  const [showRenameDashboardDialog, setShowRenameDashboardDialog] = useState(false);
  const [newDashboardName, setNewDashboardName] = useState('');
  const [showMetricConfigDialog, setShowMetricConfigDialog] = useState(false);
  const [configuringWidgetId, setConfiguringWidgetId] = useState<string | null>(null);

  useEffect(() => {
    loadAvailableLayouts();
    loadLayout();
  }, []);

  const loadAvailableLayouts = async () => {
    try {
      const response = await fetch(`http://localhost:4002/api/v1/dashboard-layouts/global/all`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
        }
      });

      if (response.ok) {
        const layouts = await response.json();
        setAvailableLayouts(layouts);
      }
    } catch (error) {
      console.error('Error loading available layouts:', error);
    }
  };

  const loadLayout = async (layoutId?: number) => {
    try {
      setIsLoading(true);
      
      if (layoutId) {
        // Load specific layout by ID
        const response = await fetch(`http://localhost:4002/api/v1/dashboard-layouts/by-id/${layoutId}`, {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
          }
        });

        if (response.ok) {
          const data = await response.json();
          setWidgets(data.widgets || []);
          setCurrentLayoutId(layoutId);
          setCurrentLayoutName(data.layoutName || 'Default');
          setHasUnsavedChanges(false);
          return;
        }
      }

      // Load default layout
      const response = await fetch(`http://localhost:4002/api/v1/dashboard-layouts/global`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.widgets && Array.isArray(data.widgets) && data.widgets.length > 0) {
          setWidgets(data.widgets);
          setCurrentLayoutId(data.id || null);
          setCurrentLayoutName(data.layoutName || 'Default');
        } else {
          loadDefaultLayout();
        }
      } else {
        loadDefaultLayout();
      }
    } catch (error) {
      console.error('Error loading global layout:', error);
      loadDefaultLayout();
    } finally {
      setIsLoading(false);
    }
  };

  const loadDefaultLayout = () => {
    const defaultWidgets: DashboardWidget[] = [
      { i: '1', x: 0, y: 0, w: 6, h: 4, type: 'FLEET_OVERVIEW', title: 'Fleet Overview' },
      { i: '2', x: 6, y: 0, w: 6, h: 4, type: 'SYSTEM_HEALTH', title: 'System Health' },
    ];

    // Add device cards for first 4 devices
    devices.slice(0, 4).forEach((device, index) => {
      defaultWidgets.push({
        i: `device-${index + 1}`,
        x: (index % 3) * 4,
        y: 4,
        w: 4,
        h: 3,
        type: 'DEVICE_CARD',
        title: device.name,
        deviceId: device.deviceUuid
      });
    });

    setWidgets(defaultWidgets);
  };

  const saveLayoutToServer = async (widgetsToSave: DashboardWidget[], showFeedback = true) => {
    try {
      const response = await fetch(`http://localhost:4002/api/v1/dashboard-layouts/global`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
        },
        body: JSON.stringify({
          widgets: widgetsToSave,
          layoutName: currentLayoutName,
          isDefault: availableLayouts.length === 0 // First layout is default
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        console.error('Server error:', response.status, errorData);
        throw new Error(`Failed to save layout: ${response.status} - ${errorData.error || errorData.message || 'Unknown error'}`);
      }

      const data = await response.json();
      if (data.id) {
        setCurrentLayoutId(data.id);
      }

      if (showFeedback) {
        console.log('Global layout saved to server successfully');
      }
      
      // Reload available layouts
      await loadAvailableLayouts();
      
      return true;
    } catch (error) {
      console.error('Error saving global layout to server:', error);
      if (showFeedback) {
        alert('Failed to save layout to server.');
      }
      return false;
    }
  };

  const saveLayout = async () => {
    setIsSaving(true);
    try {
      await saveLayoutToServer(widgets);
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error('Error saving layout:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const createNewDashboard = async () => {
    if (!newDashboardName.trim()) {
      alert('Please enter a dashboard name');
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch(`http://localhost:4002/api/v1/dashboard-layouts/global`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
        },
        body: JSON.stringify({
          widgets: [],
          layoutName: newDashboardName,
          isDefault: false
        })
      });

      if (response.ok) {
        const data = await response.json();
        setCurrentLayoutId(data.id);
        setCurrentLayoutName(newDashboardName);
        setWidgets([]);
        setHasUnsavedChanges(false);
        setShowNewDashboardDialog(false);
        setNewDashboardName('');
        await loadAvailableLayouts();
      } else {
        alert('Failed to create new dashboard');
      }
    } catch (error) {
      console.error('Error creating new dashboard:', error);
      alert('Failed to create new dashboard');
    } finally {
      setIsSaving(false);
    }
  };

  const renameDashboard = async () => {
    if (!newDashboardName.trim() || !currentLayoutId) {
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch(`http://localhost:4002/api/v1/dashboard-layouts/${currentLayoutId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
        },
        body: JSON.stringify({
          layoutName: newDashboardName
        })
      });

      if (response.ok) {
        setCurrentLayoutName(newDashboardName);
        setShowRenameDashboardDialog(false);
        setNewDashboardName('');
        await loadAvailableLayouts();
      } else {
        alert('Failed to rename dashboard');
      }
    } catch (error) {
      console.error('Error renaming dashboard:', error);
      alert('Failed to rename dashboard');
    } finally {
      setIsSaving(false);
    }
  };

  const deleteDashboard = async (layoutId: number) => {
    if (!confirm('Are you sure you want to delete this dashboard?')) {
      return;
    }

    try {
      const response = await fetch(`http://localhost:4002/api/v1/dashboard-layouts/${layoutId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
        }
      });

      if (response.ok) {
        await loadAvailableLayouts();
        // If we deleted the current layout, load the default
        if (layoutId === currentLayoutId) {
          await loadLayout();
        }
      } else {
        alert('Failed to delete dashboard');
      }
    } catch (error) {
      console.error('Error deleting dashboard:', error);
      alert('Failed to delete dashboard');
    }
  };

  const switchDashboard = async (layoutId: number) => {
    if (hasUnsavedChanges) {
      if (!confirm('You have unsaved changes. Do you want to switch without saving?')) {
        return;
      }
    }
    await loadLayout(layoutId);
  };

  const resetLayout = () => {
    if (confirm('Are you sure you want to reset the dashboard to default layout?')) {
      loadDefaultLayout();
      setHasUnsavedChanges(true);
    }
  };

  const handleLayoutChange = (layout: Layout[]) => {
    const updatedWidgets = widgets.map(widget => {
      const layoutItem = layout.find(l => l.i === widget.i);
      if (layoutItem) {
        return { ...widget, ...layoutItem };
      }
      return widget;
    });
    setWidgets(updatedWidgets);
    setHasUnsavedChanges(true);
  };

  const addDeviceWidget = (deviceId: string) => {
    const device = devices.find(d => d.deviceUuid === deviceId);
    if (!device) return;

    const newId = `device-${Date.now()}`;
    const newWidget: DashboardWidget = {
      i: newId,
      x: 0,
      y: Infinity,
      w: WIDGET_TYPES.DEVICE_CARD.defaultW,
      h: WIDGET_TYPES.DEVICE_CARD.defaultH,
      minW: WIDGET_TYPES.DEVICE_CARD.minW,
      minH: WIDGET_TYPES.DEVICE_CARD.minH,
      type: 'DEVICE_CARD',
      title: device.name,
      deviceId: device.deviceUuid
    };
    setWidgets([...widgets, newWidget]);
    setHasUnsavedChanges(true);
    setSelectedDeviceForWidget('');
  };

  const addWidget = (type: keyof typeof WIDGET_TYPES) => {
    if (type === 'DEVICE_CARD') {
      // Will be handled by device dropdown
      return;
    }

    if (type === 'METRIC_DATA') {
      // Open config dialog for metric data widgets
      setConfiguringWidgetId(`metric-${Date.now()}`);
      setShowMetricConfigDialog(true);
      return;
    }

    const widgetConfig = WIDGET_TYPES[type];
    const newId = `${Date.now()}`;
    const newWidget: DashboardWidget = {
      i: newId,
      x: 0,
      y: Infinity,
      w: widgetConfig.defaultW,
      h: widgetConfig.defaultH,
      minW: widgetConfig.minW,
      minH: widgetConfig.minH,
      type,
      title: widgetConfig.name
    };
    setWidgets([...widgets, newWidget]);
    setHasUnsavedChanges(true);
  };

  const removeWidget = (id: string) => {
    setWidgets(widgets.filter(w => w.i !== id));
    setHasUnsavedChanges(true);
  };

  const handleSaveMetricConfig = (config: MetricDataCardConfig) => {
    if (!configuringWidgetId) return;

    const existingWidget = widgets.find(w => w.i === configuringWidgetId);
    
    if (existingWidget) {
      // Update existing widget
      const updatedWidgets = widgets.map(w =>
        w.i === configuringWidgetId
          ? { ...w, metricConfig: config, title: config.title || `${config.metricName} - ${config.deviceName}` }
          : w
      );
      setWidgets(updatedWidgets);
    } else {
      // Create new widget
      const widgetConfig = WIDGET_TYPES.METRIC_DATA;
      const newWidget: DashboardWidget = {
        i: configuringWidgetId,
        x: 0,
        y: Infinity,
        w: widgetConfig.defaultW,
        h: widgetConfig.defaultH,
        minW: widgetConfig.minW,
        minH: widgetConfig.minH,
        type: 'METRIC_DATA',
        title: config.title || `${config.metricName} - ${config.deviceName}`,
        metricConfig: config
      };
      setWidgets([...widgets, newWidget]);
    }

    setHasUnsavedChanges(true);
    setConfiguringWidgetId(null);
  };

  const renderWidget = (widget: DashboardWidget) => {
    const WidgetIcon = WIDGET_TYPES[widget.type].icon;
    
    return (
      <div key={widget.i} className="h-full">
        <Card className="h-full overflow-hidden">
          <CardHeader className="pb-2 cursor-move card-header">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {isEditMode && (
                  <GripVertical className="w-5 h-5 text-muted-foreground hover:text-foreground transition-colors" />
                )}
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <WidgetIcon className="w-4 h-4" />
                  {widget.title}
                </CardTitle>
              </div>
              {isEditMode && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => removeWidget(widget.i)}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {renderWidgetContent(widget)}
          </CardContent>
        </Card>
      </div>
    );
  };

  const renderWidgetContent = (widget: DashboardWidget) => {
    switch (widget.type) {
      case 'DEVICE_CARD':
        const device = devices.find(d => d.deviceUuid === widget.deviceId);
        if (!device) {
          return <div className="text-muted-foreground text-center">Device not found</div>;
        }
        return (
          <div className="flex flex-col gap-3 h-full">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Status</span>
              <Badge
                variant="outline"
                className={
                  device.status === "online"
                    ? "bg-green-100 text-green-700 border-green-200"
                    : "bg-gray-100 text-gray-700 border-gray-200"
                }
              >
                {device.status}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <div className="text-muted-foreground">CPU</div>
                <div className="font-semibold">{device.cpu}%</div>
              </div>
              <div>
                <div className="text-muted-foreground">Memory</div>
                <div className="font-semibold">{device.memory}%</div>
              </div>
              <div>
                <div className="text-muted-foreground">Disk</div>
                <div className="font-semibold">{device.disk}%</div>
              </div>
              <div>
                <div className="text-muted-foreground">IP</div>
                <div className="font-mono text-xs">{device.ipAddress}</div>
              </div>
            </div>
            <Button 
              variant="outline" 
              size="sm" 
              className="mt-auto"
              onClick={() => onDeviceSelect(device)}
            >
              View Details
            </Button>
          </div>
        );

      case 'FLEET_OVERVIEW':
        const onlineCount = devices.filter(d => d.status === 'online').length;
        const totalDevices = devices.length;
        return (
          <div className="flex flex-col gap-4 h-full">
            <div className="grid grid-cols-3 gap-4">
              <div className="text-center">
                <div className="text-3xl font-bold">{totalDevices}</div>
                <div className="text-sm text-muted-foreground">Total Devices</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-green-600">{onlineCount}</div>
                <div className="text-sm text-muted-foreground">Online</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-gray-600">{totalDevices - onlineCount}</div>
                <div className="text-sm text-muted-foreground">Offline</div>
              </div>
            </div>
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              {Math.round((onlineCount / totalDevices) * 100)}% uptime
            </div>
          </div>
        );

      case 'SYSTEM_HEALTH':
        const avgCpu = Math.round(devices.reduce((sum, d) => sum + d.cpu, 0) / devices.length);
        const avgMemory = Math.round(devices.reduce((sum, d) => sum + d.memory, 0) / devices.length);
        const avgDisk = Math.round(devices.reduce((sum, d) => sum + d.disk, 0) / devices.length);
        return (
          <div className="flex flex-col gap-3 h-full justify-center">
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span>Avg CPU</span>
                <span className="font-semibold">{avgCpu}%</span>
              </div>
              <div className="w-full bg-secondary rounded-full h-2">
                <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${avgCpu}%` }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span>Avg Memory</span>
                <span className="font-semibold">{avgMemory}%</span>
              </div>
              <div className="w-full bg-secondary rounded-full h-2">
                <div className="bg-green-500 h-2 rounded-full" style={{ width: `${avgMemory}%` }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span>Avg Disk</span>
                <span className="font-semibold">{avgDisk}%</span>
              </div>
              <div className="w-full bg-secondary rounded-full h-2">
                <div className="bg-orange-500 h-2 rounded-full" style={{ width: `${avgDisk}%` }} />
              </div>
            </div>
          </div>
        );

      case 'ALERT_SUMMARY':
      case 'RECENT_EVENTS':
        return (
          <div className="text-center text-muted-foreground h-full flex items-center justify-center">
            Coming soon...
          </div>
        );

      case 'METRIC_DATA':
        if (!widget.metricConfig) {
          return (
            <div className="text-center text-muted-foreground h-full flex items-center justify-center">
              <div>
                <div className="mb-2">No metric configured</div>
                <Button 
                  size="sm" 
                  variant="outline"
                  onClick={() => {
                    setConfiguringWidgetId(widget.i);
                    setShowMetricConfigDialog(true);
                  }}
                >
                  Configure Metric
                </Button>
              </div>
            </div>
          );
        }
        return (
          <MetricDataCard 
            config={widget.metricConfig}
            onConfigure={() => {
              setConfiguringWidgetId(widget.i);
              setShowMetricConfigDialog(true);
            }}
          />
        );

      default:
        return <div>Unknown widget type</div>;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="bg-card border-b border-border p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Dashboard Selector */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="flex items-center gap-2 hover:bg-accent">
                <LayoutDashboard className="w-4 h-4" />
                <span className="text-lg font-semibold">{currentLayoutName}</span>
                <ChevronDown className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <div className="p-2 text-xs font-semibold text-muted-foreground">YOUR DASHBOARDS</div>
              {availableLayouts.map((layout) => (
                <DropdownMenuItem 
                  key={layout.id}
                  onClick={() => switchDashboard(layout.id)}
                  className="flex items-center justify-between group"
                >
                  <div className="flex items-center gap-2 flex-1">
                    {layout.id === currentLayoutId && <Check className="w-4 h-4 text-primary" />}
                    {layout.id !== currentLayoutId && <div className="w-4" />}
                    <span className={layout.id === currentLayoutId ? "font-medium" : ""}>
                      {layout.layoutName}
                    </span>
                    {layout.isDefault && <Star className="w-3 h-3 text-yellow-500 fill-yellow-500" />}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCurrentLayoutId(layout.id);
                        setCurrentLayoutName(layout.layoutName);
                        setNewDashboardName(layout.layoutName);
                        setShowRenameDashboardDialog(true);
                      }}
                    >
                      <Edit2 className="w-3 h-3" />
                    </Button>
                    {!layout.isDefault && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteDashboard(layout.id);
                        }}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem 
                onClick={() => setShowNewDashboardDialog(true)}
                className="border-t mt-1 pt-2"
              >
                <Plus className="w-4 h-4 mr-2" />
                Create New Dashboard
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          
          {hasUnsavedChanges && (
            <Badge variant="outline" className="bg-yellow-100 text-yellow-700 border-yellow-200">
              Unsaved Changes
            </Badge>
          )}
        </div>
        
        <div className="flex items-center gap-2">
          {hasUnsavedChanges && (
            <Button onClick={saveLayout} size="sm" variant="default" disabled={isSaving}>
              <Save className="w-4 h-4 mr-2" />
              {isSaving ? 'Saving...' : 'Save Layout'}
            </Button>
          )}
          
          <Button onClick={resetLayout} size="sm" variant="outline" disabled={isSaving}>
            <RotateCcw className="w-4 h-4 mr-2" />
            Reset
          </Button>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <Plus className="w-4 h-4 mr-2" />
                Add Widget
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => addWidget('FLEET_OVERVIEW')}>
                <BarChart3 className="w-4 h-4 mr-2" />
                Fleet Overview
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addWidget('SYSTEM_HEALTH')}>
                <Activity className="w-4 h-4 mr-2" />
                System Health
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addWidget('ALERT_SUMMARY')}>
                <AlertTriangle className="w-4 h-4 mr-2" />
                Alert Summary
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addWidget('RECENT_EVENTS')}>
                <Clock className="w-4 h-4 mr-2" />
                Recent Events
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addWidget('METRIC_DATA')}>
                <BarChart3 className="w-4 h-4 mr-2" />
                Metric Data Card
              </DropdownMenuItem>
              <DropdownMenuItem 
                onSelect={(e) => e.preventDefault()}
                className="focus:bg-transparent"
              >
                <div className="flex items-center w-full" onClick={(e) => e.stopPropagation()}>
                  <Monitor className="w-4 h-4 mr-2" />
                  <select 
                    className="flex-1 text-sm bg-transparent border border-input rounded px-2 py-1 cursor-pointer hover:bg-accent"
                    value={selectedDeviceForWidget}
                    onChange={(e) => {
                      e.stopPropagation();
                      if (e.target.value) {
                        addDeviceWidget(e.target.value);
                        setSelectedDeviceForWidget('');
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <option value="">Add Device Card...</option>
                    {devices.map(device => (
                      <option key={device.deviceUuid} value={device.deviceUuid}>
                        {device.name}
                      </option>
                    ))}
                  </select>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          
          <Button
            onClick={() => setIsEditMode(!isEditMode)}
            size="sm"
            variant={isEditMode ? "default" : "outline"}
          >
            {isEditMode ? <Lock className="w-4 h-4 mr-2" /> : <Unlock className="w-4 h-4 mr-2" />}
            {isEditMode ? "Lock Layout" : "Edit Layout"}
          </Button>
        </div>
      </div>

      {/* Grid Layout */}
      <div className="flex-1 overflow-auto p-4">
        <ResponsiveGridLayout
          className="layout"
          layouts={{ lg: widgets }}
          breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
          cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
          rowHeight={80}
          isDraggable={isEditMode}
          isResizable={isEditMode}
          onLayoutChange={handleLayoutChange}
          draggableHandle=".card-header"
        >
          {widgets.map(widget => renderWidget(widget))}
        </ResponsiveGridLayout>
      </div>

      {/* Create Dashboard Dialog */}
      <Dialog open={showNewDashboardDialog} onOpenChange={setShowNewDashboardDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Dashboard</DialogTitle>
            <DialogDescription>
              Enter a name for your new dashboard. You can add widgets after creation.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="dashboard-name" className="text-sm font-medium">
              Dashboard Name
            </Label>
            <Input
              id="dashboard-name"
              placeholder="e.g., Production Monitoring"
              value={newDashboardName}
              onChange={(e) => setNewDashboardName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  createNewDashboard();
                }
              }}
              className="mt-2"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowNewDashboardDialog(false);
                setNewDashboardName('');
              }}
            >
              Cancel
            </Button>
            <Button onClick={createNewDashboard} disabled={!newDashboardName.trim() || isSaving}>
              {isSaving ? 'Creating...' : 'Create Dashboard'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dashboard Dialog */}
      <Dialog open={showRenameDashboardDialog} onOpenChange={setShowRenameDashboardDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Dashboard</DialogTitle>
            <DialogDescription>
              Enter a new name for "{currentLayoutName}"
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="rename-dashboard" className="text-sm font-medium">
              Dashboard Name
            </Label>
            <Input
              id="rename-dashboard"
              placeholder="Dashboard name"
              value={newDashboardName}
              onChange={(e) => setNewDashboardName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  renameDashboard();
                }
              }}
              className="mt-2"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowRenameDashboardDialog(false);
                setNewDashboardName('');
              }}
            >
              Cancel
            </Button>
            <Button onClick={renameDashboard} disabled={!newDashboardName.trim() || isSaving}>
              {isSaving ? 'Renaming...' : 'Rename Dashboard'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Metric Data Card Configuration Dialog */}
      <MetricDataCardConfigDialog
        open={showMetricConfigDialog}
        onOpenChange={setShowMetricConfigDialog}
        onSave={handleSaveMetricConfig}
        initialConfig={configuringWidgetId ? widgets.find(w => w.i === configuringWidgetId)?.metricConfig : undefined}
      />
    </div>
  );
}
