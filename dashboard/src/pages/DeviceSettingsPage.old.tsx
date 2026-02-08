import { useState, useEffect } from 'react';
import { Settings, Save, RefreshCw, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import { buildApiUrl } from '@/config/api';

interface DeviceFeatures {
  enableRemoteAccess?: boolean;
  enableJobEngine?: boolean;
  enableCloudJobs?: boolean;
  enableSensorPublish?: boolean;
  enableProtocolAdapters?: boolean;
  enableShadow?: boolean;
  enableFirstBootDiscovery?: boolean;
  enableAnomalyDetection?: boolean;
}

interface DeviceIntervals {
  discoveryFullIntervalMs?: number;
  discoveryLightIntervalMs?: number;
  targetStatePollIntervalMs?: number;
  deviceReportIntervalMs?: number;
  metricsIntervalMs?: number;
  reconciliationIntervalMs?: number;
}

interface ModbusConfig {
  enabled?: boolean;
  tcpHost?: string;
  tcpPort?: number;
  slaveRangeStart?: number;
  slaveRangeEnd?: number;
  timeout?: number;
  vendor?: string;
}

interface OPCUAConfig {
  enabled?: boolean;
  discoveryUrls?: string[];
}

interface SNMPConfig {
  enabled?: boolean;
  ipRanges?: string[];
  port?: number;
}

interface ProtocolAdapters {
  modbus?: ModbusConfig;
  opcua?: OPCUAConfig;
  snmp?: SNMPConfig;
}

interface PerformanceConfig {
  memoryCheckIntervalMs?: number;
  memoryThresholdMb?: number;
}

interface LoggingConfig {
  level?: string;
  enableFilePersistence?: boolean;
  enableCompression?: boolean;
  logMaxAge?: number;
  maxLogFileSize?: number;
  maxLogs?: number;
}

interface DeviceSettings {
  reconciliationIntervalMs?: number;
  targetStatePollIntervalMs?: number;
  deviceReportIntervalMs?: number;
}

interface DeviceConfig {
  features?: DeviceFeatures;
  intervals?: DeviceIntervals;
  protocolAdapters?: ProtocolAdapters;
  settings?: DeviceSettings;
  logging?: LoggingConfig;
  memoryCheckIntervalMs?: number;
  memoryThresholdMb?: number;
  logMaxAge?: number;
  maxLogFileSize?: number;
  maxLogs?: number;
}

interface Props {
  deviceUuid: string;
}

export default function DeviceSettingsPage({ deviceUuid }: Props) {
  const [config, setConfig] = useState<DeviceConfig>({});
  const [pendingConfig, setPendingConfig] = useState<DeviceConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDeviceConfig = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/target-state`));
      
      if (!response.ok) {
        throw new Error('Failed to load device configuration');
      }
      
      const data = await response.json();
      const deviceConfig = data.config || {};
      
      setConfig(deviceConfig);
      setPendingConfig(deviceConfig);
      setHasChanges(false);
    } catch (err: any) {
      console.error('Error loading device config:', err);
      setError(err.message || 'Failed to load device configuration');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (deviceUuid) {
      loadDeviceConfig();
    }
  }, [deviceUuid]);

  const handleFeatureToggle = (feature: keyof DeviceFeatures) => {
    setPendingConfig(prev => ({
      ...prev,
      features: {
        ...prev.features,
        [feature]: !prev.features?.[feature]
      }
    }));
    setHasChanges(true);
  };

  const handleIntervalChange = (key: keyof DeviceIntervals, value: number) => {
    setPendingConfig(prev => ({
      ...prev,
      intervals: {
        ...prev.intervals,
        [key]: value
      }
    }));
    setHasChanges(true);
  };

  const handleModbusChange = (field: keyof ModbusConfig, value: any) => {
    setPendingConfig(prev => ({
      ...prev,
      protocolAdapters: {
        ...prev.protocolAdapters,
        modbus: {
          ...prev.protocolAdapters?.modbus,
          [field]: value
        }
      }
    }));
    setHasChanges(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Fetch current target state to preserve apps and other config
      const currentResponse = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/target-state`));
      if (!currentResponse.ok) {
        throw new Error('Failed to fetch current state');
      }
      const currentData = await currentResponse.json();

      // Merge pending config with existing config (preserve non-feature settings)
      const updatedConfig = {
        ...currentData.config,
        features: pendingConfig.features,
        settings: pendingConfig.settings,
        logging: pendingConfig.logging
      };

      const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/target-state`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          apps: currentData.apps, // Preserve existing apps
          config: updatedConfig
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to save configuration');
      }

      setConfig(pendingConfig);
      setHasChanges(false);
      toast.success('Device configuration saved successfully');
    } catch (err: any) {
      console.error('Error saving device config:', err);
      toast.error(`Failed to save configuration: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setPendingConfig(config);
    setHasChanges(false);
    toast.info('Changes discarded');
  };

  if (loading) {
    return (
      <div className="flex-1 bg-background overflow-auto p-6">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Loading device configuration...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 bg-background overflow-auto p-6">
        <div className="max-w-4xl mx-auto">
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <Button onClick={loadDeviceConfig} variant="outline">
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-background overflow-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Device Settings</h1>
            <p className="text-muted-foreground mt-1">
              Configure device features, timing intervals, and protocol adapters
            </p>
          </div>
          <div className="flex gap-2">
            <Button 
              onClick={loadDeviceConfig} 
              variant="outline" 
              size="sm"
              disabled={saving}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            {hasChanges && (
              <>
                <Button 
                  onClick={handleReset} 
                  variant="outline" 
                  size="sm"
                  disabled={saving}
                >
                  Reset
                </Button>
                <Button 
                  onClick={handleSave} 
                  size="sm"
                  disabled={saving}
                >
                  <Save className="mr-2 h-4 w-4" />
                  {saving ? 'Saving...' : 'Save Changes'}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Unsaved Changes Alert */}
        {hasChanges && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              You have unsaved changes. Click "Save Changes" to apply them to the device.
            </AlertDescription>
          </Alert>
        )}

        {/* Timing & Intervals */}
        <Card>
          <CardHeader>
            <CardTitle>Timing & Intervals</CardTitle>
            <CardDescription>
              Control agent communication frequency and discovery schedules
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* CloudSync Intervals */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-foreground">CloudSync (Agent ↔ Cloud Communication)</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <IntervalInput
                  label="Target State Poll"
                  description="How often agent checks for config changes"
                  value={pendingConfig.intervals?.targetStatePollIntervalMs ?? 60000}
                  onChange={(val) => handleIntervalChange('targetStatePollIntervalMs', val)}
                  defaultValue={60000}
                  min={10000}
                  max={300000}
                />
                <IntervalInput
                  label="Device Report"
                  description="How often agent reports current state"
                  value={pendingConfig.intervals?.deviceReportIntervalMs ?? 60000}
                  onChange={(val) => handleIntervalChange('deviceReportIntervalMs', val)}
                  defaultValue={60000}
                  min={10000}
                  max={300000}
                />
                <IntervalInput
                  label="Metrics"
                  description="How often agent sends system metrics"
                  value={pendingConfig.intervals?.metricsIntervalMs ?? 300000}
                  onChange={(val) => handleIntervalChange('metricsIntervalMs', val)}
                  defaultValue={300000}
                  min={30000}
                  max={600000}
                />
                <IntervalInput
                  label="Reconciliation"
                  description="Container state reconciliation interval"
                  value={pendingConfig.intervals?.reconciliationIntervalMs ?? 30000}
                  onChange={(val) => handleIntervalChange('reconciliationIntervalMs', val)}
                  defaultValue={30000}
                  min={10000}
                  max={120000}
                />
              </div>
            </div>

            {/* Discovery Intervals */}
            <div className="space-y-4 pt-4 border-t border-border">
              <h3 className="text-sm font-semibold text-foreground">Discovery (Device Scanning)</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <IntervalInput
                  label="Light Scan"
                  description="Fast ping-only scan interval"
                  value={pendingConfig.intervals?.discoveryLightIntervalMs ?? 14400000}
                  onChange={(val) => handleIntervalChange('discoveryLightIntervalMs', val)}
                  defaultValue={14400000}
                  min={3600000}
                  max={86400000}
                />
                <IntervalInput
                  label="Full Scan"
                  description="Deep validation with device info reads"
                  value={pendingConfig.intervals?.discoveryFullIntervalMs ?? 86400000}
                  onChange={(val) => handleIntervalChange('discoveryFullIntervalMs', val)}
                  defaultValue={86400000}
                  min={3600000}
                  max={604800000}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Device Features */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Device Features
            </CardTitle>
            <CardDescription>
              Enable or disable specific functionality on this device
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FeatureToggle
              label="Protocol Adapters"
              description="Enable Modbus, OPC-UA, SNMP for industrial device communication"
              enabled={pendingConfig.features?.enableProtocolAdapters ?? false}
              onToggle={() => handleFeatureToggle('enableProtocolAdapters')}
            />
            
            <FeatureToggle
              label="Sensor Publishing"
              description="Publish sensor data to MQTT broker automatically"
              enabled={pendingConfig.features?.enableSensorPublish ?? false}
              onToggle={() => handleFeatureToggle('enableSensorPublish')}
            />
            
            <FeatureToggle
              label="First Boot Discovery"
              description="Run protocol discovery on first startup"
              enabled={pendingConfig.features?.enableFirstBootDiscovery ?? false}
              onToggle={() => handleFeatureToggle('enableFirstBootDiscovery')}
            />
            
            <FeatureToggle
              label="Anomaly Detection"
              description="Enable edge AI anomaly detection for metrics and sensors"
              enabled={pendingConfig.features?.enableAnomalyDetection ?? false}
              onToggle={() => handleFeatureToggle('enableAnomalyDetection')}
            />
          </CardContent>
        </Card>

        {/* Protocol Adapters Configuration */}
        {pendingConfig.features?.enableProtocolAdapters && (
          <Card>
            <CardHeader>
              <CardTitle>Protocol Adapters</CardTitle>
              <CardDescription>
                Configure industrial protocol settings for device discovery
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Modbus */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">Modbus TCP</h3>
                  <Switch
                    checked={pendingConfig.protocolAdapters?.modbus?.enabled ?? false}
                    onCheckedChange={(checked) => handleModbusChange('enabled', checked)}
                  />
                </div>
                {pendingConfig.protocolAdapters?.modbus?.enabled && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-4 border-l-2 border-border">
                    <div>
                      <label className="text-sm font-medium text-foreground">TCP Host</label>
                      <input
                        type="text"
                        value={pendingConfig.protocolAdapters?.modbus?.tcpHost ?? ''}
                        onChange={(e) => handleModbusChange('tcpHost', e.target.value)}
                        className="mt-1 w-full px-3 py-2 text-sm rounded-md border border-input bg-input-background dark:bg-input/30 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder="localhost or IP address"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium text-foreground">TCP Port</label>
                      <input
                        type="number"
                        value={pendingConfig.protocolAdapters?.modbus?.tcpPort ?? 502}
                        onChange={(e) => handleModbusChange('tcpPort', parseInt(e.target.value))}
                        className="mt-1 w-full px-3 py-2 text-sm rounded-md border border-input bg-input-background dark:bg-input/30 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        min={1}
                        max={65535}
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium text-foreground">Slave Range Start</label>
                      <input
                        type="number"
                        value={pendingConfig.protocolAdapters?.modbus?.slaveRangeStart ?? 1}
                        onChange={(e) => handleModbusChange('slaveRangeStart', parseInt(e.target.value))}
                        className="mt-1 w-full px-3 py-2 text-sm rounded-md border border-input bg-input-background dark:bg-input/30 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        min={1}
                        max={247}
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium text-foreground">Slave Range End</label>
                      <input
                        type="number"
                        value={pendingConfig.protocolAdapters?.modbus?.slaveRangeEnd ?? 10}
                        onChange={(e) => handleModbusChange('slaveRangeEnd', parseInt(e.target.value))}
                        className="mt-1 w-full px-3 py-2 text-sm rounded-md border border-input bg-input-background dark:bg-input/30 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        min={1}
                        max={247}
                      />
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

interface IntervalInputProps {
  label: string;
  description: string;
  value: number;
  onChange: (value: number) => void;
  defaultValue: number;
  min: number;
  max: number;
}

function IntervalInput({ label, description, value, onChange, defaultValue, min, max }: IntervalInputProps) {
  const [unit, setUnit] = useState<'ms' | 's' | 'm' | 'h'>('s');
  const [displayValue, setDisplayValue] = useState<number>(value / 1000);

  // Convert ms to display unit
  const msToUnit = (ms: number, targetUnit: typeof unit) => {
    switch (targetUnit) {
      case 'ms': return ms;
      case 's': return ms / 1000;
      case 'm': return ms / 60000;
      case 'h': return ms / 3600000;
    }
  };

  // Convert display unit to ms
  const unitToMs = (val: number, sourceUnit: typeof unit) => {
    switch (sourceUnit) {
      case 'ms': return val;
      case 's': return val * 1000;
      case 'm': return val * 60000;
      case 'h': return val * 3600000;
    }
  };

  // Update display value when value or unit changes
  useEffect(() => {
    setDisplayValue(msToUnit(value, unit));
  }, [value, unit]);

  const handleValueChange = (newValue: number) => {
    setDisplayValue(newValue);
    const ms = unitToMs(newValue, unit);
    if (ms >= min && ms <= max) {
      onChange(ms);
    }
  };

  const handleUnitChange = (newUnit: 'ms' | 's' | 'm' | 'h') => {
    const newDisplayValue = msToUnit(value, newUnit);
    setUnit(newUnit);
    setDisplayValue(newDisplayValue);
  };

  const isDefault = value === defaultValue;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-foreground">{label}</label>
        {!isDefault && (
          <button
            onClick={() => onChange(defaultValue)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Reset to default
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="flex gap-2">
        <input
          type="number"
          value={displayValue}
          onChange={(e) => handleValueChange(parseFloat(e.target.value))}
          className="flex-1 px-3 py-2 text-sm rounded-md border border-input bg-input-background dark:bg-input/30 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          step={unit === 'ms' ? 1000 : unit === 's' ? 1 : unit === 'm' ? 1 : 0.1}
        />
        <select
          value={unit}
          onChange={(e) => handleUnitChange(e.target.value as typeof unit)}
          className="px-3 py-2 text-sm rounded-md border border-input bg-input-background dark:bg-input/30 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="ms">ms</option>
          <option value="s">seconds</option>
          <option value="m">minutes</option>
          <option value="h">hours</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        {value}ms = {Math.round(value / 1000)}s = {(value / 60000).toFixed(2)}m = {(value / 3600000).toFixed(2)}h
      </p>
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
        className="data-[state=checked]:bg-green-500 data-[state=unchecked]:bg-gray-300"
      />
    </div>
  );
}
