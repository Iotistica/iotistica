/**
 * Sensor Summary Cards Component
 * Shows total, online, offline, and error counts
 */

import React from 'react';
import { Activity, CheckCircle, XCircle, AlertTriangle, Clock } from 'lucide-react';
import { MetricCard } from '@/components/ui/metric-card';

interface SensorSummary {
  total: number;
  online: number;
  offline: number;
  pending: number;
  errors: number;
}

interface SensorSummaryCardsProps {
  summary: SensorSummary;
}

export const SensorSummaryCards: React.FC<SensorSummaryCardsProps> = ({ summary }) => {
  return (
    <div className="flex flex-row gap-4 w-full overflow-x-auto">
      <div className="flex-1 min-w-[200px]">
        <MetricCard
          label="Total Devices"
          value={summary.total}
          icon={Activity}
          iconColor="blue"
        />
      </div>
      
      <div className="flex-1 min-w-[200px]">
        <MetricCard
          label="Online"
          value={summary.online}
          icon={CheckCircle}
          iconColor="green"
        />
      </div>
      
      <div className="flex-1 min-w-[200px]">
        <MetricCard
          label="Offline"
          value={summary.offline}
          icon={XCircle}
          iconColor="red"
        />
      </div>
      
      <div className="flex-1 min-w-[200px]">
        <MetricCard
          label="Pending"
          value={summary.pending}
          icon={Clock}
          iconColor="gray"
        />
      </div>
      
      <div className="flex-1 min-w-[200px]">
        <MetricCard
          label="Errors"
          value={summary.errors}
          icon={AlertTriangle}
          iconColor="orange"
        />
      </div>
    </div>
  );
};
