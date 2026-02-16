import { useState, useEffect } from 'react';
import { Responsive, WidthProvider, Layout } from 'react-grid-layout';
import { buildApiUrl } from '../config/api';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
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
  ChevronDown,
  RefreshCw,
  Settings,
  Layers,
  Maximize2,
  X,
  Gauge,
  Share2,
  Copy
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../components/ui/tooltip';
import { Device } from '../components/AgentSidebar';
import { MetricDataCard, type MetricDataCardConfig } from '../components/MetricDataCard';
import { MetricDataCardConfigDialog } from '../components/MetricDataCardConfigDialog';
import MetricValueCard, { type MetricValueCardConfig } from '../components/MetricValueCard';
import MetricValueCardConfigDialog from '../components/MetricValueCardConfigDialog';
import { TableDataCard, type TableDataCardConfig } from '../components/TableDataCard';
import { TableDataCardConfigDialog } from '../components/TableDataCardConfigDialog';
import { Table } from 'lucide-react';

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
    name: 'Metric Card',
    icon: BarChart3,
    minW: 4,
    minH: 6,
    defaultW: 6,
    defaultH: 8
  },
  METRIC_VALUE: {
    id: 'metric-value',
    name: 'Metric Value Card',
    icon: Gauge,
    minW: 2,
    minH: 2,
    defaultW: 4,
    defaultH: 4
  },
  TABLE: {
    id: 'table',
    name: 'Metrics Table',
    icon: Table,
    minW: 4,
    minH: 6,
    defaultW: 8,
    defaultH: 8
  }
};

interface DashboardWidget extends Layout {
  type: keyof typeof WIDGET_TYPES;
  title: string;
  deviceId?: string; // For device-specific widgets
  metricConfig?: MetricDataCardConfig; // For metric data widgets
  metricValueConfig?: MetricValueCardConfig; // For metric value widgets
  tableConfig?: TableDataCardConfig; // For table widgets
  _metricData?: any; // Runtime data for badge rendering
  _refreshTrigger?: number; // Timestamp to trigger manual refresh
}

interface DashboardLayout {
  id: number;
  layoutName: string;
  widgetCount: number;
  isDefault: boolean;
  shareToken: string;
  createdAt: string;
  updatedAt: string;
}

interface GlobalDashboardPageProps {
  devices: Device[];
  onDeviceSelect: (device: Device) => void;
}

