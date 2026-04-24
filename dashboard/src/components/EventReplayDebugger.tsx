import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import {
  Play,
  GitCompare,
  Camera,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ChevronRight,
  ChevronDown,
  Code,
} from "lucide-react";
import { buildApiUrl } from "@/config/api";

interface Event {
  event_id: string;
  event_type: string;
  timestamp: string;
  data: any;
  metadata?: any;
  actor_type?: string;
  actor_id?: string;
  severity?: string;
}

interface ReplayResult {
  events_replayed: number;
  final_state: any;
  errors: string[];
  events: Event[];
}

interface Snapshot {
  timestamp: string;
  device_uuid: string;
  target_state: any;
  current_state: any;
  containers: Record<string, any>;
  jobs: Record<string, any>;
  online: boolean | null;
  last_seen: string | null;
  offline_since: string | null;
  event_count: number;
  last_event_type?: string;
}

interface StateChange {
  field: string;
  old_value: any;
  new_value: any;
  events_involved: string[];
}

interface ComparisonResult {
  time1_snapshot: Snapshot;
  time2_snapshot: Snapshot;
  changes: StateChange[];
  events_between: Event[];
  changes_count: number;
  events_between_count: number;
}

interface EventReplayDebuggerProps {
  deviceUuid: string;
}

