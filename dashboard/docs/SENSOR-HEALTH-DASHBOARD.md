# Sensor Health Dashboard

Comprehensive monitoring dashboard for protocol adapter sensors (Modbus, CAN, OPC-UA).

## Overview

The sensor health dashboard provides **two-tier monitoring**:

1. **Protocol Adapter Devices** (Primary) - Hardware sensor connections (Modbus TCP/RTU, CAN bus, OPC-UA)
2. **Sensor Pipelines** (Secondary) - Internal data processing infrastructure

## Components

### Pages
- **`SensorHealthDashboard.tsx`** - Main dashboard page with summary cards, sensor table, and pipeline health
- **`SensorDetailPage.tsx`** - Detailed view with 24-hour charts (connection status, error trends, recent events)

### Components
- **`SensorSummaryCards.tsx`** - Four metric cards (Total/Online/Offline/Errors)
- **`SensorTable.tsx`** - Sensor list with status icons, error counts, expandable error details
- **`PipelineHealth.tsx`** - Collapsible infrastructure diagnostics
- **`SensorConnectionChart.tsx`** - Timeline showing connection/disconnection events (Recharts)
- **`SensorErrorChart.tsx`** - Area chart showing error accumulation over time (Recharts)

### Hooks
- **`useSensorHealth.ts`** - Fetches sensor data from `/api/v1/devices/:uuid/sensors`, auto-refreshes

## Data Flow

```
Agent (device) → API → Database → Dashboard
    ↓            ↓         ↓           ↓
10s reports  Stores  PostgreSQL  useSensorHealth hook
```

### Database Tables
- `protocol_adapter_health_history` - Device sensor status (Modbus/CAN/OPC-UA)
- `sensor_health_history` - Pipeline sensor status (internal processing)
- `protocol_adapter_health_latest` - Latest device status (VIEW)
- `sensor_health_latest` - Latest pipeline status (VIEW)

### API Endpoints
- `GET /api/v1/devices/:uuid/sensors` - Combined view (devices + pipelines + summary)
- `GET /api/v1/devices/:uuid/device-health` - Primary dashboard view (devices only)
- `GET /sensors/unhealthy` - Alert endpoint (unhealthy sensors across all devices)
- `GET /api/v1/devices/:uuid/sensors/:name/history?hours=24` - Sensor history for charts

## Integration

### Add to Main App

```tsx
import { SensorHealthDashboard } from '@/pages/SensorHealthDashboard';

function App() {
  const [selectedView, setSelectedView] = useState<'system' | 'sensors'>('system');
  const [selectedDeviceId, setSelectedDeviceId] = useState("device-uuid");

  return (
    <div>
      {/* Navigation tabs */}
      <Tabs value={selectedView} onValueChange={(v) => setSelectedView(v as any)}>
        <TabsList>
          <TabsTrigger value="system">System Metrics</TabsTrigger>
          <TabsTrigger value="sensors">Sensor Health</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Content */}
      {selectedView === 'system' ? (
        <SystemMetrics device={selectedDevice} />
      ) : (
        <SensorHealthDashboard deviceUuid={selectedDeviceId} />
      )}
    </div>
  );
}
```

### Navigation Button

Add a "Sensor Health" button to the existing dashboard:

```tsx
import { Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';

<Button onClick={() => navigate('/sensors')}>
  <Activity className="h-4 w-4 mr-2" />
  Sensor Health
</Button>
```

## Styling

Uses **shadcn/ui** (Radix UI primitives) + **Tailwind CSS**:
- Color-coded status badges (green=online, red=offline, yellow=error)
- Status icons (CheckCircle, XCircle, AlertTriangle)
- Responsive cards with proper spacing
- Clean table layout with hover effects

## Features

### Summary Cards
- **Total Sensors** - Blue card with Activity icon
- **Online** - Green card with CheckCircle icon  
- **Offline** - Red card with XCircle icon
- **Errors** - Yellow card with AlertTriangle icon

### Sensor Table
- Status icon (green checkmark, red X, yellow warning)
- Protocol badge (MODBUS, CAN, OPCUA)
- Status badge (Online/Offline/Error)
- Error count (red highlight if > 0)
- Last seen timestamp (human-readable: "2 mins ago")
- "View Details" button (opens detail page)
- Expandable error details row