export function GlobalDashboardPage({ devices, onDeviceSelect }: GlobalDashboardPageProps) {
  // Sanitize widgets to ensure all layout properties are valid numbers
  const sanitizeWidgets = (widgets: any[]): DashboardWidget[] => {
    return widgets.map(widget => ({
      ...widget,
      x: typeof widget.x === 'number' ? widget.x : 0,
      y: typeof widget.y === 'number' ? widget.y : 0,
      w: typeof widget.w === 'number' ? widget.w : 4,
      h: typeof widget.h === 'number' ? widget.h : 4,
      minW: typeof widget.minW === 'number' ? widget.minW : 2,
      minH: typeof widget.minH === 'number' ? widget.minH : 2
    }));
  };

  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [isEditMode, setIsEditMode] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedDeviceForWidget, setSelectedDeviceForWidget] = useState<string>('');
  const [availableLayouts, setAvailableLayouts] = useState<DashboardLayout[]>([]);
  const [currentLayoutId, setCurrentLayoutId] = useState<number | null>(null);
  const [currentLayoutName, setCurrentLayoutName] = useState<string>('Default');
  const [currentShareToken, setCurrentShareToken] = useState<string | null>(null);
  const [showNewDashboardDialog, setShowNewDashboardDialog] = useState(false);
  const [showRenameDashboardDialog, setShowRenameDashboardDialog] = useState(false);
  const [newDashboardName, setNewDashboardName] = useState('');
  const [showMetricConfigDialog, setShowMetricConfigDialog] = useState(false);
  const [showMetricValueConfigDialog, setShowMetricValueConfigDialog] = useState(false);
  const [showTableConfigDialog, setShowTableConfigDialog] = useState(false);
  const [configuringWidgetId, setConfiguringWidgetId] = useState<string | null>(null);
  const [refreshingWidgets, setRefreshingWidgets] = useState<Set<string>>(new Set());
  const [showDeleteConfirmDialog, setShowDeleteConfirmDialog] = useState(false);
  const [widgetToDelete, setWidgetToDelete] = useState<string | null>(null);
  const [showResetConfirmDialog, setShowResetConfirmDialog] = useState(false);
  const [showUnsavedChangesDialog, setShowUnsavedChangesDialog] = useState(false);
  const [pendingLayoutSwitch, setPendingLayoutSwitch] = useState<number | null>(null);
  const [showDeleteDashboardDialog, setShowDeleteDashboardDialog] = useState(false);
  const [dashboardToDelete, setDashboardToDelete] = useState<number | null>(null);
  const [isEditingWidget, setIsEditingWidget] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [shareCopied, setShareCopied] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState<number>(() => {
    const saved = localStorage.getItem('dashboard-refresh-interval');
    return saved ? parseInt(saved, 10) : 30;
  });
  const cachedLayoutKey = 'global-dashboard-layout-cache';
  const [isKioskMode, setIsKioskMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('dashboard-kiosk-mode');
    return saved === 'true';
  });

  const toggleKioskMode = () => {
    const newKioskMode = !isKioskMode;
    setIsKioskMode(newKioskMode);
    localStorage.setItem('dashboard-kiosk-mode', newKioskMode.toString());
    // Trigger a custom event for App.tsx to listen to
    window.dispatchEvent(new CustomEvent('kiosk-mode-changed', { detail: { kioskMode: newKioskMode } }));
  };

  const shareDashboard = () => {
    if (!currentShareToken) {
      setShareUrl('');
      setShareCopied(false);
      setShowShareDialog(true);
      return;
    }
    
    const url = new URL(window.location.href);
    url.searchParams.set('dashboard', currentShareToken);
    setShareUrl(url.toString());
    setShareCopied(false);
    setShowShareDialog(true);
  };

  const copyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  useEffect(() => {
    loadAvailableLayouts();
    
    // Check for dashboard share token in URL query params
    const params = new URLSearchParams(window.location.search);
    const dashboardToken = params.get('dashboard');
    
    if (dashboardToken) {
      // Try to load by share token (UUID format)
      loadLayoutByShareToken(dashboardToken);
      return;
    }
    
    loadLayout();
  }, []);

  const saveCachedLayout = (data: {
    widgets: DashboardWidget[];
    id?: number | null;
    layoutName?: string;
    shareToken?: string | null;
  }) => {
    try {
      localStorage.setItem(cachedLayoutKey, JSON.stringify({
        widgets: sanitizeWidgets(data.widgets),
        id: data.id ?? null,
        layoutName: data.layoutName ?? 'Cached',
        shareToken: data.shareToken ?? null
      }));
    } catch (error) {
      console.warn('Failed to cache dashboard layout:', error);
    }
  };

  const loadCachedLayout = () => {
    try {
      const cached = localStorage.getItem(cachedLayoutKey);
      if (!cached) return false;
      const data = JSON.parse(cached) as {
        widgets?: DashboardWidget[];
        id?: number | null;
        layoutName?: string;
        shareToken?: string | null;
      };
      if (!data.widgets || !Array.isArray(data.widgets) || data.widgets.length === 0) {
        return false;
      }
      setWidgets(sanitizeWidgets(data.widgets));
      setCurrentLayoutId(data.id ?? null);
      setCurrentLayoutName(data.layoutName || 'Cached');
      setCurrentShareToken(data.shareToken ?? null);
      setHasUnsavedChanges(false);
      return true;
    } catch (error) {
      console.warn('Failed to load cached dashboard layout:', error);
      return false;
    }
  };

  const loadAvailableLayouts = async () => {
    try {
      const response = await fetch(buildApiUrl(`/api/v1/dashboard-layouts/global/all`), {
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

  const loadLayoutByShareToken = async (shareToken: string) => {
    try {
      setIsLoading(true);
      
      const response = await fetch(buildApiUrl(`/api/v1/dashboard-layouts/by-share-token/${shareToken}`), {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setWidgets(sanitizeWidgets(data.widgets || []));
        setCurrentLayoutId(data.id);
        setCurrentLayoutName(data.layoutName || 'Shared Dashboard');
        setCurrentShareToken(data.shareToken);
        setHasUnsavedChanges(false);
        saveCachedLayout({
          widgets: data.widgets || [],
          id: data.id,
          layoutName: data.layoutName || 'Shared Dashboard',
          shareToken: data.shareToken
        });
      } else {
        console.error('Dashboard not found');
        if (!loadCachedLayout()) {
          loadLayout(); // Fallback to default
        }
      }
    } catch (error) {
      console.error('Error loading shared dashboard:', error);
      if (!loadCachedLayout()) {
        loadLayout(); // Fallback to default
      }
    } finally {
      setIsLoading(false);
    }
  };

  const loadLayout = async (layoutId?: number) => {
    try {
      setIsLoading(true);
      
      if (layoutId) {
        // Load specific layout by ID
        const response = await fetch(buildApiUrl(`/api/v1/dashboard-layouts/by-id/${layoutId}`), {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
          }
        });

        if (response.ok) {
          const data = await response.json();
          setWidgets(sanitizeWidgets(data.widgets || []));
          setCurrentLayoutId(layoutId);
          setCurrentLayoutName(data.layoutName || 'Default');
          setCurrentShareToken(data.shareToken);
          setHasUnsavedChanges(false);
          saveCachedLayout({
            widgets: data.widgets || [],
            id: layoutId,
            layoutName: data.layoutName || 'Default',
            shareToken: data.shareToken
          });
          return;
        }
      }

      // Load default layout
      const response = await fetch(buildApiUrl(`/api/v1/dashboard-layouts/global`), {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.widgets && Array.isArray(data.widgets) && data.widgets.length > 0) {
          setWidgets(sanitizeWidgets(data.widgets));
          setCurrentLayoutId(data.id || null);
          setCurrentLayoutName(data.layoutName || 'Default');
          setCurrentShareToken(data.shareToken || null);
          saveCachedLayout({
            widgets: data.widgets,
            id: data.id || null,
            layoutName: data.layoutName || 'Default',
            shareToken: data.shareToken || null
          });
        } else {
          if (!loadCachedLayout()) {
            loadDefaultLayout();
          }
        }
      } else {
        if (!loadCachedLayout()) {
          loadDefaultLayout();
        }
      }
    } catch (error) {
      console.error('Error loading global layout:', error);
      if (!loadCachedLayout()) {
        loadDefaultLayout();
      }
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
      const response = await fetch(buildApiUrl('/api/v1/dashboard-layouts/global'), {
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
      const response = await fetch(buildApiUrl('/api/v1/dashboard-layouts/global'), {
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
      const response = await fetch(buildApiUrl(`/api/v1/dashboard-layouts/${currentLayoutId}`), {
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
    setDashboardToDelete(layoutId);
    setShowDeleteDashboardDialog(true);
  };

  const confirmDeleteDashboard = async () => {
    if (dashboardToDelete === null) return;

    try {
      const response = await fetch(buildApiUrl(`/api/v1/dashboard-layouts/${dashboardToDelete}`), {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
        }
      });

      if (response.ok) {
        await loadAvailableLayouts();
        // If we deleted the current layout, load the default
        if (dashboardToDelete === currentLayoutId) {
          await loadLayout();
        }
        setShowDeleteDashboardDialog(false);
        setDashboardToDelete(null);
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
      setPendingLayoutSwitch(layoutId);
      setShowUnsavedChangesDialog(true);
      return;
    }
    await loadLayout(layoutId);
    
    // Update URL with share token (without page reload)
    if (currentShareToken) {
      const url = new URL(window.location.href);
      url.searchParams.set('dashboard', currentShareToken);
      window.history.pushState({}, '', url.toString());
    }
  };

  const confirmSwitchDashboard = async () => {
    if (pendingLayoutSwitch !== null) {
      await loadLayout(pendingLayoutSwitch);
      
      // Update URL with share token (without page reload)
      if (currentShareToken) {
        const url = new URL(window.location.href);
        url.searchParams.set('dashboard', currentShareToken);
        window.history.pushState({}, '', url.toString());
      }
      
      setShowUnsavedChangesDialog(false);
      setPendingLayoutSwitch(null);
    }
  };

  const resetLayout = () => {
    setShowResetConfirmDialog(true);
  };

  const confirmResetLayout = () => {
    loadDefaultLayout();
    setHasUnsavedChanges(true);
    setShowResetConfirmDialog(false);
  };

  const handleLayoutChange = (layout: Layout[]) => {
    // Only update if in edit mode to prevent false unsaved changes on initial render
    if (!isEditMode) return;
    
    const updatedWidgets = widgets.map(widget => {
      const layoutItem = layout.find(l => l.i === widget.i);
      if (layoutItem) {
        return { ...widget, ...layoutItem };
      }
      return widget;
    });
    
    // Check if layout actually changed
    const hasChanges = updatedWidgets.some((widget, index) => {
      const original = widgets[index];
      return widget.x !== original.x || 
             widget.y !== original.y || 
             widget.w !== original.w || 
             widget.h !== original.h;
    });
    
    if (hasChanges) {
      setWidgets(updatedWidgets);
      setHasUnsavedChanges(true);
    }
  };

  const addDeviceWidget = (deviceId: string) => {
    const device = devices.find(d => d.deviceUuid === deviceId);
    if (!device) return;

    const newId = `device-${crypto.randomUUID()}`;
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
      setConfiguringWidgetId(`metric-${crypto.randomUUID()}`);
      setIsEditingWidget(false);  // Flag as new widget, not editing
      setShowMetricConfigDialog(true);
      return;
    }

    if (type === 'METRIC_VALUE') {
      // Open config dialog for metric value widgets
      setConfiguringWidgetId(`metric-value-${crypto.randomUUID()}`);
      setIsEditingWidget(false);  // Flag as new widget, not editing
      setShowMetricValueConfigDialog(true);
      return;
    }

    if (type === 'TABLE') {
      // Open config dialog for table widgets
      setConfiguringWidgetId(`table-${crypto.randomUUID()}`);
      setIsEditingWidget(false);  // Flag as new widget, not editing
      setShowTableConfigDialog(true);
      return;
    }

    const widgetConfig = WIDGET_TYPES[type];
    const newId = `${crypto.randomUUID()}`;
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
    setShowDeleteConfirmDialog(false);
    setWidgetToDelete(null);
  };

  const handleDeleteClick = (id: string) => {
    setWidgetToDelete(id);
    setShowDeleteConfirmDialog(true);
  };

  const handleSaveMetricConfig = (config: MetricDataCardConfig) => {
    if (!configuringWidgetId) return;

    const existingWidget = widgets.find(w => w.i === configuringWidgetId);
    
    if (existingWidget) {
      // Update existing widget
      const updatedWidgets = widgets.map(w =>
        w.i === configuringWidgetId
          ? { 
              ...w, 
              metricConfig: config, 
              title: config.title || (config.agentName ? `${config.agentName} - ${config.deviceName} - ${config.metricName}` : `${config.deviceName} - ${config.metricName}`),
              _refreshTrigger: Date.now() // Trigger re-render to show threshold changes
            }
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
        title: config.title || (config.agentName ? `${config.agentName} - ${config.deviceName} - ${config.metricName}` : `${config.deviceName} - ${config.metricName}`),
        metricConfig: config
      };
      setWidgets([...widgets, newWidget]);
    }

    setHasUnsavedChanges(true);
    setConfiguringWidgetId(null);
  };

  const handleSaveMetricValueConfig = (config: MetricValueCardConfig) => {
    if (!configuringWidgetId) return;

    const existingWidget = widgets.find(w => w.i === configuringWidgetId);
    
    if (existingWidget) {
      // Update existing widget
      const updatedWidgets = widgets.map(w =>
        w.i === configuringWidgetId
          ? { 
              ...w, 
              metricValueConfig: config, 
              title: config.title || `${config.metricName} - ${config.deviceName}`,
              _refreshTrigger: Date.now() // Trigger re-render to show threshold changes
            }
          : w
      );
      setWidgets(updatedWidgets);
    } else {
      // Create new widget
      const widgetConfig = WIDGET_TYPES.METRIC_VALUE;
      const newWidget: DashboardWidget = {
        i: configuringWidgetId,
        x: 0,
        y: Infinity,
        w: widgetConfig.defaultW,
        h: widgetConfig.defaultH,
        minW: widgetConfig.minW,
        minH: widgetConfig.minH,
        type: 'METRIC_VALUE',
        title: config.title || `${config.metricName} - ${config.deviceName}`,
        metricValueConfig: config
      };
      setWidgets([...widgets, newWidget]);
    }

    setHasUnsavedChanges(true);
    setConfiguringWidgetId(null);
  };

  const handleSaveTableConfig = (config: TableDataCardConfig) => {
    if (!configuringWidgetId) return;

    const existingWidget = widgets.find(w => w.i === configuringWidgetId);
    
    if (existingWidget) {
      // Update existing widget
      const updatedWidgets = widgets.map(w =>
        w.i === configuringWidgetId
          ? { 
              ...w, 
              tableConfig: config, 
              title: config.title || `${config.metricName} - Table`,
              _refreshTrigger: Date.now() // Trigger re-render to show config changes
            }
          : w
      );
      setWidgets(updatedWidgets);
    } else {
      // Create new widget
      const widgetConfig = WIDGET_TYPES.TABLE;
      const newWidget: DashboardWidget = {
        i: configuringWidgetId,
        x: 0,
        y: Infinity,
        w: widgetConfig.defaultW,
        h: widgetConfig.defaultH,
        minW: widgetConfig.minW,
        minH: widgetConfig.minH,
        type: 'TABLE',
        title: config.title || `${config.metricName} - Metrics Table`,
        tableConfig: config
      };
      setWidgets([...widgets, newWidget]);
    }

    setHasUnsavedChanges(true);
    setConfiguringWidgetId(null);
  };

  const renderWidget = (widget: DashboardWidget) => {
    const WidgetIcon = WIDGET_TYPES[widget.type].icon;
    const isMetricWidget = widget.type === 'METRIC_DATA';
    const isTableWidget = widget.type === 'TABLE';
    const metricData = widget._metricData;
    const isRefreshing = refreshingWidgets.has(widget.i);
    
    return (
      <div key={widget.i} className="h-full">
        <Card className="h-full overflow-hidden">
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 cursor-move card-header flex-1 min-w-0">
                {isEditMode && (
                  <GripVertical className="w-5 h-5 text-muted-foreground hover:text-foreground transition-colors flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <WidgetIcon className="w-4 h-4 flex-shrink-0" />
                    <span className="truncate">{widget.title}</span>
                    {isMetricWidget && metricData && (
                      <>
                        <span className="text-muted-foreground mx-1">·</span>
                        <Badge variant="outline" className="text-xs">
                          {metricData.metric.protocol}
                        </Badge>
                        {metricData.metadata.qualityPercentage && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="flex items-center">
                                  {metricData.metadata.qualityPercentage > 95 ? (
                                    <Check className="w-4 h-4 text-green-600" />
                                  ) : (
                                    <AlertTriangle className="w-4 h-4 text-yellow-600" />
                                  )}
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>Data Quality: {metricData.metadata.qualityPercentage.toFixed(1)}%</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </>
                    )}
                  </CardTitle>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {isMetricWidget && widget.metricConfig && (
                  <>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">Time Range:</span>
                      <Select
                        value={widget.metricConfig.timeRange}
                      onValueChange={(value: '1m' | '1h' | '6h' | '12h' | '24h' | '7d' | '30d') => {
                        const updatedWidgets = widgets.map(w => 
                          w.i === widget.i 
                            ? { 
                                ...w, 
                                metricConfig: { ...w.metricConfig!, timeRange: value },
                                _refreshTrigger: Date.now() 
                              } 
                            : w
                        );
                        setWidgets(updatedWidgets);
                        setHasUnsavedChanges(true);
                      }}
                    >
                      <SelectTrigger className="h-8 w-[80px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1m">1m</SelectItem>
                        <SelectItem value="1h">1h</SelectItem>
                        <SelectItem value="6h">6h</SelectItem>
                        <SelectItem value="12h">12h</SelectItem>
                        <SelectItem value="24h">24h</SelectItem>
                        <SelectItem value="7d">7d</SelectItem>
                        <SelectItem value="30d">30d</SelectItem>
                      </SelectContent>
                    </Select>
                    </div>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 cursor-pointer hover:bg-primary/10 transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              const updatedWidgets = widgets.map(w =>
                                w.i === widget.i
                                  ? {
                                    ...w,
                                    metricConfig: {
                                      ...w.metricConfig!,
                                      showStats: !(w.metricConfig?.showStats ?? true)
                                    },
                                    _refreshTrigger: Date.now()
                                  }
                                : w
                              );
                              setWidgets(updatedWidgets);
                              setHasUnsavedChanges(true);
                            }}
                          >
                            <Layers className={`w-4 h-4 ${(widget.metricConfig.showStats ?? true) ? 'text-primary' : 'text-muted-foreground'}`} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{(widget.metricConfig.showStats ?? true) ? 'Hide' : 'Show'} aggregate cards</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 cursor-pointer hover:bg-primary/10 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        const updatedWidgets = widgets.map(w => 
                          w.i === widget.i ? { ...w, _refreshTrigger: Date.now() } : w
                        );
                        setWidgets(updatedWidgets);
                        setRefreshingWidgets(prev => new Set(prev).add(widget.i));
                        setTimeout(() => {
                          setRefreshingWidgets(prev => {
                            const next = new Set(prev);
                            next.delete(widget.i);
                            return next;
                          });
                        }, 1500);
                      }}
                    >
                      <RefreshCw 
                        className="w-4 h-4" 
                        style={{ 
                          transform: isRefreshing ? 'rotate(360deg)' : 'rotate(0deg)',
                          transition: isRefreshing ? 'transform 1s linear' : 'none'
                        }} 
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 cursor-pointer hover:bg-primary/10 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        setConfiguringWidgetId(widget.i);
                        setIsEditingWidget(true);
                        setShowMetricConfigDialog(true);
                      }}
                    >
                      <Settings className="w-4 h-4" />
                    </Button>
                  </>
                )}
                {isTableWidget && widget.tableConfig && (
                  <>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">Time Range:</span>
                      <Select
                        value={widget.tableConfig.timeRange}
                        onValueChange={(value: string) => {
                          const updatedWidgets = widgets.map(w => 
                            w.i === widget.i 
                              ? { 
                                  ...w, 
                                  tableConfig: { ...w.tableConfig!, timeRange: value },
                                  _refreshTrigger: Date.now() 
                                } 
                              : w
                          );
                          setWidgets(updatedWidgets);
                          setHasUnsavedChanges(true);
                        }}
                      >
                        <SelectTrigger className="h-8 w-[80px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="1h">1h</SelectItem>
                          <SelectItem value="6h">6h</SelectItem>
                          <SelectItem value="12h">12h</SelectItem>
                          <SelectItem value="24h">24h</SelectItem>
                          <SelectItem value="7d">7d</SelectItem>
                          <SelectItem value="30d">30d</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 cursor-pointer hover:bg-primary/10 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        const updatedWidgets = widgets.map(w => 
                          w.i === widget.i ? { ...w, _refreshTrigger: Date.now() } : w
                        );
                        setWidgets(updatedWidgets);
                        setRefreshingWidgets(prev => new Set(prev).add(widget.i));
                        setTimeout(() => {
                          setRefreshingWidgets(prev => {
                            const next = new Set(prev);
                            next.delete(widget.i);
                            return next;
                          });
                        }, 1500);
                      }}
                    >
                      <RefreshCw 
                        className="w-4 h-4" 
                        style={{ 
                          transform: isRefreshing ? 'rotate(360deg)' : 'rotate(0deg)',
                          transition: isRefreshing ? 'transform 1s linear' : 'none'
                        }} 
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 cursor-pointer hover:bg-primary/10 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        setConfiguringWidgetId(widget.i);
                        setIsEditingWidget(true);
                        setShowTableConfigDialog(true);
                      }}
                    >
                      <Settings className="w-4 h-4" />
                    </Button>
                  </>
                )}
                {isEditMode && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      handleDeleteClick(widget.i);
                    }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className={`p-4 pt-0 ${widget.type === 'METRIC_VALUE' ? 'h-full' : ''}`}>
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
                    setIsEditingWidget(true);  // Editing existing widget
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
            key={`${widget.i}-${widget.metricConfig?.timeRange || ''}-${widget.metricConfig?.thresholds?.length || 0}-${widget.metricConfig?.thresholdsEnabled || false}-${widget.metricConfig?.showStats ?? true}`}
            config={widget.metricConfig}
            refreshInterval={refreshInterval}
            refreshTrigger={widget._refreshTrigger}
            onDataLoaded={(data) => {
              // Store data reference for badge rendering
              setWidgets(prevWidgets => 
                prevWidgets.map(w => 
                  w.i === widget.i ? { ...w, _metricData: data } : w
                )
              );
            }}
          />
        );

      case 'TABLE':
        if (!widget.tableConfig) {
          return (
            <div className="text-center text-muted-foreground h-full flex items-center justify-center">
              <div>
                <div className="mb-2">No table configured</div>
                <Button 
                  size="sm" 
                  variant="outline"
                  onClick={() => {
                    setConfiguringWidgetId(widget.i);
                    setIsEditingWidget(true);
                    setShowTableConfigDialog(true);
                  }}
                >
                  Configure Table
                </Button>
              </div>
            </div>
          );
        }
        
        // Skip rendering table card if config is not set
        if (!widget.tableConfig) {
          return (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <p>Table configuration required</p>
            </div>
          );
        }
        
        return (
          <TableDataCard 
            key={`${widget.i}-${widget.tableConfig?.timeRange || ''}`}
            config={widget.tableConfig}
            refreshInterval={refreshInterval}
            refreshTrigger={widget._refreshTrigger}
            onConfigure={() => {
              setConfiguringWidgetId(widget.i);
              setIsEditingWidget(true);
              setShowTableConfigDialog(true);
            }}
            onDataLoaded={(data) => {
              setWidgets(prevWidgets => 
                prevWidgets.map(w => 
                  w.i === widget.i ? { ...w, _metricData: data } : w
                )
              );
            }}
          />
        );

      case 'METRIC_VALUE':
        if (!widget.metricValueConfig) {
          return (
            <div className="text-center text-muted-foreground h-full flex items-center justify-center">
              <div>
                <div className="mb-2">No metric configured</div>
                <Button 
                  size="sm" 
                  variant="outline"
                  onClick={() => {
                    setConfiguringWidgetId(widget.i);
                    setIsEditingWidget(true);
                    setShowMetricValueConfigDialog(true);
                  }}
                >
                  Configure Metric
                </Button>
              </div>
            </div>
          );
        }
        return (
          <MetricValueCard 
            key={`${widget.i}-${widget.metricValueConfig?.timeRange || ''}-${widget.metricValueConfig?.warningThreshold || 'none'}-${widget.metricValueConfig?.criticalThreshold || 'none'}`}
            config={widget.metricValueConfig}
            refreshInterval={refreshInterval}
            refreshTrigger={widget._refreshTrigger}
            noWrapper={true}
            onDataLoaded={(data) => {
              // Store data reference for badge rendering
              setWidgets(prevWidgets => 
                prevWidgets.map(w => 
                  w.i === widget.i ? { ...w, _metricData: data } : w
                )
              );
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
      {/* Exit Kiosk Mode Button - Fixed top right */}
      {isKioskMode && (
        <Button
          onClick={toggleKioskMode}
          size="icon"
          variant="default"
          className="fixed top-4 right-4 z-50 h-10 w-10 rounded-full shadow-lg hover:shadow-xl transition-shadow"
        >
          <X className="w-5 h-5" />
        </Button>
      )}
      
      {/* Toolbar - Hidden in kiosk mode */}
      {!isKioskMode && (
        <div className="flex-none bg-card border-b border-border p-4 flex items-center justify-between">
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
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Refresh:</span>
            <Select
              value={refreshInterval.toString()}
              onValueChange={(value) => {
                const interval = parseInt(value, 10);
                setRefreshInterval(interval);
                localStorage.setItem('dashboard-refresh-interval', value);
              }}
            >
              <SelectTrigger className="h-8 w-[90px] text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5">5s</SelectItem>
                <SelectItem value="10">10s</SelectItem>
                <SelectItem value="30">30s</SelectItem>
                <SelectItem value="60">1m</SelectItem>
                <SelectItem value="300">5m</SelectItem>
                <SelectItem value="0">Off</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
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
          
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button onClick={shareDashboard} size="sm" variant="outline" disabled={!currentShareToken}>
                  <Share2 className="w-4 h-4 mr-2" />
                  Share
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Copy shareable link to clipboard</p>
              </TooltipContent>
            </Tooltip>
            
            <Tooltip>
              <TooltipTrigger asChild>
                <Button onClick={toggleKioskMode} size="sm" variant="outline">
                  <Maximize2 className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Enter Kiosk Mode</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          
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
                Metric Card
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addWidget('TABLE')}>
                <Table className="w-4 h-4 mr-2" />
                Metrics Table
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addWidget('METRIC_VALUE')}>
                <Gauge className="w-4 h-4 mr-2" />
                Metric Value
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
                    <option value="">Add Agent Card...</option>
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
      )}

      {/* Grid Layout */}
      <div className={`flex-1 overflow-auto ${isKioskMode ? 'p-0' : 'p-4'}`}>
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
        onOpenChange={(open) => {
          setShowMetricConfigDialog(open);
          if (!open) {
            setConfiguringWidgetId(null);
            setIsEditingWidget(false);  // Reset editing flag
          }
        }}
        onSave={handleSaveMetricConfig}
        initialConfig={isEditingWidget && configuringWidgetId 
          ? widgets.find(w => w.i === configuringWidgetId)?.metricConfig 
          : undefined}  // Only load config when editing existing widget, not when creating new
      />

      {/* Table Data Card Configuration Dialog */}
      <TableDataCardConfigDialog
        open={showTableConfigDialog}
        onClose={() => {
          setShowTableConfigDialog(false);
          setConfiguringWidgetId(null);
          setIsEditingWidget(false);
        }}
        onSave={handleSaveTableConfig}
        initialConfig={isEditingWidget && configuringWidgetId 
          ? widgets.find(w => w.i === configuringWidgetId)?.tableConfig 
          : undefined}
      />

      {/* Metric Value Card Configuration Dialog */}
      <MetricValueCardConfigDialog
        open={showMetricValueConfigDialog}
        onOpenChange={(open) => {
          setShowMetricValueConfigDialog(open);
          if (!open) {
            setConfiguringWidgetId(null);
            setIsEditingWidget(false);
          }
        }}
        onSave={handleSaveMetricValueConfig}
        initialConfig={isEditingWidget && configuringWidgetId 
          ? widgets.find(w => w.i === configuringWidgetId)?.metricValueConfig 
          : undefined}
      />

      {/* Delete Widget Confirmation Dialog */}
      <Dialog open={showDeleteConfirmDialog} onOpenChange={setShowDeleteConfirmDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Widget</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this widget? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowDeleteConfirmDialog(false);
                setWidgetToDelete(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (widgetToDelete) {
                  removeWidget(widgetToDelete);
                }
              }}
            >
              Delete Widget
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Layout Confirmation Dialog */}
      <Dialog open={showResetConfirmDialog} onOpenChange={setShowResetConfirmDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset Dashboard</DialogTitle>
            <DialogDescription>
              Are you sure you want to reset the dashboard to default layout? This will remove all widgets and restore the default configuration. Unsaved changes will be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowResetConfirmDialog(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmResetLayout}
            >
              Reset Dashboard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unsaved Changes Confirmation Dialog */}
      <Dialog open={showUnsavedChangesDialog} onOpenChange={setShowUnsavedChangesDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsaved Changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes in the current dashboard. If you switch now, these changes will be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowUnsavedChangesDialog(false);
                setPendingLayoutSwitch(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmSwitchDashboard}
            >
              Switch Without Saving
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dashboard Confirmation Dialog */}
      <Dialog open={showDeleteDashboardDialog} onOpenChange={setShowDeleteDashboardDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Dashboard</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this dashboard? This action cannot be undone and all widgets will be permanently removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowDeleteDashboardDialog(false);
                setDashboardToDelete(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteDashboard}
            >
              Delete Dashboard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share Dashboard Dialog */}
      <Dialog open={showShareDialog} onOpenChange={setShowShareDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share Dashboard</DialogTitle>
            <DialogDescription>
              {!currentShareToken 
                ? 'Please save the dashboard first before sharing.'
                : 'Copy the secure link below to share this dashboard with others.'
              }
            </DialogDescription>
          </DialogHeader>
          {currentShareToken && (
            <div className="py-4">
              <Label htmlFor="share-url" className="text-sm font-medium">
                Dashboard Link
              </Label>
              <div className="flex gap-2 mt-2">
                <Input
                  id="share-url"
                  value={shareUrl}
                  readOnly
                  className="font-mono text-sm"
                  onClick={(e) => e.currentTarget.select()}
                />
                <Button onClick={copyShareUrl} size="sm" variant="outline">
                  {shareCopied ? (
                    <>
                      <Check className="w-4 h-4 mr-2" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 mr-2" />
                      Copy
                    </>
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                This link uses a secure token and cannot be guessed. Anyone with this link can view your dashboard.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              onClick={() => setShowShareDialog(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
