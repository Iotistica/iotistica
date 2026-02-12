import { useState, useEffect } from "react";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import {
  CheckCircle2,
  XCircle,
  Circle,
  Clock,
  Wifi,
  WifiOff,
  Info,
  RefreshCw,
  Container,
  Settings,
  Activity,
  Loader2,
} from "lucide-react";
import { Button } from "./ui/button";
import { buildApiUrl } from "@/config/api";

interface TimelineEvent {
  id: string;
  event_id: string;
  timestamp: string;
  type: string;
  category: string;
  title: string;
  description: string;
  data: any;
  metadata: any;
  source?: string;
  correlation_id?: string;
  event_timestamp?: string;
}

interface TimelineCardProps {
  deviceId?: string;
  limit?: number;
  autoRefresh?: boolean;
  refreshInterval?: number;
}

export function TimelineCard({
  deviceId,
  limit = 5,
  autoRefresh = true,
  refreshInterval = 30000,
}: TimelineCardProps) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const parseMaybeJson = (value: unknown) => {
    if (!value) return value;
    if (typeof value !== "string") return value;

    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  };

  const normalizeEvent = (event: TimelineEvent) => {
    return {
      ...event,
      timestamp: event.timestamp || event.event_timestamp || null,
      data: parseMaybeJson(event.data),
      metadata: parseMaybeJson(event.metadata),
    } as TimelineEvent;
  };

  // Fetch events from API
  const fetchEvents = async () => {
    try {
      setError(null);
      
      // Determine API endpoint based on whether deviceId is provided
      const endpoint = deviceId 
        ? `/api/v1/events/device/${deviceId}?limit=${limit}`
        : `/api/v1/events/recent?limit=${limit}`; // Global view - all devices
      
      const response = await fetch(buildApiUrl(endpoint));

      if (!response.ok) {
        throw new Error(`Failed to fetch events: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.success && data.events) {
        // Get the latest events (API already returns them in order)
        const latestEvents = data.events.slice(0, limit).map(normalizeEvent);
        setEvents(latestEvents as TimelineEvent[]);
        setLastRefresh(new Date());
      } else {
        throw new Error(data.error || 'Failed to fetch events');
      }
    } catch (err) {
      console.error('[TimelineCard] Error fetching events:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch events');
    } finally {
      setLoading(false);
    }
  };

  // Initial fetch
  useEffect(() => {
    fetchEvents();
  }, [deviceId, limit]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      fetchEvents();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, deviceId, limit]);

  const handleManualRefresh = () => {
    setLoading(true);
    fetchEvents();
  };

  const getEventIcon = (type: string) => {
    switch (type) {
      case "device.provisioned":
        return <CheckCircle2 className="w-4 h-4" />;
      case "device.online":
        return <Wifi className="w-4 h-4" />;
      case "device.offline":
        return <WifiOff className="w-4 h-4" />;
      case "container.start":
      case "container.stop":
      case "container.restart":
        return <Container className="w-4 h-4" />;
      case "target_state.updated":
      case "current_state.updated":
        return <Settings className="w-4 h-4" />;
      case "reconciliation.started":
      case "reconciliation.completed":
        return <Activity className="w-4 h-4" />;
      default:
        return <Circle className="w-4 h-4" />;
    }
  };

  const getEventColor = (type: string, category: string) => {
    // Color by category first, then specific types
    switch (category) {
      case "agent":
        if (type === "device.online") {
          return {
            bg: "bg-green-50 dark:bg-green-950/30",
            text: "text-green-600 dark:text-green-400",
            border: "border-green-200 dark:border-green-800",
            badgeBg: "bg-green-100 dark:bg-green-900/50",
            badgeText: "text-green-700 dark:text-green-300",
            badgeBorder: "border-green-200 dark:border-green-800",
          };
        }
        if (type === "device.offline") {
          return {
            bg: "bg-red-50 dark:bg-red-950/30",
            text: "text-red-600 dark:text-red-400",
            border: "border-red-200 dark:border-red-800",
            badgeBg: "bg-red-100 dark:bg-red-900/50",
            badgeText: "text-red-700 dark:text-red-300",
            badgeBorder: "border-red-200 dark:border-red-800",
          };
        }
        return {
          bg: "bg-blue-50 dark:bg-blue-950/30",
          text: "text-blue-600 dark:text-blue-400",
          border: "border-blue-200 dark:border-blue-800",
          badgeBg: "bg-blue-100 dark:bg-blue-900/50",
          badgeText: "text-blue-700 dark:text-blue-300",
          badgeBorder: "border-blue-200 dark:border-blue-800",
        };
      case "container":
      case "application":
        return {
          bg: "bg-purple-50 dark:bg-purple-950/30",
          text: "text-purple-600 dark:text-purple-400",
          border: "border-purple-200 dark:border-purple-800",
          badgeBg: "bg-purple-100 dark:bg-purple-900/50",
          badgeText: "text-purple-700 dark:text-purple-300",
          badgeBorder: "border-purple-200 dark:border-purple-800",
        };
      case "configuration":
        return {
          bg: "bg-yellow-50 dark:bg-yellow-950/30",
          text: "text-yellow-600 dark:text-yellow-400",
          border: "border-yellow-200 dark:border-yellow-800",
          badgeBg: "bg-yellow-100 dark:bg-yellow-900/50",
          badgeText: "text-yellow-700 dark:text-yellow-300",
          badgeBorder: "border-yellow-200 dark:border-yellow-800",
        };
      case "system":
        return {
          bg: "bg-indigo-50 dark:bg-indigo-950/30",
          text: "text-indigo-600 dark:text-indigo-400",
          border: "border-indigo-200 dark:border-indigo-800",
          badgeBg: "bg-indigo-100 dark:bg-indigo-900/50",
          badgeText: "text-indigo-700 dark:text-indigo-300",
          badgeBorder: "border-indigo-200 dark:border-indigo-800",
        };
      case "telemetry":
        return {
          bg: "bg-teal-50 dark:bg-teal-950/30",
          text: "text-teal-600 dark:text-teal-400",
          border: "border-teal-200 dark:border-teal-800",
          badgeBg: "bg-teal-100 dark:bg-teal-900/50",
          badgeText: "text-teal-700 dark:text-teal-300",
          badgeBorder: "border-teal-200 dark:border-teal-800",
        };
      case "provisioning":
        return {
          bg: "bg-orange-50 dark:bg-orange-950/30",
          text: "text-orange-600 dark:text-orange-400",
          border: "border-orange-200 dark:border-orange-800",
          badgeBg: "bg-orange-100 dark:bg-orange-900/50",
          badgeText: "text-orange-700 dark:text-orange-300",
          badgeBorder: "border-orange-200 dark:border-orange-800",
        };
      default:
        return {
          bg: "bg-gray-50 dark:bg-gray-900/50",
          text: "text-gray-600 dark:text-gray-400",
          border: "border-gray-200 dark:border-gray-700",
          badgeBg: "bg-gray-100 dark:bg-gray-800",
          badgeText: "text-gray-700 dark:text-gray-300",
          badgeBorder: "border-gray-200 dark:border-gray-700",
        };
    }
  };

  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateString;
    }
  };

  const getEventTimestamp = (event: TimelineEvent) => {
    // Primary timestamp from event
    if (event.timestamp) return event.timestamp;
    if (event.event_timestamp) return event.event_timestamp;
    
    // Fallback to data timestamps
    if (event.data?.created_at) return event.data.created_at;
    if (event.data?.updated_at) return event.data.updated_at;
    if (event.data?.provisioned_at) return event.data.provisioned_at;
    if (event.data?.detected_at) return event.data.detected_at;
    if (event.data?.came_online_at) return event.data.came_online_at;
    if (event.data?.last_seen) return event.data.last_seen;
    if (event.metadata?.createdAt) return event.metadata.createdAt;
    return null;
  };

  const renderEventDetails = (event: TimelineEvent) => {
    const details: { label: string; value: string }[] = [];

    // Common details based on event type
    if (event.type === "device.provisioned") {
      if (event.data?.device_name)
        details.push({ label: "Device", value: event.data.device_name });
      if (event.data?.ip_address)
        details.push({ label: "IP Address", value: event.data.ip_address });
      if (event.data?.mac_address)
        details.push({ label: "MAC Address", value: event.data.mac_address });
      if (event.data?.os_version)
        details.push({ label: "OS Version", value: event.data.os_version });
    } else if (event.type === "device.offline") {
      if (event.data?.reason)
        details.push({ label: "Reason", value: event.data.reason });
      if (event.data?.last_seen)
        details.push({
          label: "Last Seen",
          value: formatDate(event.data.last_seen),
        });
      if (event.data?.offline_threshold_minutes)
        details.push({
          label: "Threshold",
          value: `${event.data.offline_threshold_minutes} minutes`,
        });
    } else if (event.type === "device.online") {
      if (event.data?.reason)
        details.push({ label: "Reason", value: event.data.reason });
      if (event.data?.offline_duration_minutes !== undefined) {
        const duration = Math.abs(event.data.offline_duration_minutes);
        details.push({
          label: "Offline Duration",
          value: `${duration} minutes`,
        });
      }
    } else if (event.type.startsWith("container.")) {
      if (event.data?.container_name)
        details.push({ label: "Container", value: event.data.container_name });
      if (event.data?.app_name)
        details.push({ label: "Application", value: event.data.app_name });
      if (event.data?.image)
        details.push({ label: "Image", value: event.data.image });
    } else if (event.type.startsWith("target_state.")) {
      if (event.data?.changed_fields && Array.isArray(event.data.changed_fields)) {
        details.push({ label: "Changed", value: event.data.changed_fields.join(", ") });
      }
    } else if (event.type.startsWith("reconciliation.")) {
      if (event.data?.actions_count !== undefined)
        details.push({ label: "Actions", value: String(event.data.actions_count) });
      if (event.data?.duration_ms !== undefined)
        details.push({ label: "Duration", value: `${event.data.duration_ms}ms` });
    }

    // Add source if available
    if (event.source) {
      details.push({ label: "Source", value: event.source });
    }

    // Fallback: show first few data fields if no structured details matched
    if (details.length === 0 && event.data && typeof event.data === "object") {
      const entries = Object.entries(event.data).slice(0, 3);
      entries.forEach(([key, value]) => {
        if (value === null || value === undefined) return;
        details.push({ label: key, value: String(value) });
      });
    }

    return details;
  };

  return (
    <Card className="flex flex-col h-[600px]">
      {/* Sticky Header */}
      <div className="flex-shrink-0 bg-background border-b border-border p-4 md:p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 bg-indigo-50 dark:bg-indigo-950/30 rounded-lg flex items-center justify-center flex-shrink-0">
              <Clock className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h3 className="text-lg text-foreground font-medium mb-1">Timeline</h3>
              <p className="text-sm text-muted-foreground">
                {loading ? "Loading events..." : `Device activity and system events`}
              </p>
              {!loading && lastRefresh && (
                <p className="text-xs text-muted-foreground mt-1">
                  Last updated: {lastRefresh.toLocaleTimeString()}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {events.length > 0 && (
              <Badge variant="outline" className="bg-muted text-muted-foreground border-border">
                {events.length} {events.length === 1 ? "event" : "events"}
              </Badge>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleManualRefresh}
              disabled={loading}
              className="h-8 w-8 p-0"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Scrollable Events Section */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
        <div className="p-4 md:p-6">
        {error ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-12 h-12 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mb-3">
              <XCircle className="w-6 h-6 text-red-400 dark:text-red-500" />
            </div>
            <p className="text-red-600 dark:text-red-400 font-medium">Failed to load events</p>
            <p className="text-sm text-muted-foreground mt-1">{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleManualRefresh}
              className="mt-3"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Try Again
            </Button>
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Loader2 className="w-8 h-8 text-indigo-600 dark:text-indigo-400 animate-spin mb-3" />
            <p className="text-muted-foreground">Loading events...</p>
          </div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-3">
              <Info className="w-6 h-6 text-muted-foreground" />
            </div>
            <p className="text-foreground">No events to display</p>
            <p className="text-sm text-muted-foreground mt-1">Events will appear here as they occur</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Timestamp</th>
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Category</th>
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Event</th>
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Description</th>
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground hidden lg:table-cell">Details</th>
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground hidden xl:table-cell">Event ID</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => {
                  const colors = getEventColor(event.type, event.category);
                  const timestamp = getEventTimestamp(event);
                  const details = renderEventDetails(event);

                  return (
                    <tr key={event.id} className="border-b border-border last:border-0 hover:bg-muted">
                      <td className="py-3 px-4 text-muted-foreground whitespace-nowrap">
                        {timestamp ? formatDate(timestamp) : '-'}
                      </td>
                      <td className="py-3 px-4">
                        <Badge
                          variant="outline"
                          className={`${colors.badgeBg} ${colors.badgeText} ${colors.badgeBorder}`}
                        >
                          {event.category}
                        </Badge>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <div className={`${colors.text}`}>
                            {getEventIcon(event.type)}
                          </div>
                          <span className="font-medium text-foreground">{event.title}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-foreground max-w-md">
                        {event.description || '-'}
                      </td>
                      <td className="py-3 px-4 hidden lg:table-cell">
                        {details.length > 0 ? (
                          <div className="space-y-1">
                            {details.slice(0, 3).map((detail, idx) => (
                              <div key={idx} className="text-xs">
                                <span className="text-muted-foreground">{detail.label}:</span>{' '}
                                <span className="text-foreground">{detail.value}</span>
                              </div>
                            ))}
                            {details.length > 3 && (
                              <div className="text-xs text-muted-foreground">
                                +{details.length - 3} more
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="py-3 px-4 hidden xl:table-cell">
                        <code className="text-xs font-mono text-muted-foreground">
                          {event.event_id}
                        </code>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </div>
    </Card>
  );
}
