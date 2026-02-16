import React, { useEffect, useState } from 'react';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Plus, RefreshCw, Trash2, XCircle, Eye, FileText, AlertTriangle } from 'lucide-react';
import { buildApiUrl } from '@/config/api';
import { Device } from './AgentSidebar';
import { canPerformDeviceActions, getDisabledActionMessage } from '@/utils/devicePermissions';
import AddJobModal from './jobs/AddJobModal';
import JobDetailsModal from './jobs/JobDetailsModal';
import AddTemplateModal from './jobs/AddTemplateModal';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from './ui/pagination';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';

interface Job {
  id: number;
  job_id: string;
  job_name: string;
  status: string;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  execution_type: string;
  exit_code: number | null;
  reason: string | null;
  stdout?: string | null;
  stderr?: string | null;
  job_document?: any;
  template_id?: number;
  target_type?: string;
  target_devices?: string[];
}

interface JobsCardProps {
  deviceUuid: string;
  deviceStatus?: Device['status']; // Add device status for permission checks
}

export const JobsCard: React.FC<JobsCardProps> = ({ deviceUuid, deviceStatus }) => {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  
  // Check if device actions are allowed
  const canAddApp = canPerformDeviceActions(deviceStatus);
  const disabledMessage = getDisabledActionMessage(deviceStatus);
  const [showAddTemplateModal, setShowAddTemplateModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const [cancelingJobId, setCancelingJobId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [jobToDelete, setJobToDelete] = useState<Job | null>(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [jobToCancel, setJobToCancel] = useState<Job | null>(null);
  
  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [totalJobs, setTotalJobs] = useState(0);
  const [pageSize] = useState(10);

  const fetchJobs = async (page: number = 1) => {
    if (!deviceUuid) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const offset = (page - 1) * pageSize;
      const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceUuid}/jobs?limit=${pageSize}&offset=${offset}`));
      
      if (!response.ok) {
        throw new Error('Failed to fetch jobs');
      }
      
      const data = await response.json();
      setJobs(data.jobs || []);
      setTotalJobs(data.total || 0);
      setCurrentPage(page);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Error fetching jobs:', err);
      setError(err instanceof Error ? err.message : 'Failed to load jobs');
      setJobs([]);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteJob = async () => {
    if (!jobToDelete) return;

    setDeletingJobId(jobToDelete.job_id);
    try {
      const response = await fetch(buildApiUrl(`/api/v1/jobs/${jobToDelete.job_id}`), {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete job');
      }

      await fetchJobs(currentPage);
      setDeleteConfirmOpen(false);
      setJobToDelete(null);
    } catch (err) {
      console.error('Error deleting job:', err);
      alert(err instanceof Error ? err.message : 'Failed to delete job');
    } finally {
      setDeletingJobId(null);
    }
  };

  const handleCancelJob = async () => {
    if (!jobToCancel) return;

    setCancelingJobId(jobToCancel.job_id);
    try {
      const response = await fetch(buildApiUrl(`/api/v1/jobs/${jobToCancel.job_id}/cancel`), {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to cancel job');
      }

      await fetchJobs(currentPage);
      setCancelConfirmOpen(false);
      setJobToCancel(null);
    } catch (err) {
      console.error('Error canceling job:', err);
      alert(err instanceof Error ? err.message : 'Failed to cancel job');
    } finally {
      setCancelingJobId(null);
    }
  };

  useEffect(() => {
    fetchJobs(1);
  }, [deviceUuid]);

  const getStatusBadge = (status: string) => {
    const statusConfig: Record<string, { color: string; label: string }> = {
      QUEUED: { color: 'bg-gray-100 text-gray-700 border-gray-300', label: 'Queued' },
      IN_PROGRESS: { color: 'bg-blue-100 text-blue-700 border-blue-300', label: 'In Progress' },
      SUCCEEDED: { color: 'bg-green-100 text-green-700 border-green-300', label: 'Succeeded' },
      FAILED: { color: 'bg-red-100 text-red-700 border-red-300', label: 'Failed' },
      TIMED_OUT: { color: 'bg-orange-100 text-orange-700 border-orange-300', label: 'Timed Out' },
      CANCELED: { color: 'bg-gray-100 text-gray-600 border-gray-300', label: 'Canceled' },
      REJECTED: { color: 'bg-red-100 text-red-600 border-red-300', label: 'Rejected' },
    };

    const config = statusConfig[status] || statusConfig.QUEUED;

    return (
      <Badge variant="outline" className={`${config.color} text-xs px-2 py-0.5`}>
        {config.label}
      </Badge>
    );
  };

  const getExecutionTypeBadge = (executionType: string) => {
    const typeConfig: Record<string, { color: string; label: string }> = {
      oneTime: { color: 'bg-purple-100 text-purple-700 border-purple-300', label: 'One-Time' },
      scheduled: { color: 'bg-cyan-100 text-cyan-700 border-cyan-300', label: 'Scheduled' },
      recurring: { color: 'bg-indigo-100 text-indigo-700 border-indigo-300', label: 'Recurring' },
      continuous: { color: 'bg-teal-100 text-teal-700 border-teal-300', label: 'Continuous' },
    };

    const config = typeConfig[executionType] || typeConfig.oneTime;

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

  const handleJobAdded = () => {
    setShowModal(false);
    fetchJobs(); // Refresh the list
  };

  const handleRefresh = () => {
    fetchJobs(currentPage);
  };

  const handleViewJob = (job: Job) => {
    setSelectedJob(job);
    setShowDetailsModal(true);
  };

  return (
    <>
      {/* Header with Buttons - Outside Card */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Jobs</h1>
          <p className="text-sm text-muted-foreground">
            Job executions on this device
            {lastRefresh && (
              <span className="text-xs text-muted-foreground ml-2">
                • Last updated {lastRefresh.toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={loading}
            title="Refresh jobs"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAddTemplateModal(true)}
          >
            <FileText className="w-4 h-4 mr-2" /> Add Template
          </Button>
          <Button
            onClick={() => setShowModal(true)}
            disabled={!canAddApp}
            title={!canAddApp ? disabledMessage : undefined}
            className="flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> Add Job
          </Button>
        </div>
      </div>

      <Card className="p-4 md:p-6">

        {loading && jobs.length === 0 ? (
          <div className="text-center py-8 text-gray-500">Loading jobs...</div>
        ) : error ? (
          <div className="text-center py-8 text-red-600">{error}</div>
        ) : jobs.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            No jobs found. Click "Add Job" to create one.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Job Name</th>
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Status</th>
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground hidden md:table-cell">
                    Execution Type
                  </th>
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Date</th>
                  <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-b border-border last:border-0 hover:bg-muted">
                    <td className="py-3 px-4 text-foreground">
                      <div className="font-medium">{job.job_name}</div>
                      {job.reason && (
                        <div className="text-xs text-muted-foreground mt-0.5 truncate max-w-[200px]">
                          {job.reason}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4">{getStatusBadge(job.status)}</td>
                    <td className="py-3 px-4 hidden md:table-cell">
                      {getExecutionTypeBadge(job.execution_type)}
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">
                      {formatDate(job.completed_at || job.started_at || job.queued_at)}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-2 whitespace-nowrap ml-auto">
                        {/* View button - always visible */}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleViewJob(job)}
                          className="text-blue-600 hover:text-blue-700 border-blue-300 hover:bg-blue-50 min-w-[84px]"
                        >
                          <Eye className="w-4 h-4 mr-1" />
                          View
                        </Button>
                        
                        {/* Cancel button - only for QUEUED jobs */}
                        {job.status === 'QUEUED' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setJobToCancel(job);
                              setCancelConfirmOpen(true);
                            }}
                            disabled={cancelingJobId === job.job_id}
                            className="text-orange-600 hover:text-orange-700 border-orange-300 hover:bg-orange-50 min-w-[84px]"
                          >
                            <XCircle className="w-4 h-4 mr-1" />
                            Cancel
                          </Button>
                        )}
                        
                        {/* Delete button - for all completed states and queued */}
                        {['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED', 'REJECTED', 'QUEUED'].includes(job.status) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setJobToDelete(job);
                              setDeleteConfirmOpen(true);
                            }}
                            disabled={deletingJobId === job.job_id}
                            className="text-red-600 hover:text-red-700 border-red-300 hover:bg-red-50 min-w-[84px]"
                          >
                            <Trash2 className="w-4 h-4 mr-1" />
                            Delete
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          {totalJobs > pageSize && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <div className="text-sm text-muted-foreground">
                Showing {Math.min((currentPage - 1) * pageSize + 1, totalJobs)} to {Math.min(currentPage * pageSize, totalJobs)} of {totalJobs} jobs
              </div>
              <Pagination>
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious 
                      onClick={() => fetchJobs(currentPage - 1)}
                      className={currentPage === 1 ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                    />
                  </PaginationItem>
                  
                  {Array.from({ length: Math.ceil(totalJobs / pageSize) }, (_, i) => i + 1)
                    .filter(page => {
                      const totalPages = Math.ceil(totalJobs / pageSize);
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
                            onClick={() => fetchJobs(page)}
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
                      onClick={() => fetchJobs(currentPage + 1)}
                      className={currentPage === Math.ceil(totalJobs / pageSize) ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          )}
          </>
        )}
      </Card>

      <AddJobModal
        open={showModal}
        onClose={() => setShowModal(false)}
        deviceUuid={deviceUuid}
        onJobAdded={handleJobAdded}
      />

      <JobDetailsModal
        open={showDetailsModal}
        onClose={() => setShowDetailsModal(false)}
        job={selectedJob}
      />

      <AddTemplateModal
        open={showAddTemplateModal}
        onClose={() => setShowAddTemplateModal(false)}
        onSaved={() => {
          // Optionally refresh or show success message
          console.log('Template saved successfully');
        }}
      />

      {/* Delete Job Confirmation Dialog */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100">
                <AlertTriangle className="h-5 w-5 text-red-600" />
              </div>
              <AlertDialogTitle>Delete Job</AlertDialogTitle>
            </div>
            <AlertDialogDescription className="text-left pt-2">
              Are you sure you want to delete job <strong className="text-foreground">"{jobToDelete?.job_name}"</strong>? 
              This action cannot be undone and all job data will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deletingJobId}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteJob}
              disabled={!!deletingJobId}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              {deletingJobId ? 'Deleting...' : 'Delete Job'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel Job Confirmation Dialog */}
      <AlertDialog open={cancelConfirmOpen} onOpenChange={setCancelConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-orange-100">
                <XCircle className="h-5 w-5 text-orange-600" />
              </div>
              <AlertDialogTitle>Cancel Job</AlertDialogTitle>
            </div>
            <AlertDialogDescription className="text-left pt-2">
              Are you sure you want to cancel job <strong className="text-foreground">"{jobToCancel?.job_name}"</strong>? 
              The job will not be executed and its status will be updated to canceled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!cancelingJobId}>No, Keep It</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancelJob}
              disabled={!!cancelingJobId}
              className="bg-orange-600 hover:bg-orange-700 focus:ring-orange-600"
            >
              {cancelingJobId ? 'Canceling...' : 'Yes, Cancel Job'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default JobsCard;
