import { Application, ApplicationsCard } from "../components/ApplicationsCard";
import { Device } from "../components/DeviceSidebar";
import { MetricCard } from "../components/ui/metric-card";
import { Package, Layers, Activity, AlertCircle } from "lucide-react";
import { ContainerLogsCard } from "../components/ContainerLogsCard";
import { useDeviceState } from "../contexts/DeviceStateContext";

interface ApplicationsPageProps {
  device: Device;
}

export function ApplicationsPage({
  device,
}: ApplicationsPageProps) {
  // Get applications from context
  const { getPendingApps, getTargetApps, hasPendingChanges } = useDeviceState();
  const pendingAppsMap = getPendingApps(device.deviceUuid);
  const targetApps = getTargetApps(device.deviceUuid);
  const apps = Object.keys(pendingAppsMap).length > 0 ? pendingAppsMap : targetApps;

  // Convert to Application format for stats
  const applications: Application[] = Object.entries(apps).map(([appId, app]: [string, any]) => ({
    id: appId,
    appId: app.appId,
    appName: app.appName,
    name: app.appName,
    image: app.services[0]?.imageName || "",
    status: app.services.some((s: any) => s.state === "running") ? "running" as const : "stopped" as const,
    syncStatus: hasPendingChanges(device.deviceUuid) ? "pending" as const : "synced" as const,
    services: app.services.map((s: any) => ({
      ...s,
      appId: app.appId,
      appName: app.appName,
      name: s.serviceName, // Add name field for ContainerLogsCard
      status: s.state as "running" | "stopped" | "paused" | undefined,
      config: {
        image: s.imageName,
        ...s.config,
      },
    })),
  }));
  // Calculate application statistics
  const totalApps = applications.length;
  const runningApps = applications.filter(app => 
    app.services?.some(s => s.status === "running")
  ).length;
  
  // Calculate service statistics
  const allServices = applications.flatMap(app => app.services || []);
  const totalServices = allServices.length;
  const runningServices = allServices.filter(s => s.status === "running").length;
  const stoppedServices = allServices.filter(s => s.status === "stopped").length;
  const pausedServices = allServices.filter(s => s.status === "paused").length;
  const pendingServices = allServices.filter(s => s.status === "pending").length;
  
  // Calculate sync status for applications
  const syncingApps = applications.filter(app => app.syncStatus === "syncing").length;
  const errorApps = applications.filter(app => app.syncStatus === "error").length;
  const pendingAppsCount = applications.filter(app => app.syncStatus === "pending").length;
  const syncedApps = applications.filter(app => app.syncStatus === "synced").length;

  const metrics = [
    {
      icon: Package,
      label: "Total Applications",
      value: totalApps.toString(),
      subtitle: `${runningApps} running`,
      color: "blue",
      bgColor: "bg-blue-50",
      iconColor: "text-blue-600",
    },
    {
      icon: Layers,
      label: "Total Services",
      value: totalServices.toString(),
      subtitle: `${runningServices} running, ${stoppedServices} stopped`,
      color: "purple",
      bgColor: "bg-purple-50",
      iconColor: "text-purple-600",
    },
    {
      icon: Activity,
      label: "Service Status",
      value: pausedServices > 0 ? `${pausedServices} paused` : `${runningServices} active`,
      subtitle: pendingServices > 0 ? `${pendingServices} pending` : "All synced",
      color: pausedServices > 0 ? "orange" : "green",
      bgColor: pausedServices > 0 ? "bg-orange-50" : "bg-green-50",
      iconColor: pausedServices > 0 ? "text-orange-600" : "text-green-600",
    },
    {
      icon: AlertCircle,
      label: "Sync Status",
      value: errorApps > 0 ? `${errorApps} errors` : syncingApps > 0 ? `${syncingApps} syncing` : "All synced",
      subtitle: pendingAppsCount > 0 ? `${pendingAppsCount} pending deployment` : `${syncedApps} synced`,
      color: errorApps > 0 ? "red" : syncingApps > 0 ? "blue" : "green",
      bgColor: errorApps > 0 ? "bg-red-50" : syncingApps > 0 ? "bg-blue-50" : "bg-green-50",
      iconColor: errorApps > 0 ? "text-red-600" : syncingApps > 0 ? "text-blue-600" : "text-green-600",
    },
  ];

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-foreground mb-2">Applications</h2>
          <p className="text-muted-foreground">
            Manage containerized applications and services
          </p>
        </div>

        {/* Quick Metrics **/}
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

        {/* Applications and Logs Side by Side */}
        
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Applications Card */}
          <ApplicationsCard
            deviceUuid={device.deviceUuid}
            deviceStatus={device.status}
          />

          {/* Container Logs Card */}
          <ContainerLogsCard
            deviceUuid={device.deviceUuid}
            applications={applications as any}
          />
        </div>
      </div>
    </div>
  );
}
