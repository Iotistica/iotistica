/**
 * Logs Page Component
 * 
 * Displays all device logs with filtering by:
 * - Service name
 * - Date range
 * - Log level (ERROR, WARN, INFO)
 */

import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { RefreshCw, Download, Pause, Play, Calendar } from "lucide-react";
import { buildApiUrl } from '@/config/api';

interface LogEntry {
  id?: number;
  device_uuid: string;
  service_name: string;
  message: string;
  timestamp: string;
  level?: string;
  is_stderr: boolean;
  is_system: boolean;
}

interface LogsPageProps {
  deviceUuid: string;
}

export function LogsPage({ deviceUuid }: LogsPageProps) {
  const [mode, setMode] = useState<'live' | 'historical'>('live');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [selectedService, setSelectedService] = useState<string>("all");
  const [serviceOptions, setServiceOptions] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<string>("last7days");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [wsConnected, setWsConnected] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Initialize date range to "Last 7 Days" on mount
  useEffect(() => {
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(now.getDate() - 7);
    setDateFrom(sevenDaysAgo.toISOString().split('T')[0]);
    setDateTo(now.toISOString().split('T')[0]);
  }, []);

  // Clear logs when device changes
  useEffect(() => {
    setLogs([]);
    setIsLoading(false);
  }, [deviceUuid]);

  // Auto-scroll to bottom when new logs arrive in live mode
  useEffect(() => {
    if (mode === 'live' && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, mode]);

  // Fetch historical logs based on date range
  const fetchHistoricalLogs = async () => {
    if (!deviceUuid || !dateFrom || !dateTo || mode !== 'historical') return;
    
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        from: dateFrom,
        to: dateTo,
        limit: '1000'
      });
      
      if (selectedService !== 'all') {
        params.append('service', selectedService);
      }
      
      const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/logs?${params}`));
      if (response.ok) {
        const data = await response.json();
        setLogs(data.logs || []);
      } 
    } catch (error) {
      console.error('[LogsPage] Error fetching historical logs:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch list of available services
  useEffect(() => {
    const fetchServices = async () => {
      try {
        const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/logs/services`));
        if (response.ok) {
          const data = await response.json();
          setServiceOptions(data.services || []);
        }
      } catch (error) {
        console.error('[LogsPage] Error fetching services:', error);
      }
    };

    if (deviceUuid) {
      fetchServices();
    }
  }, [deviceUuid]);
  
  // Fetch historical logs when in historical mode and filters change
  useEffect(() => {
    if (mode === 'historical' && dateFrom && dateTo) {
      fetchHistoricalLogs();
    }
  }, [mode, dateFrom, dateTo, selectedService, deviceUuid]);

  // WebSocket connection for real-time log streaming (Live mode only)
  useEffect(() => {
    if (!deviceUuid || mode !== 'live') return;

    setIsLoading(true);
    
    const wsUrl = buildApiUrl(`/ws?deviceUuid=${deviceUuid}`).replace(/^http/, 'ws');

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {

      setWsConnected(true);
      ws.send(JSON.stringify({
        type: 'subscribe',
        channel: 'logs',
        serviceName: selectedService === 'all' ? undefined : selectedService,
      }));
      setIsLoading(false);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        
        if (message.type === 'logs' && message.data?.logs) {
      
          // Normalize field names from WebSocket (camelCase) to match database format (snake_case)
          const normalizedLogs = message.data.logs.map((log: any) => ({
            ...log,
            service_name: log.service_name || log.serviceName,
            device_uuid: log.device_uuid || log.deviceUuid,
            level: log.level,
            is_stderr: log.is_stderr ?? log.isStderr,
            is_system: log.is_system ?? log.isSystem,
          }));
          
          setLogs(prev => {
            // Append new logs and keep last 500
            const combined = [...prev, ...normalizedLogs];
            const unique = Array.from(
              new Map(combined.map(log => [log.id || log.timestamp, log])).values()
            );
            return unique.slice(-500);
          });
        }
      } catch (error) {
        console.error('[LogsPage] Error parsing WebSocket message:', error);
      }
    };

    ws.onerror = (error) => {
      console.error('[LogsPage] WebSocket error:', error);
      setWsConnected(false);
      setIsLoading(false);
    };

    ws.onclose = () => {
      setWsConnected(false);
      setIsLoading(false);
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'unsubscribe',
          channel: 'logs',
        }));
      }
      ws.close();
      wsRef.current = null;
    };
  }, [deviceUuid, selectedService, mode]);

  // Handle service filter change
  const handleServiceChange = (value: string) => {
    setSelectedService(value);
    setLogs([]); // Clear logs when switching services
    
    // Reconnect WebSocket with new filter
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'unsubscribe',
        channel: 'logs',
      }));
      wsRef.current.send(JSON.stringify({
        type: 'subscribe',
        channel: 'logs',
        serviceName: value === 'all' ? undefined : value,
      }));
    }
  };

  const handleRefresh = () => {
    setLogs([]);
    if (mode === 'historical') {
      fetchHistoricalLogs();
    }
  };

  const handleModeChange = (newMode: 'live' | 'historical') => {
    setMode(newMode);
    setLogs([]);
    if (newMode === 'live') {
      setIsPaused(false);
    }
  };

  const handleTogglePause = () => {
    setIsPaused(prev => {
      const newPauseState = !prev;
      
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        if (newPauseState) {

          wsRef.current.send(JSON.stringify({
            type: 'unsubscribe',
            channel: 'logs',
          }));
        } else {
          wsRef.current.send(JSON.stringify({
            type: 'subscribe',
            channel: 'logs',
            serviceName: selectedService === 'all' ? undefined : selectedService,
          }));
        }
      }
      
      return newPauseState;
    });
  };

  const handleDateRangeChange = (range: string) => {
    setDateRange(range);
    const now = new Date();
    
    switch (range) {
      case 'today': {
        const today = now.toISOString().split('T')[0];
        setDateFrom(today);
        setDateTo(today);
        break;
      }
      case 'yesterday': {
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        const dateStr = yesterday.toISOString().split('T')[0];
        setDateFrom(dateStr);
        setDateTo(dateStr);
        break;
      }
      case 'last7days': {
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(now.getDate() - 7);
        setDateFrom(sevenDaysAgo.toISOString().split('T')[0]);
        setDateTo(now.toISOString().split('T')[0]);
        break;
      }
      case 'last30days': {
        const thirtyDaysAgo = new Date(now);
        thirtyDaysAgo.setDate(now.getDate() - 30);
        setDateFrom(thirtyDaysAgo.toISOString().split('T')[0]);
        setDateTo(now.toISOString().split('T')[0]);
        break;
      }
      case 'custom':
        // Leave dateFrom/dateTo as-is for manual selection
        break;
    }
  };

  const downloadLogs = () => {
    const logText = logs.map(log => 
      `[${formatTimestamp(log.timestamp)}] [${log.service_name}] ${log.message}`
    ).join('\n');
    
    const blob = new Blob([logText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `device-logs-${deviceUuid}-${new Date().toISOString()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    
    const dateStr = date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).split('/').reverse().join('-');
    
    const time = date.toLocaleTimeString('en-US', { 
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    
    const ms = date.getMilliseconds().toString().padStart(3, '0');
    return `${dateStr} ${time}.${ms}`;
  };

  // Filter logs by date if date filters are set
  const filteredLogs = logs.filter(log => {
    if (dateFrom) {
      const logDate = new Date(log.timestamp);
      // Parse dateFrom as UTC midnight to match log timestamps
      const fromDate = new Date(dateFrom + 'T00:00:00.000Z');
      if (logDate < fromDate) return false;
    }
    if (dateTo) {
      const logDate = new Date(log.timestamp);
      // Parse dateTo as UTC end-of-day to match log timestamps
      const toDate = new Date(dateTo + 'T23:59:59.999Z');
      if (logDate > toDate) return false;
    }
    return true;
  });


  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6 min-h-full flex flex-col">
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-foreground mb-2">Agent Logs</h2>
          <p className="text-muted-foreground">
            {mode === 'live' 
              ? 'Real-time log streaming from agent services'
              : 'Historical log query with date range filtering'
            }
          </p>
        </div>

        <Card className="border-2 flex flex-col flex-1 min-h-[calc(100vh-280px)]">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {/* Left side - placeholder for future controls */}
              </div>
              
              <div className="flex items-center gap-2">
                {/* Mode Toggle */}
                <div className="flex border rounded-md">
                  <Button
                    variant={mode === 'live' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => handleModeChange('live')}
                    className="rounded-r-none"
                  >
                    Live
                  </Button>
                  <Button
                    variant={mode === 'historical' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => handleModeChange('historical')}
                    className="rounded-l-none"
                  >
                    Historical
                  </Button>
                </div>

                {/* WebSocket Connection Status - Live mode only */}
                {mode === 'live' && (
                  <Badge 
                    variant={wsConnected ? "default" : "secondary"}
                    className={wsConnected ? 'bg-green-500 text-white' : 'bg-gray-400 text-white'}
                  >
                    {wsConnected ? '🟢 Streaming' : '⚫ Disconnected'}
                  </Badge>
                )}
                
                {/* Pause/Resume - Live mode only */}
                {mode === 'live' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleTogglePause}
                    className={isPaused ? 'bg-yellow-50 border-yellow-200' : ''}
                  >
                    {isPaused ? (
                      <>
                        <Play className="h-4 w-4 mr-1" />
                        Resume
                      </>
                    ) : (
                      <>
                        <Pause className="h-4 w-4 mr-1" />
                        Pause
                      </>
                    )}
                  </Button>
                )}
                
                {/* Refresh - Historical mode only */}
                {mode === 'historical' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRefresh}
                    disabled={isLoading}
                  >
                    <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                  </Button>
                )}
                
                <Button
                  variant="outline"
                  size="sm"
                  onClick={downloadLogs}
                  disabled={filteredLogs.length === 0}
                >
                  <Download className="h-4 w-4" />
                </Button>
              </div>
            </div>

        {/* Filters */}
        <div className="flex items-center gap-3 mt-4 flex-wrap">
          {/* Service Filter */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Service:</span>
            <Select value={selectedService} onValueChange={handleServiceChange}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="All Services" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Services</SelectItem>
                {serviceOptions.map((service) => (
                  <SelectItem key={service} value={service}>
                    {service}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date Range Filters - Historical mode only */}
          {mode === 'historical' && (
            <>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Period:</span>
                <Select value={dateRange} onValueChange={handleDateRangeChange}>
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Today" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="yesterday">Yesterday</SelectItem>
                    <SelectItem value="last7days">Last 7 Days</SelectItem>
                    <SelectItem value="last30days">Last 30 Days</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">From:</span>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => {
                    setDateFrom(e.target.value);
                    setDateRange("custom");
                  }}
                  className="w-40"
                />
              </div>

              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">To:</span>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => {
                    setDateTo(e.target.value);
                    setDateRange("custom");
                  }}
                  className="w-40"
                />
              </div>
            </>
          )}

          {/* Clear Filters */}
          {(dateFrom || dateTo || selectedService !== 'all') && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDateFrom('');
                setDateTo('');
                setSelectedService('all');
              }}
            >
              Clear Filters
            </Button>
          )}

          {/* Spacer to push log count to the right */}
          <div className="flex-1"></div>

          {/* Log Count Badge */}
          <Badge className="bg-blue-600 dark:bg-blue-900 text-white dark:text-blue-100 border border-blue-700 dark:border-blue-800 font-medium">
            {filteredLogs.length} lines {mode === 'live' ? '(last 500)' : ''}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex-1 overflow-hidden p-6">
        {/* Log Output */}
        <div 
          ref={logContainerRef}
          className="bg-black rounded-lg p-4 font-mono text-sm overflow-y-auto"
          style={{ 
            backgroundColor: '#1e1e1e',
            height: 'calc(100vh - 450px)',
            minHeight: '400px',
          }}
        >
          {filteredLogs.length === 0 && !isLoading && (
            <div className="text-gray-500 text-center py-8">
              No logs available
            </div>
          )}
          
          {filteredLogs.map((log, index) => {
            const isActualError = /\[error\]|\[crit\]|\[alert\]|\[emerg\]|ERROR|FATAL|CRITICAL/i.test(log.message) || 
                                  log.level?.toLowerCase() === 'error';
            const isWarning = /\[warn\]|WARNING/i.test(log.message) || 
                              log.level?.toLowerCase() === 'warn';
            const isNotice = /\[notice\]|INFO/i.test(log.message) || 
                             log.level?.toLowerCase() === 'info';
            
            let messageColor = '#9ca3af';
            
            if (isActualError) {
              messageColor = '#fca5a5';
            } else if (isWarning) {
              messageColor = '#fcd34d';
            } else if (isNotice) {
              messageColor = '#93c5fd';
            } else if (!log.is_stderr) {
              messageColor = '#86efac';
            }
            
            return (
              <div 
                key={log.id || index}
                className="mb-1 hover:bg-gray-800 px-2 py-0.5 rounded"
                style={{ color: '#fff' }}
              >
                <span className="select-none" style={{ color: '#9ca3af' }}>
                  [{formatTimestamp(log.timestamp)}]
                </span>
                <span className="ml-2 font-semibold" style={{ 
                  color: isActualError ? '#f87171' : isWarning ? '#fbbf24' : isNotice ? '#60a5fa' : '#9ca3af' 
                }}>
                  [{(log.level || 'info').toUpperCase()}]
                </span>
                <span className="ml-2 font-semibold" style={{ color: '#a78bfa' }}>
                  [{log.service_name || 'unknown'}]
                </span>
                {log.is_system && (
                  <span className="ml-2 font-semibold" style={{ color: '#a78bfa' }}>SYSTEM</span>
                )}
                <span className="ml-2" style={{ color: messageColor }}>
                  {log.message}
                </span>
              </div>
            );
          })}
          
          {isLoading && filteredLogs.length === 0 && (
            <div className="text-gray-500 text-center py-8">
              Loading logs...
            </div>
          )}
        </div>
      </CardContent>
    </Card>
      </div>
    </div>
  );
}
