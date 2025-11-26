/**
 * Analytics Page - Device Traffic Analytics
 * 
 * Displays device-specific traffic analytics including:
 * - Device traffic breakdown
 * - Inbound/Outbound traffic charts by endpoint
 * - Per-device usage metrics
 */

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { Badge } from "@/components/ui/badge";
import { Smartphone, ArrowDownToLine, ArrowUpFromLine, Radio } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { buildApiUrl } from "@/config/api";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

interface DeviceTrafficStats {
  deviceId: string;
  endpoint: string;
  method: string;
  count: number;
  totalBytes: number;
  totalTime: number;
  avgSize: number;
  avgTime: number;
  success: number;
  failed: number;
  statuses: Record<number, number>;
}

interface MqttTopicStats {
  topic: string;
  messageCount: number;
  bytesReceived: number;
  avgMessageSize: number;
  lastActivity: string;
}

interface Device {
  id: string;
  deviceUuid: string;
  name: string;
  status: string;
}

interface AnalyticsPageProps {
  device?: Device;
}

export function AnalyticsPage({ device }: AnalyticsPageProps) {
  const [deviceTraffic, setDeviceTraffic] = useState<DeviceTrafficStats[]>([]);
  // Default to selected device's UUID if available, otherwise "all"
  const [selectedDevice, setSelectedDevice] = useState<string>(device?.deviceUuid || "all");
  const [mqttTopics, setMqttTopics] = useState<MqttTopicStats[]>([]);
  const [mqttCurrentPage, setMqttCurrentPage] = useState(1);
  const [httpCurrentPage, setHttpCurrentPage] = useState(1);
  const itemsPerPage = 10;

  // Update selectedDevice when the device prop changes
  useEffect(() => {
    if (device?.deviceUuid) {
      setSelectedDevice(device.deviceUuid);
    }
  }, [device?.deviceUuid]);

  useEffect(() => {
    // Fetch device traffic stats
    const fetchDeviceTraffic = async () => {
      try {
        const response = await fetch(buildApiUrl('/api/v1/traffic-stats'));
        if (response.ok) {
          const data = await response.json();
          console.log('Device traffic data:', data);
          setDeviceTraffic(data);
        } else {
          console.error('Failed to fetch device traffic:', response.status, await response.text());
        }
      } catch (error) {
        console.error('Failed to fetch device traffic:', error);
      }
    };

    // Fetch MQTT traffic stats
    const fetchMqttTraffic = async () => {
      try {
        const response = await fetch(buildApiUrl('/api/v1/traffic-stats/mqtt?limit=20&sortBy=bytes_received'));
        if (response.ok) {
          const data = await response.json();
          console.log('MQTT traffic data:', data);
          if (data.success) {
            setMqttTopics(data.topics || []);
          }
        } else {
          console.error('Failed to fetch MQTT traffic:', response.status, await response.text());
        }
      } catch (error) {
        console.error('Failed to fetch MQTT traffic:', error);
      }
    };

    fetchDeviceTraffic();
    fetchMqttTraffic();
    
    const interval = setInterval(() => {
      fetchDeviceTraffic();
      fetchMqttTraffic();
    }, 30000); // Refresh every 30s
    
    return () => {
      clearInterval(interval);
    };
  }, []);

  // Get unique devices for filter dropdown
  const uniqueDevices = Array.from(new Set(deviceTraffic.map(t => t.deviceId)));

  // Filter device traffic by selected device
  const filteredDeviceTraffic = selectedDevice === "all" 
    ? deviceTraffic 
    : deviceTraffic.filter(t => t.deviceId === selectedDevice);

  // Filter MQTT topics by device (if topic contains device ID)
  const filteredMqttTopics = selectedDevice === "all"
    ? mqttTopics
    : mqttTopics.filter(t => t.topic.includes(selectedDevice));

  // MQTT Pagination
  const mqttTotalPages = Math.ceil(filteredMqttTopics.length / itemsPerPage);
  const mqttStartIndex = (mqttCurrentPage - 1) * itemsPerPage;
  const mqttEndIndex = mqttStartIndex + itemsPerPage;
  const paginatedMqttTopics = filteredMqttTopics.slice(mqttStartIndex, mqttEndIndex);

  // HTTP Pagination
  const httpTotalPages = Math.ceil(filteredDeviceTraffic.length / itemsPerPage);
  const httpStartIndex = (httpCurrentPage - 1) * itemsPerPage;
  const httpEndIndex = httpStartIndex + itemsPerPage;
  const paginatedDeviceTraffic = filteredDeviceTraffic.slice(httpStartIndex, httpEndIndex);

  // Always recalculate MQTT summary for filtered topics (even for "all")
  const totalMessages = filteredMqttTopics.reduce((sum, t) => sum + t.messageCount, 0);
  const totalBytes = filteredMqttTopics.reduce((sum, t) => sum + t.bytesReceived, 0);
  
  const filteredMqttSummary = {
    totalTopics: filteredMqttTopics.length,
    totalMessages,
    totalBytes,
    avgMessageSize: totalMessages > 0 ? Math.round(totalBytes / totalMessages) : 0
  };

  // Calculate totals for inbound and outbound traffic
  const inboundTraffic = filteredDeviceTraffic.filter(t => t.method === 'GET');
  const outboundTraffic = filteredDeviceTraffic.filter(t => t.method !== 'GET');
  
  const totalInbound = inboundTraffic.reduce((sum, t) => sum + t.totalBytes, 0);
  const totalOutbound = outboundTraffic.reduce((sum, t) => sum + t.totalBytes, 0);
  
  const inboundCount = inboundTraffic.reduce((sum, t) => sum + t.count, 0);
  const outboundCount = outboundTraffic.reduce((sum, t) => sum + t.count, 0);
  
  const avgInbound = inboundCount > 0 ? totalInbound / inboundCount : 0;
  const avgOutbound = outboundCount > 0 ? totalOutbound / outboundCount : 0;

  // Format bytes with smart unit selection
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    
    // Always use MB for values >= 1 MB
    if (bytes >= k * k) {
      const megabytes = bytes / (k * k);
      return `${megabytes.toFixed(2)} MB`;
    }
    
    // Use KB for smaller values
    if (bytes >= k) {
      const kilobytes = bytes / k;
      return `${kilobytes.toFixed(2)} KB`;
    }
    
    // Use bytes for very small values
    return `${bytes.toFixed(0)} B`;
  };

  // Format time in ms
  const formatTime = (ms: number): string => {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  // Get method badge color
  const getMethodColor = (method?: string) => {
    switch (method) {
      case 'GET':
        return 'bg-blue-100 text-blue-700 border-blue-200';
      case 'POST':
        return 'bg-green-100 text-green-700 border-green-200';
      case 'PUT':
      case 'PATCH':
        return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      case 'DELETE':
        return 'bg-red-100 text-red-700 border-red-200';
      default:
        return 'bg-gray-100 text-gray-700 border-gray-200';
    }
  };

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Device Analytics</h1>
            <p className="text-sm text-muted-foreground">
              Monitor device traffic patterns and endpoint usage
            </p>
          </div>
          
          {/* Device Filter */}
          <div className="flex items-center gap-3 min-w-[280px]">
            <Smartphone className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            <Select value={selectedDevice} onValueChange={setSelectedDevice}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Filter by device" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Devices</SelectItem>
                {uniqueDevices.map((deviceId) => (
                  <SelectItem key={deviceId} value={deviceId}>
                    {deviceId.substring(0, 8)}...{deviceId.substring(deviceId.length - 4)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Traffic Summary Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="HTTP Inbound"
            value={formatBytes(totalInbound)}
            subtitle={`Avg: ${formatBytes(avgInbound)}`}
            icon={ArrowDownToLine}
            iconColor="blue"
          />

          <MetricCard
            label="HTTP Outbound"
            value={formatBytes(totalOutbound)}
            subtitle={`Avg: ${formatBytes(avgOutbound)}`}
            icon={ArrowUpFromLine}
            iconColor="green"
          />

          <MetricCard
            label="MQTT Inbound"
            value={formatBytes(filteredMqttSummary.totalBytes)}
            subtitle={`Avg: ${formatBytes(filteredMqttSummary.avgMessageSize)}`}
            icon={Radio}
            iconColor="purple"
          />

          <MetricCard
            label="MQTT Messages"
            value={filteredMqttSummary.totalMessages.toLocaleString()}
            subtitle={`${filteredMqttSummary.totalTopics} topics`}
            icon={Radio}
            iconColor="orange"
          />
        </div>

        {/* MQTT Topics Table */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>MQTT Topic Traffic</CardTitle>
                <CardDescription>
                  {filteredMqttTopics.length === 0 
                    ? selectedDevice === "all" 
                      ? 'No MQTT traffic tracked yet' 
                      : 'No MQTT topics found for this device'
                    : `Showing ${mqttStartIndex + 1}-${Math.min(mqttEndIndex, filteredMqttTopics.length)} of ${filteredMqttTopics.length} topics`}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Radio className="h-5 w-5 text-purple-600" />
                <span className="text-sm font-medium text-muted-foreground">MQTT</span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {filteredMqttTopics.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Radio className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-lg font-medium mb-2">
                  {selectedDevice === "all" ? 'No MQTT data yet' : 'No MQTT topics for this device'}
                </p>
                <p className="text-sm mb-2">
                  {selectedDevice === "all" 
                    ? 'MQTT topic traffic will appear here when messages are published'
                    : 'This device has no MQTT topics containing its ID'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Data is collected from mqtt_topic_metrics table
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Topic</th>
                      <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Messages</th>
                      <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Total Bytes</th>
                      <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Avg Size</th>
                      <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Last Activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedMqttTopics.map((topic) => (
                      <tr 
                        key={topic.topic}
                        className="border-b border-border hover:bg-muted transition-colors"
                      >
                        <td className="py-3 px-4 font-mono text-sm text-foreground max-w-md" title={topic.topic}>
                          {topic.topic}
                        </td>
                        <td className="py-3 px-4 text-right text-foreground">
                          {topic.messageCount.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-right text-foreground font-medium">
                          {formatBytes(topic.bytesReceived)}
                        </td>
                        <td className="py-3 px-4 text-right text-muted-foreground">
                          {formatBytes(topic.avgMessageSize)}
                        </td>
                        <td className="py-3 px-4 text-right text-xs text-muted-foreground">
                          {new Date(topic.lastActivity).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            
            {/* MQTT Pagination */}
            {filteredMqttTopics.length > itemsPerPage && (
              <div className="mt-6">
                <Pagination>
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious 
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setMqttCurrentPage(prev => Math.max(1, prev - 1));
                        }}
                        className={mqttCurrentPage === 1 ? 'pointer-events-none opacity-50' : ''}
                      />
                    </PaginationItem>
                    
                    {mqttCurrentPage > 2 && (
                      <PaginationItem>
                        <PaginationLink
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setMqttCurrentPage(1);
                          }}
                        >
                          1
                        </PaginationLink>
                      </PaginationItem>
                    )}
                    
                    {mqttCurrentPage > 3 && (
                      <PaginationItem>
                        <PaginationEllipsis />
                      </PaginationItem>
                    )}
                    
                    {mqttCurrentPage > 1 && (
                      <PaginationItem>
                        <PaginationLink
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setMqttCurrentPage(mqttCurrentPage - 1);
                          }}
                        >
                          {mqttCurrentPage - 1}
                        </PaginationLink>
                      </PaginationItem>
                    )}
                    
                    <PaginationItem>
                      <PaginationLink href="#" isActive>
                        {mqttCurrentPage}
                      </PaginationLink>
                    </PaginationItem>
                    
                    {mqttCurrentPage < mqttTotalPages && (
                      <PaginationItem>
                        <PaginationLink
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setMqttCurrentPage(mqttCurrentPage + 1);
                          }}
                        >
                          {mqttCurrentPage + 1}
                        </PaginationLink>
                      </PaginationItem>
                    )}
                    
                    {mqttCurrentPage < mqttTotalPages - 2 && (
                      <PaginationItem>
                        <PaginationEllipsis />
                      </PaginationItem>
                    )}
                    
                    {mqttCurrentPage < mqttTotalPages - 1 && (
                      <PaginationItem>
                        <PaginationLink
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setMqttCurrentPage(mqttTotalPages);
                          }}
                        >
                          {mqttTotalPages}
                        </PaginationLink>
                      </PaginationItem>
                    )}
                    
                    <PaginationItem>
                      <PaginationNext 
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setMqttCurrentPage(prev => Math.min(mqttTotalPages, prev + 1));
                        }}
                        className={mqttCurrentPage === mqttTotalPages ? 'pointer-events-none opacity-50' : ''}
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Device Traffic Table */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>HTTP Device Traffic Details</CardTitle>
                <CardDescription>
                  {deviceTraffic.length === 0 
                    ? 'No device traffic tracked yet' 
                    : `Showing ${httpStartIndex + 1}-${Math.min(httpEndIndex, filteredDeviceTraffic.length)} of ${filteredDeviceTraffic.length} endpoints`}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {deviceTraffic.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Smartphone className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-lg font-medium mb-2">No device data yet</p>
                <p className="text-sm mb-2">Device traffic will appear here when devices make API requests</p>
                <p className="text-xs text-muted-foreground">
                  Note: Only tracks requests with X-Device-API-Key or Authorization headers
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Device ID</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Method</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Endpoint</th>
                      <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Requests</th>
                      <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Success</th>
                      <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Failed</th>
                      <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Total Size</th>
                      <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Avg Size</th>
                      <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Avg Time</th>
                      <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Status Codes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedDeviceTraffic.map((traffic) => {
                      const statusCodes = Object.entries(traffic.statuses || {})
                        .sort(([a], [b]) => Number(a) - Number(b))
                        .map(([code, count]) => `${code}:${count}`)
                        .join(', ');

                      return (
                        <tr 
                          key={`${traffic.deviceId}-${traffic.method}-${traffic.endpoint}`}
                          className="border-b border-border hover:bg-muted transition-colors"
                        >
                          <td className="py-3 px-4 font-mono text-xs text-foreground" title={traffic.deviceId}>
                            {traffic.deviceId.substring(0, 8)}...
                          </td>
                          <td className="py-3 px-4">
                            <Badge variant="outline" className={getMethodColor(traffic.method)}>
                              {traffic.method || 'GET'}
                            </Badge>
                          </td>
                          <td className="py-3 px-4 font-mono text-sm text-foreground max-w-md truncate" title={traffic.endpoint}>
                            {traffic.endpoint}
                          </td>
                          <td className="py-3 px-4 text-right text-foreground">
                            {traffic.count}
                          </td>
                          <td className="py-3 px-4 text-right text-green-600 font-medium">
                            {traffic.success || 0}
                          </td>
                          <td className="py-3 px-4 text-right text-red-600 font-medium">
                            {traffic.failed || 0}
                          </td>
                          <td className="py-3 px-4 text-right text-foreground font-medium">
                            {formatBytes(traffic.totalBytes)}
                          </td>
                          <td className="py-3 px-4 text-right text-muted-foreground">
                            {formatBytes(traffic.avgSize)}
                          </td>
                          <td className="py-3 px-4 text-right text-muted-foreground">
                            {formatTime(traffic.avgTime)}
                          </td>
                          <td className="py-3 px-4 text-right text-xs font-mono text-muted-foreground">
                            {statusCodes || '-'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            
            {/* HTTP Pagination */}
            {filteredDeviceTraffic.length > itemsPerPage && (
              <div className="mt-6">
                <Pagination>
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious 
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setHttpCurrentPage(prev => Math.max(1, prev - 1));
                        }}
                        className={httpCurrentPage === 1 ? 'pointer-events-none opacity-50' : ''}
                      />
                    </PaginationItem>
                    
                    {httpCurrentPage > 2 && (
                      <PaginationItem>
                        <PaginationLink
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setHttpCurrentPage(1);
                          }}
                        >
                          1
                        </PaginationLink>
                      </PaginationItem>
                    )}
                    
                    {httpCurrentPage > 3 && (
                      <PaginationItem>
                        <PaginationEllipsis />
                      </PaginationItem>
                    )}
                    
                    {httpCurrentPage > 1 && (
                      <PaginationItem>
                        <PaginationLink
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setHttpCurrentPage(httpCurrentPage - 1);
                          }}
                        >
                          {httpCurrentPage - 1}
                        </PaginationLink>
                      </PaginationItem>
                    )}
                    
                    <PaginationItem>
                      <PaginationLink href="#" isActive>
                        {httpCurrentPage}
                      </PaginationLink>
                    </PaginationItem>
                    
                    {httpCurrentPage < httpTotalPages && (
                      <PaginationItem>
                        <PaginationLink
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setHttpCurrentPage(httpCurrentPage + 1);
                          }}
                        >
                          {httpCurrentPage + 1}
                        </PaginationLink>
                      </PaginationItem>
                    )}
                    
                    {httpCurrentPage < httpTotalPages - 2 && (
                      <PaginationItem>
                        <PaginationEllipsis />
                      </PaginationItem>
                    )}
                    
                    {httpCurrentPage < httpTotalPages - 1 && (
                      <PaginationItem>
                        <PaginationLink
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setHttpCurrentPage(httpTotalPages);
                          }}
                        >
                          {httpTotalPages}
                        </PaginationLink>
                      </PaginationItem>
                    )}
                    
                    <PaginationItem>
                      <PaginationNext 
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setHttpCurrentPage(prev => Math.min(httpTotalPages, prev + 1));
                        }}
                        className={httpCurrentPage === httpTotalPages ? 'pointer-events-none opacity-50' : ''}
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