### Pipeline Health
- Collapsible card showing infrastructure diagnostics
- Shows: State, Message counts, Last activity, Errors
- Only displayed if pipelines exist

### Sensor Detail Page
- Current status card (status, error count, last poll, last seen)
- Connection status chart (24-hour timeline)
- Error trend chart (shows error accumulation)
- Recent events list (connection/disconnection events)
- Back button to return to dashboard

## Auto-Refresh

Dashboard auto-refreshes every 10 seconds:
```tsx
useEffect(() => {
  const interval = setInterval(() => {
    refetch();
  }, 10000);
  
  return () => clearInterval(interval);
}, [refetch]);
```

## Error Handling

Graceful error states:
- Loading spinner while fetching data
- Error alert with message if API fails
- "No sensors configured" message if empty
- "No historical data available" in charts

## API Response Format

```json
{
  "devices": [
    {
      "name": "temperature-sensor",
      "protocol": "modbus",
      "status": "online",
      "connected": true,
      "lastPoll": "2025-01-15T10:30:00Z",
      "errorCount": 13,
      "lastError": "ETIMEDOUT",
      "lastSeen": "2025-01-15T10:30:15Z"
    }
  ],
  "pipelines": [
    {
      "name": "sensor-publish",
      "state": "running",
      "healthy": true,
      "messagesReceived": 150,
      "messagesPublished": 150,
      "lastActivity": "2025-01-15T10:30:00Z",
      "lastError": null,
      "lastSeen": "2025-01-15T10:30:15Z"
    }
  ],
  "summary": {
    "total": 2,
    "online": 1,
    "offline": 1,
    "errors": 13
  }
}
```

## Chart Configuration

**Connection Chart** (SensorConnectionChart):
- Type: Line chart (stepAfter)
- Y-axis: Binary (0 = No, 1 = Yes)
- Two lines: Connected (green), Healthy (blue)
- Shows connection state over time

**Error Chart** (SensorErrorChart):
- Type: Area chart with gradient
- Y-axis: Error count (auto-scaled)
- Fill: Red gradient
- Tooltip: Shows time, error count, last error message

## Dependencies

Already in `dashboard/package.json`:
- `recharts` 2.15.2 - Charts
- `lucide-react` 0.487.0 - Icons
- `@radix-ui/*` - shadcn/ui primitives
- `tailwind-merge`, `clsx` - Styling utilities

## Testing

1. Start agent with sensors configured
2. Verify data flowing to database:
   ```sql
   SELECT * FROM protocol_adapter_health_history ORDER BY reported_at DESC LIMIT 10;
   ```
3. Test API endpoint:
   ```bash
   curl http://localhost:3002/api/v1/devices/5c629f26-8495-4747-86e3-c2d98851aa62/sensors
   ```
4. Open dashboard and verify:
   - Summary cards show correct counts
   - Table displays sensors
   - Auto-refresh works (watch network tab)

## TODO

- [ ] Add routing for SensorDetailPage
- [ ] Create modal wrapper for detail page
- [ ] Add sensor detail API endpoint with history
- [ ] Implement real-time WebSocket updates
- [ ] Add toast notifications for status changes
- [ ] Create alert banner for critical offline sensors
- [ ] Add export/download functionality for sensor data
- [ ] Implement filtering/search for large sensor lists

## Architecture Notes

**Two-Tier Monitoring Strategy:**
1. **Protocol Adapter Devices** = What users care about (actual hardware sensors)
2. **Sensor Pipelines** = Infrastructure diagnostics (sensor-publish, protocol-adapters features)

**Why separate?**
- Users want to see "temperature sensor offline" (device), not "sensor-publish unhealthy" (pipeline)
- Pipeline issues affect all sensors, device issues are isolated
- Clear separation of concerns: hardware vs software

**Health Logic:**
- Smart health = connection + data flow
- `healthy = connected && (hasRecentData within 60s OR startup period)`
- Catches protocol adapter failures even when pipe is connected
