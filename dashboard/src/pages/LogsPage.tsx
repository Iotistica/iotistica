/**
 * Logs Page Component
 * 
 * Displays all device logs with filtering by:
 * - Service name
 * - Date range
 * - Log level (ERROR, WARN, INFO)
 */

import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Terminal, RefreshCw, Download, Pause, Play, Calendar } from "lucide-react";

interface LogEntry {
  id?: number;
  device_uuid: string;
  service_name: string;
  message: string;
  timestamp: string;
  is_stderr: boolean;
  is_system: boolean;
}

interface LogsPageProps {
  deviceUuid: string;
}

export function LogsPage({ deviceUuid }: LogsPageProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const [selectedService, setSelectedService] = useState<string>("all");
  const [serviceOptions, setServiceOptions] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<string>("last7days");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
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

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Fetch historical logs based on date range
  const fetchHistoricalLogs = async () => {
    if (!deviceUuid || !dateFrom || !dateTo) return;
    
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
      
      const response = await fetch(`http://localhost:4002/api/v1/devices/${deviceUuid}/logs?${params}`);
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
        const response = await fetch(`http://localhost:4002/api/v1/devices/${deviceUuid}/logs/services`);
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
  
  // Fetch historical logs when date range or service changes
  useEffect(() => {
    if (dateFrom && dateTo) {
      fetchHistoricalLogs();
    }
  }, [dateFrom, dateTo, selectedService, deviceUuid]);

  // WebSocket connection for real-time log streaming
  useEffect(() => {
    if (!deviceUuid) return;

    setIsLoading(true);
    
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.hostname;
    const wsPort = import.meta.env.VITE_API_PORT || '4002';
    const wsUrl = `${wsProtocol}//${wsHost}:${wsPort}/ws?deviceUuid=${deviceUuid}`;

    console.log('[LogsPage] Connecting to WebSocket:', wsUrl);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[LogsPage] WebSocket connected');
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
          console.log('[LogsPage] Received logs:', message.data.logs.length);
          
          setLogs(prev => {
            // Append new logs and keep last 500
            const combined = [...prev, ...message.data.logs];
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
      setIsLoading(false);
    };

    ws.onclose = () => {
      console.log('[LogsPage] WebSocket disconnected');
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
  }, [deviceUuid, selectedService]);

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
    fetchHistoricalLogs();
  };

  const handleTogglePause = () => {
    setIsPaused(prev => {
      const newPauseState = !prev;
      
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        if (newPauseState) {
          console.log('[LogsPage] Pausing log stream');
          wsRef.current.send(JSON.stringify({
            type: 'unsubscribe',
            channel: 'logs',
          }));
        } else {
          console.log('[LogsPage] Resuming log stream');
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
      const fromDate = new Date(dateFrom);
      if (logDate < fromDate) return false;
    }
    if (dateTo) {
      const logDate = new Date(log.timestamp);
      const toDate = new Date(dateTo);
      toDate.setHours(23, 59, 59, 999); // End of day
      if (logDate > toDate) return false;
    }
    return true;
  });

  return (
    <Card className="border-2 h-full flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Terminal className="h-6 w-6 text-muted-foreground" />
            <div>
              <CardTitle>Agent Logs</CardTitle>
              <CardDescription>
                Real-time logs from all agent services
              </CardDescription>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAutoScroll(!autoScroll)}
              className={autoScroll ? 'bg-green-50 border-green-200' : ''}
            >
              <Badge variant={autoScroll ? "default" : "secondary"} className="text-xs">
                {autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
              </Badge>
            </Button>
            
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
            
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={isLoading}
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
            
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

          {/* Date Range Preset */}
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

          {/* Date From */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">From:</span>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setDateRange("custom"); // Switch to custom when manually changed
              }}
              className="w-40"
            />
          </div>

          {/* Date To */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">To:</span>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setDateRange("custom"); // Switch to custom when manually changed
              }}
              className="w-40"
            />
          </div>

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

          {/* Log Count Badge */}
          <Badge className="bg-blue-100 dark:bg-blue-900 text-black dark:text-blue-100 border border-blue-200 dark:border-blue-800">
            {filteredLogs.length} lines
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex-1 overflow-hidden">
        {/* Log Output */}
        <div 
          ref={logContainerRef}
          className="bg-black rounded-lg p-4 font-mono text-sm overflow-auto h-full"
          style={{ 
            backgroundColor: '#1e1e1e',
          }}
          onScroll={() => {
            if (logContainerRef.current) {
              const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
              if (scrollTop + clientHeight < scrollHeight - 50) {
                setAutoScroll(false);
              } else {
                setAutoScroll(true);
              }
            }
          }}
        >
          {filteredLogs.length === 0 && !isLoading && (
            <div className="text-gray-500 text-center py-8">
              No logs available
            </div>
          )}
          
          {filteredLogs.map((log, index) => {
            const isActualError = /\[error\]|\[crit\]|\[alert\]|\[emerg\]|ERROR|FATAL|CRITICAL/i.test(log.message);
            const isWarning = /\[warn\]|WARNING/i.test(log.message);
            const isNotice = /\[notice\]|INFO/i.test(log.message);
            
            let messageColor = '#9ca3af';
            let levelBadge = null;
            
            if (isActualError) {
              messageColor = '#fca5a5';
              levelBadge = <span className="ml-2 font-semibold" style={{ color: '#f87171' }}>ERROR</span>;
            } else if (isWarning) {
              messageColor = '#fcd34d';
              levelBadge = <span className="ml-2 font-semibold" style={{ color: '#fbbf24' }}>WARN</span>;
            } else if (isNotice) {
              messageColor = '#93c5fd';
              levelBadge = <span className="ml-2 font-semibold" style={{ color: '#60a5fa' }}>INFO</span>;
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
                <span className="ml-2 font-semibold" style={{ color: '#a78bfa' }}>
                  [{log.service_name}]
                </span>
                {levelBadge}
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
  );
}
