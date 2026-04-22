import { useEffect, useRef, useState } from 'react';
import { getCustomerJobs } from '../api/client';
import { Job } from '../api/types';

const JOB_STATE_CLASSES: Record<string, string> = {
  active: 'bg-blue-100 text-blue-800',
  waiting: 'bg-yellow-100 text-yellow-800',
  delayed: 'bg-yellow-100 text-yellow-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  paused: 'bg-gray-100 text-gray-600',
};

interface JobsPanelProps {
  customerId: string;
}

export default function JobsPanel({ customerId }: JobsPanelProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchJobs() {
    try {
      const data = await getCustomerJobs(customerId);
      setJobs(data.jobs);
    } catch {
      // Non-critical; keep previous data
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchJobs();

    // Poll every 3 s while any job is active or waiting
    intervalRef.current = setInterval(async () => {
      const data = await getCustomerJobs(customerId).catch(() => ({ jobs: [] as Job[] }));
      setJobs(data.jobs);
      const hasLive = data.jobs.some((j) => j.state === 'active' || j.state === 'waiting');
      if (!hasLive && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }, 3000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [customerId]);

  if (loading) {
    return <p className="text-sm text-gray-500">Loading jobs...</p>;
  }

  if (jobs.length === 0) {
    return <p className="text-sm text-gray-500">No jobs found for this customer.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
            <th className="py-2 pr-4">ID</th>
            <th className="py-2 pr-4">Type</th>
            <th className="py-2 pr-4">State</th>
            <th className="py-2 pr-4">Progress</th>
            <th className="py-2 pr-4">Attempts</th>
            <th className="py-2 pr-4">Queued</th>
            <th className="py-2">Details</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="py-2 pr-4 font-mono text-xs text-gray-500">{job.id}</td>
              <td className="py-2 pr-4">{job.type.replace(/-/g, ' ')}</td>
              <td className="py-2 pr-4">
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${JOB_STATE_CLASSES[job.state] ?? 'bg-gray-100 text-gray-700'}`}
                >
                  {job.state}
                </span>
              </td>
              <td className="py-2 pr-4">
                <div className="flex items-center gap-2">
                  <div className="w-24 bg-gray-200 rounded-full h-1.5">
                    <div
                      className="bg-blue-500 h-1.5 rounded-full"
                      style={{ width: `${job.progress}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-500">{job.progress}%</span>
                </div>
              </td>
              <td className="py-2 pr-4 text-xs text-gray-500">{job.attempts}</td>
              <td className="py-2 pr-4 text-xs text-gray-500">
                {new Date(job.timestamp).toLocaleString()}
              </td>
              <td className="py-2 text-xs text-red-600">
                {job.failedReason ?? null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
