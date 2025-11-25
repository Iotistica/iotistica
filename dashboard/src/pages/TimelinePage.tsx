import { Badge } from "./ui/badge";
import { Device } from "./DeviceSidebar";
import { TimelineCard } from "./TimelineCard";

interface TimelinePageProps {
  device: Device;
}

export function TimelinePage({ device }: TimelinePageProps) {
  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">


        {/* Page Title */}
        <div>
          <h2 className="text-2xl font-bold text-foreground mb-2">Event Timeline</h2>
          <p className="text-muted-foreground">System events and activity history</p>
        </div>

        {/* Timeline Card */}
        <TimelineCard
          deviceId={device.deviceUuid}
          limit={50}
          autoRefresh={true}
          refreshInterval={30000}
        />
      </div>
    </div>
  );
}
