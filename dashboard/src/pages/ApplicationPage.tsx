/**
 * MQTT Page - Shows MQTT broker status and metrics
 */

import { useState } from "react";
import { Activity } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Device } from "../components/DeviceSidebar";
import { ApplicationsCard, Application } from "../components/ApplicationsCard";

interface ApplicationPageProps {
   device: Device;
    cpuHistory?: Array<{ time: string; value: number }>;
    memoryHistory?: Array<{ time: string; used: number; available: number }>;
    networkHistory?: Array<{ time: string; download: number; upload: number }>;
    applications?: Application[];
    onAddApplication?: (app: Omit<Application, "id">) => void;
    onUpdateApplication?: (app: Application) => void;
    onRemoveApplication?: (appId: string) => void;
    onToggleAppStatus?: (appId: string) => void;
    onToggleServiceStatus?: (appId: string, serviceId: number, action: "start" | "pause" | "stop") => void;
}

export function ApplicationPage({ 
  device, 
  applications = [],
  onAddApplication = () => {},
  onUpdateApplication = () => {},
  onRemoveApplication = () => {},
  onToggleAppStatus = () => {},
  onToggleServiceStatus = () => {},
} : ApplicationPageProps) {

  // Calculate running and total apps/services
  const runningApps = applications.filter(app => app.status === "running").length;
  const totalApps = applications.length;
  
  // Calculate sync status for applications
  const syncingApps = applications.filter(app => app.syncStatus === "syncing").length;
  const errorApps = applications.filter(app => app.syncStatus === "error").length;
  const pendingApps = applications.filter(app => app.syncStatus === "pending").length;
  const syncedApps = applications.filter(app => app.syncStatus === "synced").length;
  
  // Show total apps count as the main value
  const getAppValue = () => {
    return totalApps === 0 ? "0" : `${totalApps}`;
  };
  
  // Determine the subtitle for applications - show aggregate status
  const getAppSubtitle = () => {
    if (totalApps === 0) return "No apps";
    
    const statuses = [];
    
    if (errorApps > 0) statuses.push(`${errorApps} Error`);
    if (syncingApps > 0) statuses.push(`${syncingApps} Syncing`);
    if (pendingApps > 0) statuses.push(`${pendingApps} Pending`);
    if (syncedApps > 0) statuses.push(`${syncedApps} Synced`);
    
    return statuses.join(', ') || `${totalApps} Running`;
  };
  
  const getAppSubtitleColor = () => {
    // Priority: Error (red) > Syncing (blue) > Pending (yellow) > default (gray)
    if (errorApps > 0) return "text-red-600";
    if (syncingApps > 0) return "text-blue-600";
    if (pendingApps > 0) return "text-yellow-600";
    return "text-gray-500";
  };



  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">

        {/* Page Title */}
        <div className="space-y-2">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Applications</h2>
          <p className="text-sm text-muted-foreground">
            Monitor application status, connections, and resource usage
          </p>
        </div>

        {/* Application Card */}
         <ApplicationsCard
              deviceId={device.id}
              deviceUuid={device.deviceUuid}
              deviceStatus={device.status}
              applications={applications}
              onAddApplication={onAddApplication}
              onUpdateApplication={onUpdateApplication}
              onRemoveApplication={onRemoveApplication}
              onToggleStatus={onToggleAppStatus}
              onToggleServiceStatus={onToggleServiceStatus}
            />

      </div>
    </div>
  );
}
