/**
 * Jobs Page - Shows scheduled jobs and job history
 */

import { useState, useEffect } from "react";
import { MetricCard } from "../components/ui/metric-card";
import { Badge } from "../components/ui/badge";
import { Device } from "../components/DeviceSidebar";
import JobsCard from "../components/JobsCard";
import { CheckCircle2, XCircle, Clock, PlayCircle, Activity, AlertTriangle } from "lucide-react";
import { buildApiUrl } from "@/config/api";

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
}

interface JobsPageProps {
  device: Device;
}

export function JobsPage({ device }: JobsPageProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch jobs for statistics
  useEffect(() => {
    const fetchJobs = async () => {
      if (!device.deviceUuid) return;
      
      setLoading(true);
      try {
        const response = await fetch(buildApiUrl(`/api/v1/devices/${device.deviceUuid}/jobs?limit=100`));
        if (response.ok) {
          const data = await response.json();
          setJobs(data.jobs || []);
        }
      } catch (err) {
        console.error('Error fetching jobs for stats:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchJobs();
    // Refresh every 30 seconds
    const interval = setInterval(fetchJobs, 30000);
    return () => clearInterval(interval);
  }, [device.deviceUuid]);

  // Calculate job statistics
  const totalJobs = jobs.length;
  const succeededJobs = jobs.filter(j => j.status === 'SUCCEEDED').length;
  const failedJobs = jobs.filter(j => j.status === 'FAILED').length;
  const timedOutJobs = jobs.filter(j => j.status === 'TIMED_OUT').length;
  const queuedJobs = jobs.filter(j => j.status === 'QUEUED').length;
  const inProgressJobs = jobs.filter(j => j.status === 'IN_PROGRESS').length;
  const canceledJobs = jobs.filter(j => j.status === 'CANCELED').length;
  const rejectedJobs = jobs.filter(j => j.status === 'REJECTED').length;

  // Calculate success rate
  const completedJobs = succeededJobs + failedJobs + timedOutJobs + canceledJobs + rejectedJobs;
  const successRate = completedJobs > 0 ? Math.round((succeededJobs / completedJobs) * 100) : 0;

  const metrics = [
    {
      icon: PlayCircle,
      label: "Total Jobs",
      value: totalJobs.toString(),
      subtitle: `${completedJobs} completed`,
      color: "blue",
      bgColor: "bg-blue-50",
      iconColor: "text-blue-600",
    },
    {
      icon: CheckCircle2,
      label: "Succeeded",
      value: succeededJobs.toString(),
      subtitle: completedJobs > 0 ? `${successRate}% success rate` : "No completed jobs",
      color: "green",
      bgColor: "bg-green-50",
      iconColor: "text-green-600",
    },
    {
      icon: XCircle,
      label: "Failed",
      value: (failedJobs + timedOutJobs + rejectedJobs).toString(),
      subtitle: failedJobs > 0 ? `${failedJobs} failed, ${timedOutJobs} timed out` : 
                timedOutJobs > 0 ? `${timedOutJobs} timed out` : "No failures",
      color: "red",
      bgColor: "bg-red-50",
      iconColor: "text-red-600",
    },
    {
      icon: Activity,
      label: "Active Jobs",
      value: (queuedJobs + inProgressJobs).toString(),
      subtitle: inProgressJobs > 0 ? `${inProgressJobs} running, ${queuedJobs} queued` : 
                queuedJobs > 0 ? `${queuedJobs} queued` : "No active jobs",
      color: inProgressJobs > 0 ? "purple" : "gray",
      bgColor: inProgressJobs > 0 ? "bg-purple-50" : "bg-gray-50",
      iconColor: inProgressJobs > 0 ? "text-purple-600" : "text-gray-600",
    },
  ];

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">

        {/* Page Title */}
        <div className="space-y-2">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Scheduled Jobs</h2>
          <p className="text-sm text-muted-foreground">
            Manage and monitor scheduled tasks and job execution history
          </p>
        </div>

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

        {/* Jobs Card */}
        <JobsCard deviceUuid={device.deviceUuid} deviceStatus={device.status} />
      </div>
    </div>
  );
}
