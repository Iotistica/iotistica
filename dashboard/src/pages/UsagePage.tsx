/**
 * Usage Page - API Endpoint Analytics
 * 
 * Displays real-time API usage statistics including:
 * - Total requests
 * - Total bandwidth
 * - Average response time
 * - Per-endpoint breakdown
 */

import { useEffect, useState } from "react";
import { apiTrafficTracker, EndpointStats, ApiTrafficMetrics } from "@/lib/apiTrafficTracker";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Activity, BarChart3, Clock, HardDrive, RefreshCw, TrendingUp } from "lucide-react";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

export function UsagePage() {
  const [globalMetrics, setGlobalMetrics] = useState<ApiTrafficMetrics>({
    count: 0,
    totalBytes: 0,
    totalTime: 0,
    avgSize: 0,
    avgTime: 0,
    success: 0,
    failed: 0,
  });
  const [endpoints, setEndpoints] = useState<EndpointStats[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  // Track metrics history for trend calculation
  const [metricsHistory, setMetricsHistory] = useState<{
    requests: number[];
    bandwidth: number[];
    responseTime: number[];
    successRate: number[];
  }>({
    requests: [],
    bandwidth: [],
    responseTime: [],
    successRate: [],
  });

  useEffect(() => {
    // Subscribe to global metrics and track history
    const unsubGlobal = apiTrafficTracker.subscribe((metrics) => {
      setGlobalMetrics(metrics);
      
      // Update metrics history (keep last 10 snapshots)
      setMetricsHistory(prev => {
        const successRate = metrics.count > 0 ? (metrics.success / metrics.count) * 100 : 0;
        return {
          requests: [...prev.requests, metrics.count].slice(-10),
          bandwidth: [...prev.bandwidth, metrics.totalBytes].slice(-10),
          responseTime: [...prev.responseTime, metrics.avgTime].slice(-10),
          successRate: [...prev.successRate, successRate].slice(-10),
        };
      });
    });
    
    // Subscribe to endpoint metrics
    const unsubEndpoints = apiTrafficTracker.subscribeEndpoints(setEndpoints);
    
    return () => {
      unsubGlobal();
      unsubEndpoints();
    };
  }, []);

  // Calculate trends from history
  const calculateTrend = (history: number[]): { trend: "up" | "down" | "neutral"; trendValue: string } => {
    if (history.length < 4) return { trend: "neutral", trendValue: "" };
    
    // Compare recent half vs older half
    const mid = Math.floor(history.length / 2);
    const olderHalf = history.slice(0, mid);
    const recentHalf = history.slice(mid);
    
    const avgOlder = olderHalf.reduce((sum, val) => sum + val, 0) / olderHalf.length;
    const avgRecent = recentHalf.reduce((sum, val) => sum + val, 0) / recentHalf.length;
    
    const change = avgRecent - avgOlder;
    const percentChange = avgOlder > 0 ? (change / avgOlder) * 100 : 0;
    
    if (Math.abs(percentChange) < 5) return { trend: "neutral", trendValue: "" };
    
    return {
      trend: change > 0 ? "up" : "down",
      trendValue: `${change > 0 ? "+" : ""}${percentChange.toFixed(1)}%`
    };
  };

  const requestsTrend = calculateTrend(metricsHistory.requests);
  const bandwidthTrend = calculateTrend(metricsHistory.bandwidth);
  const responseTimeTrend = calculateTrend(metricsHistory.responseTime);
  const successRateTrend = calculateTrend(metricsHistory.successRate);

  // Sort endpoints by total bytes (most bandwidth-intensive first)
  const sortedEndpoints = [...endpoints].sort((a, b) => b.totalBytes - a.totalBytes);

  // Pagination calculations
  const totalPages = Math.ceil(sortedEndpoints.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedEndpoints = sortedEndpoints.slice(startIndex, endIndex);

  // Format bytes to human-readable format
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
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

  const handleReset = () => {
    if (confirm('Reset all usage statistics? This cannot be undone.')) {
      apiTrafficTracker.reset();
    }
  };

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">API Usage</h1>
            <p className="text-sm text-muted-foreground">
              Monitor API endpoint usage and performance metrics
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleReset}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Reset Stats
          </Button>
        </div>

        {/* Summary Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Total Requests"
            value={globalMetrics.count}
            subtitle={
              globalMetrics.success > 0 || globalMetrics.failed > 0
                ? `${globalMetrics.success > 0 ? `${globalMetrics.success} success` : ''}${
                    globalMetrics.success > 0 && globalMetrics.failed > 0 ? ' • ' : ''
                  }${globalMetrics.failed > 0 ? `${globalMetrics.failed} failed` : ''}`
                : undefined
            }
            icon={Activity}
            iconColor="blue"
            trend={requestsTrend.trend}
            trendValue={requestsTrend.trendValue}
          />

          <MetricCard
            label="Total Bandwidth"
            value={formatBytes(globalMetrics.totalBytes)}
            subtitle={`Avg: ${formatBytes(globalMetrics.avgSize)}`}
            icon={HardDrive}
            iconColor="purple"
            trend={bandwidthTrend.trend}
            trendValue={bandwidthTrend.trendValue}
          />

          <MetricCard
            label="Avg Response Time"
            value={formatTime(globalMetrics.avgTime)}
            subtitle="Performance metric"
            icon={Clock}
            iconColor="green"
            trend={responseTimeTrend.trend}
            trendValue={responseTimeTrend.trendValue}
          />

          <MetricCard
            label="Success Rate"
            value={`${globalMetrics.count > 0 ? Math.round((globalMetrics.success / globalMetrics.count) * 100) : 0}%`}
            subtitle={`${globalMetrics.success}/${globalMetrics.count} requests`}
            icon={TrendingUp}
            iconColor="orange"
            trend={successRateTrend.trend}
            trendValue={successRateTrend.trendValue}
          />
        </div>

        {/* Endpoints Table */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Endpoint Analytics</CardTitle>
                <CardDescription>
                  {sortedEndpoints.length === 0 
                    ? 'No API requests tracked yet' 
                    : `Showing ${startIndex + 1}-${Math.min(endIndex, sortedEndpoints.length)} of ${sortedEndpoints.length} endpoints`}
                </CardDescription>
              </div>
              <TrendingUp className="h-5 w-5 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            {sortedEndpoints.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <BarChart3 className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-lg font-medium mb-2">No data yet</p>
                <p className="text-sm">API usage will appear here as you use the application</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
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
                    {paginatedEndpoints.map((endpoint, index) => {
                      const statusCodes = Object.entries(endpoint.statuses || {})
                        .sort(([a], [b]) => Number(a) - Number(b))
                        .map(([code, count]) => `${code}:${count}`)
                        .join(', ');
                      
                      const globalIndex = startIndex + index;

                      return (
                        <tr 
                          key={`${endpoint.method}-${endpoint.url}`}
                          className={`border-b border-border hover:bg-muted transition-colors ${
                            globalIndex < 3 ? 'bg-blue-50/30 dark:bg-blue-950/30' : ''
                          }`}
                        >
                          <td className="py-3 px-4">
                            <Badge variant="outline" className={getMethodColor(endpoint.method)}>
                              {endpoint.method || 'GET'}
                            </Badge>
                          </td>
                          <td className="py-3 px-4 font-mono text-sm text-foreground max-w-md truncate" title={endpoint.url}>
                            {endpoint.url}
                          </td>
                          <td className="py-3 px-4 text-right text-foreground">
                            {endpoint.count}
                          </td>
                          <td className="py-3 px-4 text-right text-green-600 font-medium">
                            {endpoint.success || 0}
                          </td>
                          <td className="py-3 px-4 text-right text-red-600 font-medium">
                            {endpoint.failed || 0}
                          </td>
                          <td className="py-3 px-4 text-right text-foreground font-medium">
                            {formatBytes(endpoint.totalBytes)}
                          </td>
                          <td className="py-3 px-4 text-right text-muted-foreground">
                            {formatBytes(endpoint.avgSize)}
                          </td>
                          <td className="py-3 px-4 text-right text-muted-foreground">
                            {formatTime(endpoint.avgTime)}
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
            
            {/* Pagination */}
            {sortedEndpoints.length > itemsPerPage && (
              <div className="mt-6">
                <Pagination>
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious 
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setCurrentPage(prev => Math.max(1, prev - 1));
                        }}
                        className={currentPage === 1 ? 'pointer-events-none opacity-50' : ''}
                      />
                    </PaginationItem>
                    
                    {/* First page */}
                    {currentPage > 2 && (
                      <PaginationItem>
                        <PaginationLink
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setCurrentPage(1);
                          }}
                        >
                          1
                        </PaginationLink>
                      </PaginationItem>
                    )}
                    
                    {/* Ellipsis before current page */}
                    {currentPage > 3 && (
                      <PaginationItem>
                        <PaginationEllipsis />
                      </PaginationItem>
                    )}
                    
                    {/* Previous page */}
                    {currentPage > 1 && (
                      <PaginationItem>
                        <PaginationLink
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setCurrentPage(currentPage - 1);
                          }}
                        >
                          {currentPage - 1}
                        </PaginationLink>
                      </PaginationItem>
                    )}
                    
                    {/* Current page */}
                    <PaginationItem>
                      <PaginationLink href="#" isActive>
                        {currentPage}
                      </PaginationLink>
                    </PaginationItem>
                    
                    {/* Next page */}
                    {currentPage < totalPages && (
                      <PaginationItem>
                        <PaginationLink
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setCurrentPage(currentPage + 1);
                          }}
                        >
                          {currentPage + 1}
                        </PaginationLink>
                      </PaginationItem>
                    )}
                    
                    {/* Ellipsis after current page */}
                    {currentPage < totalPages - 2 && (
                      <PaginationItem>
                        <PaginationEllipsis />
                      </PaginationItem>
                    )}
                    
                    {/* Last page */}
                    {currentPage < totalPages - 1 && (
                      <PaginationItem>
                        <PaginationLink
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setCurrentPage(totalPages);
                          }}
                        >
                          {totalPages}
                        </PaginationLink>
                      </PaginationItem>
                    )}
                    
                    <PaginationItem>
                      <PaginationNext 
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setCurrentPage(prev => Math.min(totalPages, prev + 1));
                        }}
                        className={currentPage === totalPages ? 'pointer-events-none opacity-50' : ''}
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
