/**
 * Audit & Activity Page - Global View
 * Unified audit page with timeline and activity tracking
 */

import React from 'react';
import { TimelineCard } from '../../components/TimelineCard';

export const AuditPage: React.FC = () => {
  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">
        {/* Page Header */}
        <div>
          <h2 className="text-2xl font-bold text-foreground mb-2">Audit & Activity</h2>
          <p className="text-muted-foreground">System events, user actions, and activity history across all devices</p>
        </div>

        {/* Timeline Card - Global View (all devices) */}
        <TimelineCard
          limit={100}
          autoRefresh={true}
          refreshInterval={30000}
          showHeaderDetails={false}
          showToolbar={false}
          showCategoryFilter={true}
        />
      </div>
    </div>
  );
};

export default AuditPage;
