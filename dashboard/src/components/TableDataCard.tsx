import { useState, useEffect, memo } from 'react';
import { Button } from './ui/button';
import { Settings, RefreshCw, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { buildApiUrl } from '../config/api';

export interface TableDataCardConfig {
  agentUuid?: string;
  agentName?: string;
  endpointName?: string;
  deviceUuid?: string;
  deviceName: string;
  metricName: string;
  timeRange: string; // '1h', '6h', '12h', '24h'
  title: string;
  columns?: {
    time: boolean;
    value: boolean;
    min: boolean;
    max: boolean;
    avg: boolean;
    quality: boolean;
  };
  pageSize?: number;
}

interface TableDataCardProps {
  config: TableDataCardConfig;
  refreshInterval?: number; // in seconds, 0 = off
  refreshTrigger?: number; // timestamp to trigger manual refresh
  onConfigure?: () => void;
  onRefresh?: () => void;
  onDataLoaded?: (data: any) => void;
}

interface TableRow {
  timestamp: string;
  value: number;
  min?: number;
  max?: number;
  avg?: number;
  quality?: number;
}

type SortColumn = 'timestamp' | 'value' | 'min' | 'max' | 'avg' | 'quality';
type SortDirection = 'asc' | 'desc';

function TableDataCardComponent({ 
  config, 
  refreshInterval = 30,
  refreshTrigger,
  onConfigure, 
  onRefresh,
  onDataLoaded 
}: TableDataCardProps) {
  const [data, setData] = useState<TableRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [staleReason, setStaleReason] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [sortColumn, setSortColumn] = useState<SortColumn>('timestamp');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const pageSize = config.pageSize || 10;

  const fetchData = async () => {
    // Defensive check for missing config
    if (!config) {
      setError('Configuration is missing');
      return;
    }
    
    if (!config.deviceUuid && !config.deviceName) {
      setError('Missing configuration');
      return;
    }
    if (!config.metricName || !config.timeRange) {
      setError('Missing configuration');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const token = localStorage.getItem('accessToken');
      const params = new URLSearchParams({
        metricName: config.metricName,
        timeRange: config.timeRange,
      });
      if (config.deviceUuid) {
        params.set('deviceUuid', config.deviceUuid);
      } else {
        params.set('deviceName', config.deviceName);
      }
      if (config.agentUuid) {
        params.set('agentUuid', config.agentUuid);
      }
      const response = await fetch(
        buildApiUrl(`/api/v1/metrics/timeseries?${params.toString()}`),
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch data: ${response.status}`);
      }

      const result = await response.json();
      
      // Transform data for table display
      const tableData: TableRow[] = result.data.map((point: any) => ({
        timestamp: point.time,
        value: point.avg_value,
        min: point.min_value,
        max: point.max_value,
        avg: point.avg_value,
        quality: point.quality_ratio ? point.quality_ratio * 100 : undefined
      }));

      setData(tableData);
      setLastRefreshed(new Date());
      setStale(false);
      setStaleReason(null);
      onDataLoaded?.(result);
    } catch (err) {
      console.error('Error fetching table data:', err);
      const message = err instanceof Error ? err.message : 'Unknown error';
      const hasExistingData = data.length > 0;

      if (hasExistingData) {
        setStale(true);
        setStaleReason(message);
        setError(null);
      } else {
        setError(message);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    
    if (refreshInterval > 0) {
      const interval = setInterval(fetchData, refreshInterval * 1000);
      return () => clearInterval(interval);
    }
  }, [config.deviceUuid, config.deviceName, config.metricName, config.timeRange, refreshInterval, refreshTrigger]);

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  };

  const sortedData = [...data].sort((a, b) => {
    const aVal = a[sortColumn];
    const bVal = b[sortColumn];
    
    if (aVal === undefined || bVal === undefined) return 0;
    
    const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    return sortDirection === 'asc' ? comparison : -comparison;
  });

  const totalPages = Math.ceil(sortedData.length / pageSize);
  const paginatedData = sortedData.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  const columns = config.columns || {
    time: true,
    value: true,
    min: false,
    max: false,
    avg: false,
    quality: true
  };

  const SortIcon = ({ column }: { column: SortColumn }) => {
    if (sortColumn !== column) {
      return <ArrowUpDown className="h-3 w-3 ml-1 opacity-40" />;
    }
    return sortDirection === 'asc' 
      ? <ArrowUp className="h-3 w-3 ml-1" />
      : <ArrowDown className="h-3 w-3 ml-1" />;
  };

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  const formatValue = (value: number | undefined | null) => {
    return (value !== undefined && value !== null) ? value.toFixed(2) : '-';
  };

  return (
    <div className="flex flex-col h-full">
      {/* Table */}
      <div className="flex-1 overflow-auto">
        {stale && data.length > 0 && (
          <div className="mb-2 rounded-md border border-amber-300/60 bg-amber-50/80 px-3 py-2 text-xs text-amber-800">
            Showing last known table data{lastRefreshed ? ` • updated ${lastRefreshed.toLocaleTimeString()}` : ''}
            {staleReason ? ` • ${staleReason}` : ''}
          </div>
        )}
        {isLoading && data.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin mr-2" />
            Loading...
          </div>
        ) : error && data.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-destructive">
            {error}
          </div>
        ) : data.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            No data available
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card border-b">
              <tr>
                {columns.time && (
                  <th 
                    className="text-left p-2 cursor-pointer hover:bg-muted/50"
                    onClick={() => handleSort('timestamp')}
                  >
                    <div className="flex items-center">
                      Time
                      <SortIcon column="timestamp" />
                    </div>
                  </th>
                )}
                {columns.value && (
                  <th 
                    className="text-right p-2 cursor-pointer hover:bg-muted/50"
                    onClick={() => handleSort('value')}
                  >
                    <div className="flex items-center justify-end">
                      Value
                      <SortIcon column="value" />
                    </div>
                  </th>
                )}
                {columns.min && (
                  <th 
                    className="text-right p-2 cursor-pointer hover:bg-muted/50"
                    onClick={() => handleSort('min')}
                  >
                    <div className="flex items-center justify-end">
                      Min
                      <SortIcon column="min" />
                    </div>
                  </th>
                )}
                {columns.max && (
                  <th 
                    className="text-right p-2 cursor-pointer hover:bg-muted/50"
                    onClick={() => handleSort('max')}
                  >
                    <div className="flex items-center justify-end">
                      Max
                      <SortIcon column="max" />
                    </div>
                  </th>
                )}
                {columns.avg && (
                  <th 
                    className="text-right p-2 cursor-pointer hover:bg-muted/50"
                    onClick={() => handleSort('avg')}
                  >
                    <div className="flex items-center justify-end">
                      Avg
                      <SortIcon column="avg" />
                    </div>
                  </th>
                )}
                {columns.quality && (
                  <th 
                    className="text-right p-2 cursor-pointer hover:bg-muted/50"
                    onClick={() => handleSort('quality')}
                  >
                    <div className="flex items-center justify-end">
                      Quality
                      <SortIcon column="quality" />
                    </div>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {paginatedData.map((row, idx) => (
                <tr 
                  key={idx}
                  className="border-b hover:bg-muted/30 transition-colors"
                >
                  {columns.time && (
                    <td className="p-2 font-mono text-xs">
                      {formatTimestamp(row.timestamp)}
                    </td>
                  )}
                  {columns.value && (
                    <td className="p-2 text-right font-semibold">
                      {formatValue(row.value)}
                    </td>
                  )}
                  {columns.min && (
                    <td className="p-2 text-right text-muted-foreground">
                      {formatValue(row.min)}
                    </td>
                  )}
                  {columns.max && (
                    <td className="p-2 text-right text-muted-foreground">
                      {formatValue(row.max)}
                    </td>
                  )}
                  {columns.avg && (
                    <td className="p-2 text-right text-muted-foreground">
                      {formatValue(row.avg)}
                    </td>
                  )}
                  {columns.quality && (
                    <td className="p-2 text-right">
                      <span className={
                        row.quality !== undefined && row.quality > 95 
                          ? 'text-green-600' 
                          : 'text-yellow-600'
                      }>
                        {row.quality !== undefined ? `${row.quality.toFixed(1)}%` : '-'}
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {data.length > pageSize && (
        <div className="flex items-center justify-between p-2 border-t bg-muted/50 text-xs">
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground">
              Showing {((currentPage - 1) * pageSize) + 1}-{Math.min(currentPage * pageSize, sortedData.length)} of {sortedData.length}
            </span>
            {lastRefreshed && (
              <span className="text-muted-foreground">
                • Updated {lastRefreshed.toLocaleTimeString()}
              </span>
            )}
          </div>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="h-7 px-2"
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="h-7 px-2"
            >
              Next
            </Button>
          </div>
        </div>
      )}
      {/* Show timestamp even without pagination */}
      {data.length > 0 && data.length <= pageSize && lastRefreshed && (
        <div className="flex items-center justify-end p-2 border-t bg-muted/50 text-xs">
          <span className="text-muted-foreground">
            Updated {lastRefreshed.toLocaleTimeString()}
          </span>
        </div>
      )}
    </div>
  );
}

export const TableDataCard = memo(TableDataCardComponent);
