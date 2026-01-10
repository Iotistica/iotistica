/**
 * Sensor Summary Cards Component
 * Shows total, online, offline, and error counts
 */

import React from 'react';
import { Activity, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import { MetricCard } from '@/components/ui/metric-card';

interface SensorSummary {
  total: number;
  online: number;
  offline: number;
  errors: number;
}

interface SensorSummaryCardsProps {
  summary: SensorSummary;
}

export const SensorSummaryCards: React.FC<SensorSummaryCardsProps> = ({ summary }) => {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <MetricCard
        label="Total Endpoints"
        value={summary.total}
        icon={Activity}
        iconColor="blue"
      />
      
      <MetricCard
        label="Online"
        value={summary.online}
        icon={CheckCircle}
        iconColor="green"
      />
      
      <MetricCard
        label="Offline"
        value={summary.offline}
        icon={XCircle}
        iconColor="red"
      />
      
      <MetricCard
        label="Errors"
        value={summary.errors}
        icon={AlertTriangle}
        iconColor="orange"
      />
    </div>
  );
};
