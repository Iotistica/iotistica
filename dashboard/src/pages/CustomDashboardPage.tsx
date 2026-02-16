import { useState, useEffect } from 'react';
import { Responsive, WidthProvider, Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { buildApiUrl } from '../config/api';
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
  Trash2, 
  Lock, 
  Unlock,
  Save,
  RotateCcw,
  BarChart3,
  Activity,
  Cpu,
  HardDrive,
  Network,
  Zap,
  Clock,
  AlertTriangle,
  GripVertical
} from 'lucide-react';
import { useDeviceState } from '../contexts/DeviceStateContext';
import { Device } from '../components/DeviceSidebar';

const ResponsiveGridLayout = WidthProvider(Responsive);

// Available widget types
const WIDGET_TYPES = {
  CPU_USAGE: { 
    id: 'cpu', 
    name: 'CPU Usage', 
    icon: Cpu,
    minW: 2, 
    minH: 2,
    defaultW: 3,
    defaultH: 2
  },
  MEMORY_USAGE: { 
    id: 'memory', 
    name: 'Memory Usage', 
    icon: HardDrive,
    minW: 2, 
    minH: 2,
    defaultW: 3,
    defaultH: 2
  },
  DISK_USAGE: { 
    id: 'disk', 
    name: 'Disk Usage', 
    icon: HardDrive,
    minW: 2, 
    minH: 2,
    defaultW: 3,
    defaultH: 2
  },
  NETWORK_STATS: { 
    id: 'network', 
    name: 'Network Stats', 
    icon: Network,
    minW: 4, 
    minH: 3,
    defaultW: 6,
    defaultH: 3
  },
  DEVICE_STATUS: { 
    id: 'status', 
    name: 'Device Status', 
    icon: Activity,
    minW: 3, 
    minH: 2,
    defaultW: 4,
    defaultH: 2
  },
  APPLICATIONS: { 
    id: 'apps', 
    name: 'Applications', 
    icon: Zap,
    minW: 4, 
    minH: 4,
    defaultW: 6,
    defaultH: 4
  },
  RECENT_ACTIVITY: { 
    id: 'activity', 
    name: 'Recent Activity', 
    icon: Clock,
    minW: 4, 
    minH: 3,
    defaultW: 6,
    defaultH: 3
  },
  ALERTS: { 
    id: 'alerts', 
    name: 'Alerts', 
    icon: AlertTriangle,
    minW: 3, 
    minH: 2,
    defaultW: 4,
    defaultH: 3
  },
  METRICS_CHART: { 
    id: 'metrics', 
    name: 'Metrics Chart', 
    icon: BarChart3,
    minW: 4, 
    minH: 3,
    defaultW: 6,
    defaultH: 4
  }
} as const;

interface DashboardWidget extends Layout {
  type: keyof typeof WIDGET_TYPES;
  title: string;
}

interface CustomDashboardPageProps {
  device: Device;
}