export function EventReplayDebugger({ deviceUuid }: EventReplayDebuggerProps) {
  const [mode, setMode] = useState<"replay" | "snapshot" | "compare">("replay");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Replay state
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [currentEventIndex, setCurrentEventIndex] = useState(0);
  const [fromTime, setFromTime] = useState<string>("");
  const [toTime, setToTime] = useState<string>("");

  // Snapshot state
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotTime, setSnapshotTime] = useState<string>("");

  // Comparison state
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [compareTime1, setCompareTime1] = useState<string>("");
  const [compareTime2, setCompareTime2] = useState<string>("");
  const [expandedChanges, setExpandedChanges] = useState<Set<string>>(new Set());

  // Quick time presets
  const setLastHour = () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    setFromTime(oneHourAgo.toISOString());
    setToTime(now.toISOString());
  };

  const setLast30Minutes = () => {
    const now = new Date();
    const thirtyMinsAgo = new Date(now.getTime() - 30 * 60 * 1000);
    setSnapshotTime(thirtyMinsAgo.toISOString());
  };

  const setCompareLastHour = () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    setCompareTime1(oneHourAgo.toISOString());
    setCompareTime2(now.toISOString());
  };

  // Execute replay
  const executeReplay = async () => {
    if (!fromTime || !toTime) {
      setError("Please select both start and end times");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        buildApiUrl(`/api/v1/events/device/${deviceUuid}/replay`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fromTime, toTime }),
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to replay events: ${response.statusText}`);
      }

      const data = await response.json();
      setReplayResult(data);
      setCurrentEventIndex(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to replay events");
    } finally {
      setLoading(false);
    }
  };

  // Execute snapshot
  const executeSnapshot = async () => {
    if (!snapshotTime) {
      setError("Please select a timestamp");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        buildApiUrl(`/api/v1/events/device/${deviceUuid}/snapshot`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timestamp: snapshotTime }),
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to create snapshot: ${response.statusText}`);
      }

      const data = await response.json();
      setSnapshot(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create snapshot");
    } finally {
      setLoading(false);
    }
  };

  // Execute comparison
  const executeComparison = async () => {
    if (!compareTime1 || !compareTime2) {
      setError("Please select both timestamps");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        buildApiUrl(`/api/v1/events/device/${deviceUuid}/compare`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ time1: compareTime1, time2: compareTime2 }),
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to compare states: ${response.statusText}`);
      }

      const data = await response.json();
      setComparison(data);
      setExpandedChanges(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to compare states");
    } finally {
      setLoading(false);
    }
  };

  const toggleChange = (field: string) => {
    const newExpanded = new Set(expandedChanges);
    if (newExpanded.has(field)) {
      newExpanded.delete(field);
    } else {
      newExpanded.add(field);
    }
    setExpandedChanges(newExpanded);
  };

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const getSeverityColor = (severity?: string) => {
    switch (severity) {
      case "error":
      case "critical":
        return "bg-red-100 text-red-700 border-red-200";
      case "warning":
        return "bg-yellow-100 text-yellow-700 border-yellow-200";
      case "info":
        return "bg-blue-100 text-blue-700 border-blue-200";
      case "debug":
        return "bg-gray-100 text-gray-700 border-gray-200";
      default:
        return "bg-gray-100 text-gray-600 border-gray-200";
    }
  };

  return (
    <div className="space-y-4">
      {/* Mode Selector */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Code className="h-5 w-5" />
            Event Replay Debugger
          </CardTitle>
          <CardDescription>
            Debug device issues by replaying events and comparing states
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Button
              variant={mode === "replay" ? "default" : "outline"}
              onClick={() => setMode("replay")}
              className="flex items-center gap-2"
            >
              <Play className="h-4 w-4" />
              Replay Events
            </Button>
            <Button
              variant={mode === "snapshot" ? "default" : "outline"}
              onClick={() => setMode("snapshot")}
              className="flex items-center gap-2"
            >
              <Camera className="h-4 w-4" />
              Time Snapshot
            </Button>
            <Button
              variant={mode === "compare" ? "default" : "outline"}
              onClick={() => setMode("compare")}
              className="flex items-center gap-2"
            >
              <GitCompare className="h-4 w-4" />
              Compare States
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Error Display */}
      {error && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-red-700">
              <AlertCircle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Replay Mode */}
      {mode === "replay" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Event Replay</CardTitle>
            <CardDescription>
              Replay events within a time window to see what happened
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-2 block">From Time</label>
                <input
                  type="datetime-local"
                  value={fromTime ? fromTime.slice(0, 16) : ""}
                  onChange={(e) => setFromTime(new Date(e.target.value).toISOString())}
                  className="w-full px-3 py-2 border rounded-md"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">To Time</label>
                <input
                  type="datetime-local"
                  value={toTime ? toTime.slice(0, 16) : ""}
                  onChange={(e) => setToTime(new Date(e.target.value).toISOString())}
                  className="w-full px-3 py-2 border rounded-md"
                />
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={setLastHour} variant="outline" size="sm">
                Last Hour
              </Button>
              <Button
                onClick={executeReplay}
                disabled={loading || !fromTime || !toTime}
                className="flex items-center gap-2"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Replay
              </Button>
            </div>

            {replayResult && (
              <div className="mt-6 space-y-4">
                <div className="grid grid-cols-3 gap-4">
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-2xl font-bold">{replayResult.events_replayed}</div>
                      <div className="text-sm text-muted-foreground">Events Replayed</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-2xl font-bold">{replayResult.errors.length}</div>
                      <div className="text-sm text-muted-foreground">Errors</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-2xl font-bold">
                        {replayResult.final_state.online ? "Online" : "Offline"}
                      </div>
                      <div className="text-sm text-muted-foreground">Final Status</div>
                    </CardContent>
                  </Card>
                </div>

                <Separator />

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Events List */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Event Timeline</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ScrollArea className="h-[400px]">
                        <div className="space-y-2">
                          {replayResult.events.map((event, index) => (
                            <div
                              key={event.event_id}
                              className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                                index === currentEventIndex
                                  ? "border-blue-500 bg-blue-50"
                                  : "hover:bg-gray-50"
                              }`}
                              onClick={() => setCurrentEventIndex(index)}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium text-sm truncate">{event.event_type}</div>
                                  <div className="text-xs text-muted-foreground">
                                    {formatTimestamp(event.timestamp)}
                                  </div>
                                </div>
                                {event.severity && (
                                  <Badge variant="outline" className={getSeverityColor(event.severity)}>
                                    {event.severity}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </CardContent>
                  </Card>

                  {/* State View */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Final State</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ScrollArea className="h-[400px]">
                        <pre className="text-xs font-mono bg-gray-50 p-4 rounded overflow-x-auto">
                          {JSON.stringify(replayResult.final_state, null, 2)}
                        </pre>
                      </ScrollArea>
                    </CardContent>
                  </Card>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Snapshot Mode */}
      {mode === "snapshot" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Point-in-Time Snapshot</CardTitle>
            <CardDescription>
              View device state at a specific moment in history
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Snapshot Timestamp</label>
              <input
                type="datetime-local"
                value={snapshotTime ? snapshotTime.slice(0, 16) : ""}
                onChange={(e) => setSnapshotTime(new Date(e.target.value).toISOString())}
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>

            <div className="flex gap-2">
              <Button onClick={setLast30Minutes} variant="outline" size="sm">
                30 Minutes Ago
              </Button>
              <Button
                onClick={executeSnapshot}
                disabled={loading || !snapshotTime}
                className="flex items-center gap-2"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                Create Snapshot
              </Button>
            </div>

            {snapshot && (
              <div className="mt-6 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-2xl font-bold">{snapshot.event_count}</div>
                      <div className="text-sm text-muted-foreground">Events Processed</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-sm font-medium truncate">{snapshot.last_event_type || "N/A"}</div>
                      <div className="text-sm text-muted-foreground">Last Event</div>
                    </CardContent>
                  </Card>
                </div>

                <Separator />

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Target State</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ScrollArea className="h-[400px]">
                        <pre className="text-xs font-mono bg-gray-50 p-4 rounded overflow-x-auto">
                          {JSON.stringify(snapshot.target_state, null, 2)}
                        </pre>
                      </ScrollArea>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Current State</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ScrollArea className="h-[400px]">
                        <pre className="text-xs font-mono bg-gray-50 p-4 rounded overflow-x-auto">
                          {JSON.stringify(snapshot.current_state, null, 2)}
                        </pre>
                      </ScrollArea>
                    </CardContent>
                  </Card>
                </div>

                {/* Container States */}
                {snapshot.containers && Object.keys(snapshot.containers).length > 0 && (
                  <div className="mt-4">
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">Containers Running at {new Date(snapshot.timestamp).toLocaleString()}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2">
                          {Object.entries(snapshot.containers).map(([id, container]: [string, any]) => (
                            <div key={id} className="flex items-center justify-between p-3 bg-gray-50 rounded border">
                              <div className="flex-1">
                                <div className="font-mono text-sm font-medium">{container.container_name || id}</div>
                                {container.started_at && (
                                  <div className="text-xs text-gray-500 mt-1">
                                    Started: {new Date(container.started_at).toLocaleString()}
                                  </div>
                                )}
                              </div>
                              <span className={`px-3 py-1 rounded text-xs font-semibold ${
                                container.state === 'running' ? 'bg-green-100 text-green-800' :
                                container.state === 'paused' ? 'bg-yellow-100 text-yellow-800' :
                                'bg-gray-100 text-gray-800'
                              }`}>
                                {container.state}
                              </span>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* Device Status */}
                <div className="mt-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Device Status</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">Status:</span>
                          <span className={`px-3 py-1 rounded text-sm font-semibold ${
                            snapshot.online ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                          }`}>
                            {snapshot.online ? 'Online' : 'Offline'}
                          </span>
                        </div>
                        {snapshot.last_seen && (
                          <div className="text-sm text-gray-600">
                            Last seen: {new Date(snapshot.last_seen).toLocaleString()}
                          </div>
                        )}
                        {snapshot.offline_since && (
                          <div className="text-sm text-red-600">
                            Offline since: {new Date(snapshot.offline_since).toLocaleString()}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Compare Mode */}
      {mode === "compare" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">State Comparison</CardTitle>
            <CardDescription>
              Compare device state between two points in time
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Earlier Time</label>
                <input
                  type="datetime-local"
                  value={compareTime1 ? compareTime1.slice(0, 16) : ""}
                  onChange={(e) => setCompareTime1(new Date(e.target.value).toISOString())}
                  className="w-full px-3 py-2 border rounded-md"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Later Time</label>
                <input
                  type="datetime-local"
                  value={compareTime2 ? compareTime2.slice(0, 16) : ""}
                  onChange={(e) => setCompareTime2(new Date(e.target.value).toISOString())}
                  className="w-full px-3 py-2 border rounded-md"
                />
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={setCompareLastHour} variant="outline" size="sm">
                Last Hour
              </Button>
              <Button
                onClick={executeComparison}
                disabled={loading || !compareTime1 || !compareTime2}
                className="flex items-center gap-2"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitCompare className="h-4 w-4" />}
                Compare
              </Button>
            </div>

            {comparison && (
              <div className="mt-6 space-y-4">
                <div className="grid grid-cols-3 gap-4">
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-2xl font-bold">{comparison.changes_count}</div>
                      <div className="text-sm text-muted-foreground">Changes Detected</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-2xl font-bold">{comparison.events_between_count}</div>
                      <div className="text-sm text-muted-foreground">Events Between</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-2xl font-bold">
                        {comparison.time1_snapshot.event_count} → {comparison.time2_snapshot.event_count}
                      </div>
                      <div className="text-sm text-muted-foreground">Total Events</div>
                    </CardContent>
                  </Card>
                </div>

                <Separator />

                {/* Changes List */}
                {comparison.changes_count > 0 ? (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Detected Changes</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ScrollArea className="h-[500px]">
                        <div className="space-y-3">
                          {comparison.changes.map((change, index) => (
                            <div key={index} className="border rounded-lg">
                              <div
                                className="p-3 cursor-pointer hover:bg-gray-50 flex items-center justify-between"
                                onClick={() => toggleChange(change.field)}
                              >
                                <div className="flex items-center gap-2">
                                  {expandedChanges.has(change.field) ? (
                                    <ChevronDown className="h-4 w-4" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4" />
                                  )}
                                  <span className="font-medium">{change.field}</span>
                                </div>
                                <Badge variant="outline">
                                  {change.events_involved.length} events
                                </Badge>
                              </div>

                              {expandedChanges.has(change.field) && (
                                <div className="p-3 pt-0 space-y-3">
                                  <div className="grid grid-cols-2 gap-3">
                                    <div>
                                      <div className="text-xs font-medium text-muted-foreground mb-1">
                                        Old Value
                                      </div>
                                      <pre className="text-xs font-mono bg-red-50 p-2 rounded border border-red-200 overflow-x-auto">
                                        {JSON.stringify(change.old_value, null, 2)}
                                      </pre>
                                    </div>
                                    <div>
                                      <div className="text-xs font-medium text-muted-foreground mb-1">
                                        New Value
                                      </div>
                                      <pre className="text-xs font-mono bg-green-50 p-2 rounded border border-green-200 overflow-x-auto">
                                        {JSON.stringify(change.new_value, null, 2)}
                                      </pre>
                                    </div>
                                  </div>

                                  {change.events_involved.length > 0 && (
                                    <div>
                                      <div className="text-xs font-medium text-muted-foreground mb-1">
                                        Events Involved
                                      </div>
                                      <div className="flex flex-wrap gap-1">
                                        {change.events_involved.map((evt, i) => (
                                          <Badge key={i} variant="secondary" className="text-xs">
                                            {evt}
                                          </Badge>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </CardContent>
                  </Card>
                ) : (
                  <Card className="border-green-200 bg-green-50">
                    <CardContent className="pt-6">
                      <div className="flex items-center gap-2 text-green-700">
                        <CheckCircle2 className="h-4 w-4" />
                        <span>No changes detected between the selected times</span>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
