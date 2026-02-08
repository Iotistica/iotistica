/**
 * Device Settings Page - Agent Configuration Management
 * 
 * Manages agent settings through target state with draft mode:
 * 1. Edit settings → Pending state (React only)
 * 2. Save Draft → Persists to database (target_state)
 * 3. Deploy → Deploys to agent
 */

import { useState, useEffect } from 'react';
import { Settings, Save, RefreshCw, AlertCircle, Server, Clock, Zap, Brain, FileText } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { buildApiUrl } from '@/config/api';
import { useDeviceState } from '@/contexts/DeviceStateContext';

interface Props {
  deviceUuid: string;
}

// Default configuration matching the JSON structure
const DEFAULT_SETTINGS = {
  agent: {
    version: "1.0.230"
  },
  logging: {
    level: "debug",
    maxLogs: 10000,
    logMaxAge: 86400000,
    maxLogFileSize: 52428800,
    enableCompression: true,
    enableRemoteLogging: true,
    enableFilePersistence: false
  },
  runtime: {
    memory: {
      thresholdMb: 30,
      checkIntervalMs: 30000
    },
    scheduledRestart: {
      reason: "heap_fragmentation_cleanup",
      enabled: true,
      intervalDays: 7
    }
  },
  features: {
    enableDeviceJobs: false,
    enableAnomalyDetection: false,
    enableDeviceRemoteAccess: true,
    enableDeviceSensorPublish: true
  },
  intervals: {
    device: {
      reportIntervalMs: 60000,
      metricsIntervalMs: 60000,
      reconciliationIntervalMs: 30000,
      targetStatePollIntervalMs: 60000
    },
    discovery: {
      fullIntervalMs: 86400000,
      lightIntervalMs: 14400000
    }
  },
  anomalyDetection: {
    alerts: {
      cooldownMs: 300000,
      maxQueueSize: 1000
    },
    enabled: true,
    storage: {
      retention: 30,
      minSamples: 5
    },
    defaults: {
      methods: ["mad"],
      threshold: 3,
      minSamples: 5,
      windowSize: 120
    },
    sensitivity: 5,
    systemMetrics: [
      {
        name: "cpu_usage",
        enabled: true,
        methods: ["zscore", "ewma"],
        threshold: 3,
        windowSize: 100,
        expectedRange: [0, 85]
      },
      {
        name: "memory_percent",
        enabled: true,
        methods: ["zscore", "ewma", "rate_change"],
        threshold: 3,
        windowSize: 200,
        expectedRange: [0, 85]
      },
      {
        name: "cpu_temp",
        enabled: true,
        methods: ["zscore", "mad"],
        threshold: 3,
        windowSize: 300,
        expectedRange: [30, 80]
      }
    ],
    warmupPeriodMs: 900000
  }
};

