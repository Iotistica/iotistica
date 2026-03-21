/**
 * Device Mapping Panel
 * 
 * Enhanced UI for mapping IoT devices to building spaces with:
 * - Online/offline status indicators
 * - "Already mapped" warnings
 * - Device details (type, last seen, sensors)
 * - Mapping history display
 */

import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { getApiUrl } from '../config/api';
import { 
  Cpu, 
  Radio, 
  MapPin, 
  CheckCircle, 
  XCircle, 
  AlertCircle,
  Clock,
  Wifi,
  WifiOff
} from 'lucide-react';

const API_BASE_URL = getApiUrl();

interface Device {
  uuid: string;
  device_name: string | null;
  device_type: string | null;
  is_online: boolean;
  last_connectivity_event: string | null;
  created_at: string;
}

interface Space {
  expressId: number;
  name: string;
}

interface DeviceMapping {
  deviceUuid: string;
  deviceName: string | null;
  spaceId: number;
  spaceName: string;
}

interface DeviceMappingPanelProps {
  spaces: Space[];
  onMappingChange?: () => void;
}

export const DeviceMappingPanel: React.FC<DeviceMappingPanelProps> = ({ 
  spaces, 
  onMappingChange 
}) => {
  const [devices, setDevices] = useState<Device[]>([]);
  const [mappings, setMappings] = useState<DeviceMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [selectedSpace, setSelectedSpace] = useState<number | null>(null);
  const [mapping, setMapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);

      // Load devices and mappings in parallel
      const [devicesRes, mappingsRes] = await Promise.all([
        axios.get<{ devices: Device[] }>(`${API_BASE_URL}/api/v1/agents`),
        axios.get<{ success: boolean; data: DeviceMapping[] }>(
          `${API_BASE_URL}/api/v1/digital-twin/graph/device-mappings`
        ),
      ]);

      setDevices(devicesRes.data.devices || []);
      setMappings(mappingsRes.data.data || []);
    } catch (err: any) {
      console.error('Failed to load data:', err);
      setError(err.message || 'Failed to load devices');
    } finally {
      setLoading(false);
    }
  };

  const handleMapDevice = async () => {
    if (!selectedDevice || !selectedSpace) return;

    // Check if already mapped
    const existingMapping = mappings.find(m => m.deviceUuid === selectedDevice);
    if (existingMapping) {
      setError(`Device is already mapped to "${existingMapping.spaceName}". Unmap it first.`);
      return;
    }

    try {
      setMapping(true);
      setError(null);
      setSuccess(null);

      await axios.post(`${API_BASE_URL}/api/v1/digital-twin/graph/map-device`, {
        deviceUuid: selectedDevice,
        spaceExpressId: selectedSpace,
      });

      const device = devices.find(d => d.uuid === selectedDevice);
      const space = spaces.find(s => s.expressId === selectedSpace);
      
      setSuccess(`✓ Mapped "${device?.device_name || device?.uuid}" to "${space?.name}"`);
      setSelectedDevice(null);
      setSelectedSpace(null);
      
      // Reload data and notify parent
      await loadData();
      onMappingChange?.();
    } catch (err: any) {
      console.error('Failed to map device:', err);
      setError(err.response?.data?.message || 'Failed to map device');
    } finally {
      setMapping(false);
    }
  };

  const handleUnmapDevice = async (deviceUuid: string) => {
    try {
      setError(null);
      setSuccess(null);

      await axios.delete(
        `${API_BASE_URL}/api/v1/digital-twin/graph/map-device/${deviceUuid}`
      );

      const mapping = mappings.find(m => m.deviceUuid === deviceUuid);
      setSuccess(`✓ Unmapped device from "${mapping?.spaceName}"`);
      
      // Reload data and notify parent
      await loadData();
      onMappingChange?.();
    } catch (err: any) {
      console.error('Failed to unmap device:', err);
      setError(err.response?.data?.message || 'Failed to unmap device');
    }
  };

  const getDeviceMapping = (deviceUuid: string): DeviceMapping | undefined => {
    return mappings.find(m => m.deviceUuid === deviceUuid);
  };

  const formatLastSeen = (lastEvent: string | null): string => {
    if (!lastEvent) return 'Never';
    
    const diff = Date.now() - new Date(lastEvent).getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div 
            className="w-12 h-12 border-4 border-t-transparent rounded-full animate-spin mx-auto mb-3"
            style={{ borderColor: '#4C8EDA', borderTopColor: 'transparent' }}
          />
          <p style={{ color: '#94a3b8' }}>Loading devices...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" style={{ background: '#1a1a1a' }}>
      {/* Header */}
      <div className="px-6 py-4 border-b" style={{ borderColor: '#2d3748' }}>
        <h3 className="text-lg font-semibold flex items-center gap-2" style={{ color: '#e2e8f0' }}>
          <MapPin className="w-5 h-5" />
          Device Mapping
        </h3>
        <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
          {devices.length} devices, {mappings.length} mapped
        </p>
      </div>

      {/* Notifications */}
      {error && (
        <div 
          className="mx-6 mt-4 p-3 rounded-lg flex items-start gap-2"
          style={{ background: '#3a1e1e', border: '1px solid #7f1d1d' }}
        >
          <XCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#f87171' }} />
          <div className="flex-1">
            <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>
          </div>
          <button 
            onClick={() => setError(null)}
            className="text-sm hover:opacity-70"
            style={{ color: '#f87171' }}
          >
            ×
          </button>
        </div>
      )}

      {success && (
        <div 
          className="mx-6 mt-4 p-3 rounded-lg flex items-start gap-2"
          style={{ background: '#1e3a1e', border: '1px solid #166534' }}
        >
          <CheckCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#4ade80' }} />
          <div className="flex-1">
            <p className="text-sm" style={{ color: '#4ade80' }}>{success}</p>
          </div>
          <button 
            onClick={() => setSuccess(null)}
            className="text-sm hover:opacity-70"
            style={{ color: '#4ade80' }}
          >
            ×
          </button>
        </div>
      )}

      {/* Mapping Form */}
      <div className="p-6 border-b" style={{ borderColor: '#2d3748' }}>
        <div className="space-y-4">
          {/* Device Selection */}
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: '#cbd5e0' }}>
              Select Device
            </label>
            <select
              value={selectedDevice || ''}
              onChange={(e) => {
                setSelectedDevice(e.target.value || null);
                setError(null);
              }}
              className="w-full px-3 py-2 rounded-lg text-sm"
              style={{
                background: '#2d3748',
                color: '#e2e8f0',
                border: '1px solid #4a5568',
              }}
            >
              <option value="">Choose a device...</option>
              {devices.map((device) => {
                const mapping = getDeviceMapping(device.uuid);
                const displayName = device.device_name || device.uuid.substring(0, 8);
                const status = device.is_online ? '🟢' : '🔴';
                const mappedText = mapping ? ` (mapped to ${mapping.spaceName})` : '';
                
                return (
                  <option key={device.uuid} value={device.uuid}>
                    {status} {displayName}{mappedText}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Space Selection */}
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: '#cbd5e0' }}>
              Select Space
            </label>
            <select
              value={selectedSpace || ''}
              onChange={(e) => setSelectedSpace(e.target.value ? parseInt(e.target.value) : null)}
              className="w-full px-3 py-2 rounded-lg text-sm"
              style={{
                background: '#2d3748',
                color: '#e2e8f0',
                border: '1px solid #4a5568',
              }}
            >
              <option value="">Choose a space...</option>
              {spaces.map((space) => (
                <option key={space.expressId} value={space.expressId}>
                  {space.name}
                </option>
              ))}
            </select>
          </div>

          {/* Map Button */}
          <button
            onClick={handleMapDevice}
            disabled={!selectedDevice || !selectedSpace || mapping}
            className="w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            style={{
              background: '#4C8EDA',
              color: '#fff',
            }}
          >
            {mapping ? 'Mapping...' : 'Map Device to Space'}
          </button>
        </div>
      </div>

      {/* Device List */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="space-y-3">
          {devices.length === 0 ? (
            <div className="text-center py-8">
              <Cpu className="w-12 h-12 mx-auto mb-3" style={{ color: '#4a5568' }} />
              <p className="text-sm" style={{ color: '#94a3b8' }}>
                No devices found
              </p>
            </div>
          ) : (
            devices.map((device) => {
              const mapping = getDeviceMapping(device.uuid);
              const displayName = device.device_name || device.uuid.substring(0, 8);
              
              return (
                <div
                  key={device.uuid}
                  className="p-4 rounded-lg border"
                  style={{
                    background: '#2d3748',
                    borderColor: device.is_online ? '#166534' : '#4a5568',
                  }}
                >
                  {/* Device Header */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-start gap-3 flex-1">
                      {/* Status Indicator */}
                      <div className="mt-1">
                        {device.is_online ? (
                          <Wifi className="w-5 h-5" style={{ color: '#4ade80' }} />
                        ) : (
                          <WifiOff className="w-5 h-5" style={{ color: '#94a3b8' }} />
                        )}
                      </div>

                      {/* Device Info */}
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <Cpu className="w-4 h-4" style={{ color: '#94a3b8' }} />
                          <span className="font-medium" style={{ color: '#e2e8f0' }}>
                            {displayName}
                          </span>
                          <span 
                            className="text-xs px-2 py-0.5 rounded"
                            style={{
                              background: device.is_online ? '#1e3a1e' : '#1a1a1a',
                              color: device.is_online ? '#4ade80' : '#94a3b8',
                            }}
                          >
                            {device.is_online ? 'Online' : 'Offline'}
                          </span>
                        </div>

                        {/* Device Details */}
                        <div className="text-xs space-y-1" style={{ color: '#94a3b8' }}>
                          {device.device_type && (
                            <div>Type: {device.device_type}</div>
                          )}
                          <div className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            Last seen: {formatLastSeen(device.last_connectivity_event)}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Mapping Status */}
                  {mapping ? (
                    <div className="flex items-center justify-between pt-3 border-t" style={{ borderColor: '#4a5568' }}>
                      <div className="flex items-center gap-2">
                        <MapPin className="w-4 h-4" style={{ color: '#4ade80' }} />
                        <span className="text-sm" style={{ color: '#cbd5e0' }}>
                          Mapped to: <span style={{ color: '#e2e8f0' }}>{mapping.spaceName}</span>
                        </span>
                      </div>
                      <button
                        onClick={() => handleUnmapDevice(device.uuid)}
                        className="text-xs px-3 py-1 rounded hover:opacity-80 transition-opacity"
                        style={{
                          background: '#7f1d1d',
                          color: '#f87171',
                        }}
                      >
                        Unmap
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 pt-3 border-t" style={{ borderColor: '#4a5568' }}>
                      <AlertCircle className="w-4 h-4" style={{ color: '#94a3b8' }} />
                      <span className="text-xs" style={{ color: '#94a3b8' }}>
                        Not mapped to any space
                      </span>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