export function CustomDashboardPage({ device }: CustomDashboardPageProps) {
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [isEditMode, setIsEditMode] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const { getDeviceState } = useDeviceState();
  
  const deviceState = getDeviceState(device.deviceUuid);

  // Load saved layout from API (with localStorage fallback)
  useEffect(() => {
    loadLayout();
  }, [device.deviceUuid]);

  const loadLayout = async () => {
    try {
      setIsLoading(true);
      // Try loading from API first
      const response = await fetch(buildApiUrl(`/api/v1/dashboard-layouts/${device.deviceUuid}`), {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.widgets && Array.isArray(data.widgets) && data.widgets.length > 0) {
          setWidgets(data.widgets);
        } else {
          // No saved layout on server, try localStorage
          const localLayout = localStorage.getItem(`dashboard-layout-${device.id}`);
          if (localLayout) {
            try {
              const parsed = JSON.parse(localLayout);
              setWidgets(parsed);
              // Migrate to server
              await saveLayoutToServer(parsed, false);
            } catch (error) {
              console.error('Failed to parse local layout:', error);
              loadDefaultLayout();
            }
          } else {
            loadDefaultLayout();
          }
        }
      } else {
        // API failed, fallback to localStorage
        console.warn('Failed to load layout from API, using localStorage');
        const localLayout = localStorage.getItem(`dashboard-layout-${device.id}`);
        if (localLayout) {
          try {
            setWidgets(JSON.parse(localLayout));
          } catch (error) {
            console.error('Failed to load saved layout:', error);
            loadDefaultLayout();
          }
        } else {
          loadDefaultLayout();
        }
      }
    } catch (error) {
      console.error('Error loading layout:', error);
      // Fallback to localStorage
      const localLayout = localStorage.getItem(`dashboard-layout-${device.id}`);
      if (localLayout) {
        try {
          setWidgets(JSON.parse(localLayout));
        } catch {
          loadDefaultLayout();
        }
      } else {
        loadDefaultLayout();
      }
    } finally {
      setIsLoading(false);
    }
  };

  const loadDefaultLayout = () => {
    const defaultWidgets: DashboardWidget[] = [
      { i: '1', x: 0, y: 0, w: 3, h: 2, type: 'CPU_USAGE', title: 'CPU Usage' },
      { i: '2', x: 3, y: 0, w: 3, h: 2, type: 'MEMORY_USAGE', title: 'Memory Usage' },
      { i: '3', x: 6, y: 0, w: 3, h: 2, type: 'DISK_USAGE', title: 'Disk Usage' },
      { i: '4', x: 9, y: 0, w: 3, h: 2, type: 'DEVICE_STATUS', title: 'Device Status' },
      { i: '5', x: 0, y: 2, w: 6, h: 4, type: 'METRICS_CHART', title: 'System Metrics' },
      { i: '6', x: 6, y: 2, w: 6, h: 4, type: 'APPLICATIONS', title: 'Applications' },
    ];
    setWidgets(defaultWidgets);
  };

  const saveLayoutToServer = async (widgetsToSave: DashboardWidget[], showFeedback = true) => {
    try {
      const response = await fetch(buildApiUrl(`/api/v1/dashboard-layouts/${device.deviceUuid}`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
        },
        body: JSON.stringify({
          widgets: widgetsToSave,
          layoutName: 'Default',
          isDefault: true
        })
      });

      if (!response.ok) {
        throw new Error('Failed to save layout to server');
      }

      if (showFeedback) {
        console.log('Layout saved to server successfully');
      }
      return true;
    } catch (error) {
      console.error('Error saving layout to server:', error);
      if (showFeedback) {
        alert('Failed to save layout to server. It has been saved locally.');
      }
      return false;
    }
  };

  const saveLayout = async () => {
    setIsSaving(true);
    try {
      // Save to localStorage (always works)
      localStorage.setItem(`dashboard-layout-${device.id}`, JSON.stringify(widgets));
      
      // Try to save to server
      await saveLayoutToServer(widgets);
      
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error('Error saving layout:', error);
    } finally {
      setIsSaving(false);
    }
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

  const addWidget = (type: keyof typeof WIDGET_TYPES) => {
    const widgetConfig = WIDGET_TYPES[type];
    const newId = `${Date.now()}`;
    const newWidget: DashboardWidget = {
      i: newId,
      x: 0,
      y: Infinity, // Puts it at the bottom
      w: widgetConfig.defaultW,
      h: widgetConfig.defaultH,
      minW: widgetConfig.minW,
      minH: widgetConfig.minH,
      type,
      title: widgetConfig.name
    };
    setWidgets([...widgets, newWidget]);
    setHasUnsavedChanges(true);
    // Automatically switch to edit mode after adding a widget
    setIsEditMode(true);
  };

  const removeWidget = (id: string) => {
    setWidgets(widgets.filter(w => w.i !== id));
    setHasUnsavedChanges(true);
  };

  const renderWidget = (widget: DashboardWidget) => {
    const WidgetIcon = WIDGET_TYPES[widget.type].icon;
    
    return (
      <Card key={widget.i} className="h-full overflow-hidden">
        <CardHeader className="pb-2 card-header cursor-move">
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
    );
  };

  const renderWidgetContent = (widget: DashboardWidget) => {
    switch (widget.type) {
      case 'CPU_USAGE':
        return (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="text-4xl font-bold">{device.cpu}%</div>
            <div className="text-sm text-muted-foreground mt-2">CPU Load</div>
            <div className="w-full bg-secondary rounded-full h-2 mt-4">
              <div 
                className="bg-blue-500 h-2 rounded-full transition-all" 
                style={{ width: `${device.cpu}%` }}
              />
            </div>
          </div>
        );
      
      case 'MEMORY_USAGE':
        return (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="text-4xl font-bold">{device.memory}%</div>
            <div className="text-sm text-muted-foreground mt-2">Memory Used</div>
            <div className="w-full bg-secondary rounded-full h-2 mt-4">
              <div 
                className="bg-green-500 h-2 rounded-full transition-all" 
                style={{ width: `${device.memory}%` }}
              />
            </div>
          </div>
        );
      
      case 'DISK_USAGE':
        return (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="text-4xl font-bold">{device.disk}%</div>
            <div className="text-sm text-muted-foreground mt-2">Disk Used</div>
            <div className="w-full bg-secondary rounded-full h-2 mt-4">
              <div 
                className="bg-orange-500 h-2 rounded-full transition-all" 
                style={{ width: `${device.disk}%` }}
              />
            </div>
          </div>
        );
      
      case 'DEVICE_STATUS':
        return (
          <div className="flex flex-col gap-3 h-full justify-center">
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
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">IP Address</span>
              <span className="text-sm font-mono">{device.ipAddress}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Last Seen</span>
              <span className="text-sm">{device.lastSeen}</span>
            </div>
          </div>
        );
      
      case 'NETWORK_STATS':
        return (
          <div className="text-center text-muted-foreground h-full flex items-center justify-center">
            Network statistics coming soon...
          </div>
        );
      
      case 'APPLICATIONS':
        const apps = deviceState?.currentState?.apps ? Object.values(deviceState.currentState.apps) : [];
        return (
          <div className="h-full overflow-auto">
            {apps.length > 0 ? (
              <div className="space-y-2">
                {apps.slice(0, 5).map((app: any) => (
                  <div key={app.appId} className="flex items-center justify-between p-2 bg-secondary rounded">
                    <span className="text-sm font-medium">{app.appName}</span>
                    <Badge variant="outline" className="text-xs">
                      {app.services?.length || 0} services
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center text-muted-foreground h-full flex items-center justify-center">
                No applications running
              </div>
            )}
          </div>
        );
      
      case 'RECENT_ACTIVITY':
        return (
          <div className="text-center text-muted-foreground h-full flex items-center justify-center">
            Recent activity feed coming soon...
          </div>
        );
      
      case 'ALERTS':
        return (
          <div className="text-center text-muted-foreground h-full flex items-center justify-center">
            No active alerts
          </div>
        );
      
      case 'METRICS_CHART':
        return (
          <div className="h-full flex flex-col gap-4">
            <div className="flex gap-4">
              <div className="flex-1 p-3 bg-blue-50 dark:bg-blue-950 rounded">
                <div className="text-xs text-muted-foreground">CPU</div>
                <div className="text-2xl font-bold">{device.cpu}%</div>
              </div>
              <div className="flex-1 p-3 bg-green-50 dark:bg-green-950 rounded">
                <div className="text-xs text-muted-foreground">Memory</div>
                <div className="text-2xl font-bold">{device.memory}%</div>
              </div>
              <div className="flex-1 p-3 bg-orange-50 dark:bg-orange-950 rounded">
                <div className="text-xs text-muted-foreground">Disk</div>
                <div className="text-2xl font-bold">{device.disk}%</div>
              </div>
            </div>
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              Time-series chart coming soon...
            </div>
          </div>
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
          <h2 className="text-lg font-semibold">Custom Dashboard</h2>
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
              {Object.entries(WIDGET_TYPES).map(([key, config]) => {
                const Icon = config.icon;
                return (
                  <DropdownMenuItem key={key} onClick={() => addWidget(key as keyof typeof WIDGET_TYPES)}>
                    <Icon className="w-4 h-4 mr-2" />
                    {config.name}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          
          <Button 
            onClick={() => setIsEditMode(!isEditMode)}
            size="sm"
            variant={isEditMode ? 'default' : 'outline'}
          >
            {isEditMode ? (
              <>
                <Lock className="w-4 h-4 mr-2" />
                Lock Layout
              </>
            ) : (
              <>
                <Unlock className="w-4 h-4 mr-2" />
                Edit Layout
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Dashboard Grid */}
      <div className="flex-1 overflow-auto p-4 bg-background">
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
          compactType="vertical"
          preventCollision={false}
        >
          {widgets.map(widget => (
            <div key={widget.i}>
              {renderWidget(widget)}
            </div>
          ))}
        </ResponsiveGridLayout>
      </div>
    </div>
  );
}
