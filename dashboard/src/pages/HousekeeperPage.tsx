import React, { useState, useEffect } from 'react';
import { PlayCircle, RefreshCw, CheckCircle2, XCircle, Activity, AlertTriangle, Eye, Clock } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { MetricCard } from '@/components/ui/metric-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { toast } from 'sonner';
import { buildHousekeeperUrl } from '@/config/api';

interface TaskStats {
  total_runs: number;
  success_count: number;
  error_count: number;
  avg_duration_ms: number;
  last_run_at: string | null;
  last_status: string | null;
}

interface Task {
  name: string;
  schedule: string;
  startup: boolean;
  isRunning: boolean;
  enabled: boolean;
  stats: TaskStats;
}

interface TaskRun {
  id: number;
  task_name: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  duration_ms: number | null;
  triggered_by: string;
  output: string | null;
  error: string | null;
}

interface TaskRunDetails extends TaskRun {
  // Same as TaskRun, but used when viewing full details
}

function formatDuration(ms: number | null) {
  if (!ms) return 'N/A';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export default function HousekeeperPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [allRuns, setAllRuns] = useState<TaskRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [selectedRun, setSelectedRun] = useState<TaskRunDetails | null>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(10);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [tasksResponse, statusResponse] = await Promise.all([
        fetch(buildHousekeeperUrl('/api/housekeeper/tasks')),
        fetch(buildHousekeeperUrl('/api/housekeeper/status'))
      ]);
      
      if (!tasksResponse.ok || !statusResponse.ok) {
        throw new Error('Failed to load housekeeper data');
      }
      
      const tasksData = await tasksResponse.json();
      const statusData = await statusResponse.json();
      
      setTasks(tasksData.tasks || []);
      setStatus(statusData);

      // Fetch run history for all tasks
      const runs: TaskRun[] = [];
      for (const task of tasksData.tasks || []) {
        try {
          const taskResponse = await fetch(buildHousekeeperUrl(`/api/housekeeper/tasks/${encodeURIComponent(task.name)}`));
          if (taskResponse.ok) {
            const taskData = await taskResponse.json();
            if (taskData.history && Array.isArray(taskData.history)) {
              // Add task_name to each run since the API doesn't include it
              const taskRuns = taskData.history.map((run: any) => ({
                ...run,
                task_name: task.name
              }));
              runs.push(...taskRuns);
            }
          }
        } catch (err) {
          console.error(`Failed to load history for task ${task.name}:`, err);
        }
      }
      
      // Sort all runs by started_at descending
      runs.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
      setAllRuns(runs);
      setLastRefresh(new Date());
    } catch (error: any) {
      console.error('Failed to load housekeeper data:', error);
      setError(error.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleViewRun = async (run: TaskRun) => {
    try {
      const response = await fetch(buildHousekeeperUrl(`/api/housekeeper/tasks/${encodeURIComponent(run.task_name)}/runs/${run.id}`));
      if (response.ok) {
        const data = await response.json();
        setSelectedRun(data.run);
        setShowDetailsModal(true);
      } else {
        toast.error('Failed to load run details');
      }
    } catch (err) {
      console.error('Error loading run details:', err);
      toast.error('Failed to load run details');
    }
  };

  const getStatusBadge = (status: string) => {
    const statusConfig: Record<string, { color: string; label: string }> = {
      running: { color: 'bg-blue-100 text-blue-700 border-blue-300', label: 'Running' },
      success: { color: 'bg-green-100 text-green-700 border-green-300', label: 'Success' },
      error: { color: 'bg-red-100 text-red-700 border-red-300', label: 'Error' },
    };

    const config = statusConfig[status] || statusConfig.running;

    return (
      <Badge variant="outline" className={`${config.color} text-xs px-2 py-0.5`}>
        {config.label}
      </Badge>
    );
  };

  const getTriggerBadge = (triggeredBy: string) => {
    const triggerConfig: Record<string, { color: string; label: string }> = {
      scheduler: { color: 'bg-purple-100 text-purple-700 border-purple-300', label: 'Scheduled' },
      manual: { color: 'bg-cyan-100 text-cyan-700 border-cyan-300', label: 'Manual' },
      startup: { color: 'bg-indigo-100 text-indigo-700 border-indigo-300', label: 'Startup' },
    };

    const config = triggerConfig[triggeredBy] || triggerConfig.scheduler;

    return (
      <Badge variant="outline" className={`${config.color} text-xs px-2 py-0.5`}>
        {config.label}
      </Badge>
    );
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return '—';
    
    try {
      const date = new Date(dateString);
      return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateString;
    }
  };

  // Calculate metrics
  const totalRuns = allRuns.length;
  const successRuns = allRuns.filter(r => r.status === 'success').length;
  const errorRuns = allRuns.filter(r => r.status === 'error').length;
  const runningRuns = allRuns.filter(r => r.status === 'running').length;

  // Calculate success rate
  const completedRuns = successRuns + errorRuns;
  const successRate = completedRuns > 0 ? Math.round((successRuns / completedRuns) * 100) : 0;

  // Pagination
  const totalPages = Math.ceil(totalRuns / pageSize);
  const paginatedRuns = allRuns.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const metrics = [
    {
      icon: PlayCircle,
      label: "Total Runs",
      value: totalRuns.toString(),
      subtitle: `${completedRuns} completed`,
      color: "blue",
      bgColor: "bg-blue-50",
      iconColor: "text-blue-600",
    },
    {
      icon: CheckCircle2,
      label: "Successful",
      value: successRuns.toString(),
      subtitle: completedRuns > 0 ? `${successRate}% success rate` : "No completed runs",
      color: "green",
      bgColor: "bg-green-50",
      iconColor: "text-green-600",
    },
    {
      icon: XCircle,
      label: "Failed",
      value: errorRuns.toString(),
      subtitle: errorRuns > 0 ? `${errorRuns} error runs` : "No errors",
      color: "red",
      bgColor: "bg-red-50",
      iconColor: "text-red-600",
    },
    {
      icon: Activity,
      label: "Running Now",
      value: (status?.runningTasks || 0).toString(),
      subtitle: runningRuns > 0 ? `${runningRuns} active runs` : "No active runs",
      color: runningRuns > 0 ? "purple" : "gray",
      bgColor: runningRuns > 0 ? "bg-purple-50" : "bg-gray-50",
      iconColor: runningRuns > 0 ? "text-purple-600" : "text-gray-600",
    },
  ];

  if (loading && allRuns.length === 0) {
    return (
      <div className="flex justify-center items-center min-h-96">
        <RefreshCw className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">
        {/* Page Title */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h2 className="text-2xl font-bold tracking-tight text-foreground">Maintenance Tasks</h2>
            <p className="text-sm text-muted-foreground">
              Monitor scheduled maintenance and cleanup task executions
              {lastRefresh && (
                <span className="text-xs text-muted-foreground/70 ml-2">
                  • Last updated {lastRefresh.toLocaleTimeString()}
                </span>
              )}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={loadData}
            disabled={loading}
            title="Refresh data"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Quick Metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {metrics.map((metric, index) => (
            <MetricCard
              key={index}
              label={metric.label}
              value={metric.value}
              subtitle={metric.subtitle}
              icon={metric.icon}
              iconColor={metric.color as any}
            />
          ))}
        </div>

        {/* Task Executions Table */}
        <Card className="p-4 md:p-6">
          <div className="space-y-4">
            <div className="space-y-2 mb-6">
              <h3 className="text-xl font-bold tracking-tight text-foreground">Task Execution History</h3>
              <p className="text-sm text-muted-foreground">
                Recent maintenance task runs across all scheduled tasks
              </p>
            </div>

            {loading && allRuns.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">Loading task runs...</div>
            ) : error ? (
              <div className="text-center py-8 text-destructive">{error}</div>
            ) : allRuns.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No task runs found. Tasks will appear here after execution.
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Task Name</th>
                        <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Status</th>
                        <th className="text-left py-3 px-4 font-semibold text-sm text-foreground hidden md:table-cell">
                          Trigger
                        </th>
                        <th className="text-left py-3 px-4 font-semibold text-sm text-foreground hidden lg:table-cell">
                          Duration
                        </th>
                        <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Started At</th>
                        <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedRuns.map((run) => (
                        <tr key={run.id} className="border-b border-border last:border-0 hover:bg-muted">
                          <td className="py-3 px-4 text-foreground">
                            <div className="font-medium truncate">{run.task_name}</div>
                            {run.error && (
                              <div className="text-xs text-destructive mt-0.5 truncate max-w-[200px]">
                                {run.error.split('\n')[0]}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4">{getStatusBadge(run.status)}</td>
                          <td className="py-3 px-4 hidden md:table-cell">
                            {getTriggerBadge(run.triggered_by)}
                          </td>
                          <td className="py-3 px-4 text-muted-foreground hidden lg:table-cell">
                            <div className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {formatDuration(run.duration_ms)}
                            </div>
                          </td>
                          <td className="py-3 px-4 text-muted-foreground">
                            {formatDate(run.started_at)}
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleViewRun(run)}
                                className="text-blue-600 hover:text-blue-700 border-blue-300 hover:bg-blue-50 min-w-[84px]"
                              >
                                <Eye className="w-4 h-4 mr-1" />
                                Details
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination Controls */}
                {totalRuns > pageSize && (
                  <div className="flex items-center justify-between px-4 py-3 border-t border-border">
                    <div className="text-sm text-muted-foreground">
                      Showing {Math.min((currentPage - 1) * pageSize + 1, totalRuns)} to {Math.min(currentPage * pageSize, totalRuns)} of {totalRuns} runs
                    </div>
                    <Pagination>
                      <PaginationContent>
                        <PaginationItem>
                          <PaginationPrevious 
                            onClick={() => setCurrentPage(currentPage - 1)}
                            className={currentPage === 1 ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                          />
                        </PaginationItem>
                        
                        {Array.from({ length: totalPages }, (_, i) => i + 1)
                          .filter(page => {
                            // Show first page, last page, current page, and pages around current
                            return page === 1 || 
                                   page === totalPages || 
                                   Math.abs(page - currentPage) <= 1;
                          })
                          .map((page, idx, arr) => (
                            <React.Fragment key={page}>
                              {idx > 0 && arr[idx - 1] !== page - 1 && (
                                <PaginationItem>
                                  <PaginationEllipsis />
                                </PaginationItem>
                              )}
                              <PaginationItem>
                                <PaginationLink
                                  onClick={() => setCurrentPage(page)}
                                  isActive={currentPage === page}
                                  className="cursor-pointer"
                                >
                                  {page}
                                </PaginationLink>
                              </PaginationItem>
                            </React.Fragment>
                          ))}
                        
                        <PaginationItem>
                          <PaginationNext 
                            onClick={() => setCurrentPage(currentPage + 1)}
                            className={currentPage === totalPages ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                          />
                        </PaginationItem>
                      </PaginationContent>
                    </Pagination>
                  </div>
                )}
              </>
            )}
          </div>
        </Card>

        {/* Run Details Modal */}
        <Dialog open={showDetailsModal} onOpenChange={setShowDetailsModal}>
          <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Task Run Details</DialogTitle>
              <DialogDescription>
                Detailed information about task execution
              </DialogDescription>
            </DialogHeader>
            {selectedRun && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Task Name</label>
                    <div className="text-base font-semibold">{selectedRun.task_name}</div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Status</label>
                    <div className="mt-1">{getStatusBadge(selectedRun.status)}</div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Triggered By</label>
                    <div className="mt-1">{getTriggerBadge(selectedRun.triggered_by)}</div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Duration</label>
                    <div className="text-base">{formatDuration(selectedRun.duration_ms)}</div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Started At</label>
                    <div className="text-base">{formatDate(selectedRun.started_at)}</div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Completed At</label>
                    <div className="text-base">{formatDate(selectedRun.completed_at)}</div>
                  </div>
                </div>

                {selectedRun.output && (
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Output</label>
                    <pre className="mt-2 p-3 bg-muted rounded text-xs overflow-x-auto max-h-60 overflow-y-auto">
                      {selectedRun.output}
                    </pre>
                  </div>
                )}

                {selectedRun.error && (
                  <div>
                    <label className="text-sm font-medium text-destructive">Error</label>
                    <pre className="mt-2 p-3 bg-destructive/10 rounded text-xs text-destructive overflow-x-auto max-h-60 overflow-y-auto">
                      {selectedRun.error}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
