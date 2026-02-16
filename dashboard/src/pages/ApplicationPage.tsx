/**
 * MQTT Page - Shows MQTT broker status and metrics
 */

import { Device } from "../components/AgentSidebar";
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
              deviceUuid={device.deviceUuid}
              deviceStatus={device.status}
            />

      </div>
    </div>
  );
}