export default function DeviceSettingsPage({ deviceUuid }: Props) {
  const { getPendingConfig, updatePendingConfig, getTargetConfig,  saveTargetState, hasPendingChanges } = useDeviceState();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Get current settings from pending state (or target state as fallback)
  const pendingConfig = getPendingConfig(deviceUuid);
  const targetConfig = getTargetConfig(deviceUuid);
  
  // Merge with defaults
  const settings = {
    ...DEFAULT_SETTINGS,
    ...pendingConfig,
    logging: { ...DEFAULT_SETTINGS.logging, ...pendingConfig.logging },
    runtime: {
      memory: { ...DEFAULT_SETTINGS.runtime.memory, ...pendingConfig.runtime?.memory },
      scheduledRestart: { ...DEFAULT_SETTINGS.runtime.scheduledRestart, ...pendingConfig.runtime?.scheduledRestart }
    },
    features: { ...DEFAULT_SETTINGS.features, ...pendingConfig.features },
    intervals: {
      device: { ...DEFAULT_SETTINGS.intervals.device, ...pendingConfig.intervals?.device },
      discovery: { ...DEFAULT_SETTINGS.intervals.discovery, ...pendingConfig.intervals?.discovery }
    },
    anomalyDetection: { ...DEFAULT_SETTINGS.anomalyDetection, ...pendingConfig.anomalyDetection }
  };

  const hasUnsavedChanges = hasPendingChanges(deviceUuid);

  useEffect(() => {
    // Initialize - settings come from DeviceStateContext
    setLoading(false);
  }, [deviceUuid]);

  const updateSetting = (path: string, value: any) => {
    updatePendingConfig(deviceUuid, path, value);
  };

  const handleSaveDraft = async () => {
    setSaving(true);
    try {
      // Save pending changes to target_state (database)
      await saveTargetState(deviceUuid);
      toast.success('Settings saved to draft - Click "Deploy" to apply to agent');
    } catch (err: any) {
      console.error('Error saving settings:', err);
      toast.error(`Failed to save settings: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 bg-background overflow-auto p-6">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-muted-foreground">Loading agent settings...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-background overflow-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Agent Settings</h1>
            <p className="text-sm text-muted-foreground">
              Configure agent behavior, logging, intervals, and features
            </p>
          </div>
        </div>

        {/* Agent Version */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              Agent Version
            </CardTitle>
            <CardDescription>Current agent version</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-sm">
                v{settings.agent?.version || DEFAULT_SETTINGS.agent.version}
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Logging Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Logging
            </CardTitle>
            <CardDescription>Configure agent logging behavior</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-foreground mb-2 block">Log Level</label>
                <select
                  value={settings.logging.level}
                  onChange={(e) => updateSetting('logging.level', e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                >
                  <option value="debug">Debug</option>
                  <option value="info">Info</option>
                  <option value="warn">Warning</option>
                  <option value="error">Error</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-foreground mb-2 block">Max Logs</label>
                <input
                  type="number"
                  value={settings.logging.maxLogs}
                  onChange={(e) => updateSetting('logging.maxLogs', parseInt(e.target.value))}
                  className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                  min={100}
                  max={100000}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground mb-2 block">Log Max Age (ms)</label>
                <input
                  type="number"
                  value={settings.logging.logMaxAge}
                  onChange={(e) => updateSetting('logging.logMaxAge', parseInt(e.target.value))}
                  className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground mb-2 block">Max Log File Size (bytes)</label>
                <input
                  type="number"
                  value={settings.logging.maxLogFileSize}
                  onChange={(e) => updateSetting('logging.maxLogFileSize', parseInt(e.target.value))}
                  className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                />
              </div>
            </div>
            
            <div className="space-y-3 pt-4 border-t border-border">
              <FeatureToggle
                label="Enable Compression"
                description="Compress log files to save disk space"
                enabled={settings.logging.enableCompression}
                onToggle={() => updateSetting('logging.enableCompression', !settings.logging.enableCompression)}
              />
              <FeatureToggle
                label="Enable Remote Logging"
                description="Send logs to cloud API for centralized monitoring"
                enabled={settings.logging.enableRemoteLogging}
                onToggle={() => updateSetting('logging.enableRemoteLogging', !settings.logging.enableRemoteLogging)}
              />
              <FeatureToggle
                label="Enable File Persistence"
                description="Persist logs to disk for local debugging"
                enabled={settings.logging.enableFilePersistence}
                onToggle={() => updateSetting('logging.enableFilePersistence', !settings.logging.enableFilePersistence)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Runtime Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Runtime & Performance
            </CardTitle>
            <CardDescription>Memory management and scheduled restarts</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Memory Management</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-foreground mb-2 block">Threshold (MB)</label>
                  <input
                    type="number"
                    value={settings.runtime.memory.thresholdMb}
                    onChange={(e) => updateSetting('runtime.memory.thresholdMb', parseInt(e.target.value))}
                    className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground mb-2 block">Check Interval (ms)</label>
                  <input
                    type="number"
                    value={settings.runtime.memory.checkIntervalMs}
                    onChange={(e) => updateSetting('runtime.memory.checkIntervalMs', parseInt(e.target.value))}
                    className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-4 pt-4 border-t border-border">
              <h3 className="text-sm font-semibold text-foreground">Scheduled Restart</h3>
              <FeatureToggle
                label="Enable Scheduled Restart"
                description="Automatically restart agent to prevent memory fragmentation"
                enabled={settings.runtime.scheduledRestart.enabled}
                onToggle={() => updateSetting('runtime.scheduledRestart.enabled', !settings.runtime.scheduledRestart.enabled)}
              />
              {settings.runtime.scheduledRestart.enabled && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 ml-4">
                  <div>
                    <label className="text-sm font-medium text-foreground mb-2 block">Interval (days)</label>
                    <input
                      type="number"
                      value={settings.runtime.scheduledRestart.intervalDays}
                      onChange={(e) => updateSetting('runtime.scheduledRestart.intervalDays', parseInt(e.target.value))}
                      className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                      min={1}
                      max={30}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-2 block">Reason</label>
                    <input
                      type="text"
                      value={settings.runtime.scheduledRestart.reason}
                      onChange={(e) => updateSetting('runtime.scheduledRestart.reason', e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                    />
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Features */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Features
            </CardTitle>
            <CardDescription>Enable or disable agent capabilities</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <FeatureToggle
              label="Device Jobs"
              description="Enable job execution engine on the agent"
              enabled={settings.features.enableDeviceJobs}
              onToggle={() => updateSetting('features.enableDeviceJobs', !settings.features.enableDeviceJobs)}
            />
            <FeatureToggle
              label="Anomaly Detection"
              description="Enable AI-powered anomaly detection for metrics"
              enabled={settings.features.enableAnomalyDetection}
              onToggle={() => updateSetting('features.enableAnomalyDetection', !settings.features.enableAnomalyDetection)}
            />
            <FeatureToggle
              label="Remote Access"
              description="Allow remote SSH/terminal access to device"
              enabled={settings.features.enableDeviceRemoteAccess}
              onToggle={() => updateSetting('features.enableDeviceRemoteAccess', !settings.features.enableDeviceRemoteAccess)}
            />
            <FeatureToggle
              label="Sensor Publishing"
              description="Automatically publish sensor data to MQTT broker"
              enabled={settings.features.enableDeviceSensorPublish}
              onToggle={() => updateSetting('features.enableDeviceSensorPublish', !settings.features.enableDeviceSensorPublish)}
            />
          </CardContent>
        </Card>

        {/* Intervals */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Intervals & Timing
            </CardTitle>
            <CardDescription>Control agent communication and synchronization timing</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Device Communication</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-foreground mb-2 block">Report Interval (ms)</label>
                  <input
                    type="number"
                    value={settings.intervals.device.reportIntervalMs}
                    onChange={(e) => updateSetting('intervals.device.reportIntervalMs', parseInt(e.target.value))}
                    className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground mb-2 block">Metrics Interval (ms)</label>
                  <input
                    type="number"
                    value={settings.intervals.device.metricsIntervalMs}
                    onChange={(e) => updateSetting('intervals.device.metricsIntervalMs', parseInt(e.target.value))}
                    className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground mb-2 block">Reconciliation Interval (ms)</label>
                  <input
                    type="number"
                    value={settings.intervals.device.reconciliationIntervalMs}
                    onChange={(e) => updateSetting('intervals.device.reconciliationIntervalMs', parseInt(e.target.value))}
                    className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground mb-2 block">Target State Poll Interval (ms)</label>
                  <input
                    type="number"
                    value={settings.intervals.device.targetStatePollIntervalMs}
                    onChange={(e) => updateSetting('intervals.device.targetStatePollIntervalMs', parseInt(e.target.value))}
                    className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-4 pt-4 border-t border-border">
              <h3 className="text-sm font-semibold text-foreground">Discovery Scanning</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-foreground mb-2 block">Full Scan Interval (ms)</label>
                  <input
                    type="number"
                    value={settings.intervals.discovery.fullIntervalMs}
                    onChange={(e) => updateSetting('intervals.discovery.fullIntervalMs', parseInt(e.target.value))}
                    className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground mb-2 block">Light Scan Interval (ms)</label>
                  <input
                    type="number"
                    value={settings.intervals.discovery.lightIntervalMs}
                    onChange={(e) => updateSetting('intervals.discovery.lightIntervalMs', parseInt(e.target.value))}
                    className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Anomaly Detection (only if feature enabled) */}
        {settings.features.enableAnomalyDetection && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Brain className="h-5 w-5" />
                Anomaly Detection
              </CardTitle>
              <CardDescription>Configure AI-powered anomaly detection thresholds</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-foreground mb-2 block">Sensitivity (1-10)</label>
                  <input
                    type="number"
                    value={settings.anomalyDetection.sensitivity}
                    onChange={(e) => updateSetting('anomalyDetection.sensitivity', parseInt(e.target.value))}
                    className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                    min={1}
                    max={10}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground mb-2 block">Warmup Period (ms)</label>
                  <input
                    type="number"
                    value={settings.anomalyDetection.warmupPeriodMs}
                    onChange={(e) => updateSetting('anomalyDetection.warmupPeriodMs', parseInt(e.target.value))}
                    className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                  />
                </div>
              </div>

              <div className="space-y-4 pt-4 border-t border-border">
                <h3 className="text-sm font-semibold text-foreground">Alerts Configuration</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-foreground mb-2 block">Cooldown (ms)</label>
                    <input
                      type="number"
                      value={settings.anomalyDetection.alerts.cooldownMs}
                      onChange={(e) => updateSetting('anomalyDetection.alerts.cooldownMs', parseInt(e.target.value))}
                      className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-2 block">Max Queue Size</label>
                    <input
                      type="number"
                      value={settings.anomalyDetection.alerts.maxQueueSize}
                      onChange={(e) => updateSetting('anomalyDetection.alerts.maxQueueSize', parseInt(e.target.value))}
                      className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-4 pt-4 border-t border-border">
                <h3 className="text-sm font-semibold text-foreground">Storage</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-foreground mb-2 block">Retention (days)</label>
                    <input
                      type="number"
                      value={settings.anomalyDetection.storage.retention}
                      onChange={(e) => updateSetting('anomalyDetection.storage.retention', parseInt(e.target.value))}
                      className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-2 block">Min Samples</label>
                    <input
                      type="number"
                      value={settings.anomalyDetection.storage.minSamples}
                      onChange={(e) => updateSetting('anomalyDetection.storage.minSamples', parseInt(e.target.value))}
                      className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground"
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

interface FeatureToggleProps {
  label: string;
  description: string;
  enabled: boolean;
  onToggle: () => void;
}

function FeatureToggle({ label, description, enabled, onToggle }: FeatureToggleProps) {
  return (
    <div className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors">
      <div className="flex-1 mr-4">
        <div className="font-medium text-foreground">{label}</div>
        <div className="text-sm text-muted-foreground mt-1">{description}</div>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
      />
    </div>
  );
}
