# Alerts Page - Implementation Checklist

## ⚡ CRITICAL: Schema Fix Applied

**Migration**: `api/database/migrations/134_anomaly_endpoint_tracking.sql`  
**Status**: ✅ Migration file created, runs automatically on API build  
**Action Required**: Rebuild API container + Update agent code

The anomaly system now tracks **monitored devices** (e.g., "COMAP-Main-Controller") instead of agent UUIDs. See Phase 1 and 1b below.

---

## Quick Start
This checklist outlines the step-by-step implementation of the Anomaly Alerts page based on the design in `docs/ALERTS-PAGE-DESIGN.md`.

---

## Phase 1: Database Schema Updates ⚡
**Estimated Time**: Auto (runs on build)

### ⚠️ CRITICAL FIX: Track Monitored Devices, Not Agent UUIDs

The original schema stored agent UUIDs in `device_id`, which is useless for users. They care about **monitored devices** (e.g., "COMAP-Main-Controller", "Temp-Sensor-01"), not infrastructure.

**Migration File**: `api/database/migrations/134_anomaly_endpoint_tracking.sql`

**⚡ AUTO-RUN**: Migrations run automatically when API container builds. Nothing to do manually!

- [x] Migration file already created at `134_anomaly_endpoint_tracking.sql`
- [ ] Rebuild API container to apply migration:
  ```bash
  cd api
  docker compose up -d api --build
  ```

- [ ] Verify migration applied successfully:
  ```bash
  # Check logs for migration execution
  docker compose logs api | grep "Migration.*134_anomaly_endpoint_tracking"
  
  # Or check database schema directly
  docker compose exec postgres psql -U postgres -d iotistic -c "\\d anomaly_events"
  ```

**Schema Changes**:
- Renamed `device_id` → `agent_uuid` in anomaly_events
- Added `device_name` and `device_type` to all tables
- Kept `affected_devices` column (already correct naming)
- Added acknowledgment tracking columns

- [ ] ⚠️ **IMPORTANT**: Update agent code to send `deviceName` and `deviceType` in anomaly events
  - See "Phase 1b: Agent MQTT Event Update" below

---

## Phase 2: Backend API Routes ⚡
**Estimated Time**: 2-3 days

### Step 1: Create Incidents API Routes (Priority 1)
**File**: `api/src/routes/anomaly-incidents.ts`

- [ ] Implement `GET /api/v1/anomaly-incidents`
  - Query params: status, severity, **deviceName**, **deviceType**, metric, startTime, endTime, limit, offset
  - Return: `{ incidents: Incident[], total: number, hasMore: boolean }`
  - SQL: Query `anomaly_incidents` with filters and pagination
  - Joins: Load device details if needed

- [ ] Implement `GET /api/v1/anomaly-incidents/:incidentId`
  - Return full incident details
  - Include related events from `anomaly_events` (JOIN on fingerprint)
  - Include alerts from `anomaly_alerts` (JOIN on incident_id)

- [ ] Implement `PATCH /api/v1/anomaly-incidents/:incidentId/resolve`
  - Body: `{ resolvedBy: string, notes: string }`
  - Update: `status = 'resolved'`, `acknowledged_at = NOW()`, `acknowledged_by`, `resolution_notes`
  - Return: Updated incident

- [ ] Implement `GET /api/v1/anomaly-incidents/stats`
  - Query params: hours (default 24)
  - Return:
    ```typescript
    {
      total: number,
      byStatus: { open: number, active: number, resolved: number },
      bySeverity: { info: number, warning: number, critical: number },
      topMetrics: { metric: string, count: number }[],
      topDevices: { deviceName: string, count: number }[],  // ✅ NEW
      affectedDevices: number  // Count of unique device names
    }
    ```

- [ ] Add routes to `api/src/index.ts`
  ```typescript
  import anomalyIncidentsRoutes from './routes/anomaly-incidents';
  app.use('/api/v1', anomalyIncidentsRoutes);
  ```

### Step 2: Create Alerts API Routes (Priority 2)
**File**: `api/src/routes/anomaly-alerts.ts`

- [ ] Implement `GET /api/v1/anomaly-alerts`
  - Query params: severity, startTime, endTime, limit, offset
  - Return: `{ alerts: Alert[], total: number, hasMore: boolean }`

- [ ] Implement `GET /api/v1/anomaly-alerts/:alertId`
  - Return alert with incident context (JOIN on incident_id)

- [ ] Add routes to `api/src/index.ts`

### Step 3: Test API Endpoints
- [ ] Use Postman/curl to test all endpoints
- [ ] Verify pagination works correctly
- [ ] Check filtering logic (status, severity, time range)
- [ ] Verify JOIN queries return correct data
- [ ] Test with empty results (graceful handling)

---

## Phase 3: Frontend Components 🎨
**Estimated Time**: 3-4 days

### Step 1: Create Badge Components
**File**: `dashboard/src/components/alerts/SeverityBadge.tsx`

```tsx
import { Badge } from "@/components/ui/badge";
import { Info, AlertTriangle, AlertOctagon } from "lucide-react";

interface SeverityBadgeProps {
  severity: 'info' | 'warning' | 'critical';
}

export function SeverityBadge({ severity }: SeverityBadgeProps) {
  const config = {
    info: { icon: Info, className: 'bg-blue-500 text-white' },
    warning: { icon: AlertTriangle, className: 'bg-yellow-500 text-white' },
    critical: { icon: AlertOctagon, className: 'bg-red-500 text-white' }
  };
  
  const { icon: Icon, className } = config[severity];
  
  return (
    <Badge className={className}>
      <Icon className="w-3 h-3 mr-1" />
      {severity.toUpperCase()}
    </Badge>
  );
}
```

- [ ] Create `SeverityBadge.tsx`
- [ ] Create `StatusBadge.tsx` (open/active/resolved)
- [ ] Create `ScoreBadge.tsx` (anomaly score with color coding)

### Step 2: Create Chart Component
**File**: `dashboard/src/components/alerts/IncidentTimelineChart.tsx`

- [ ] Install recharts if not present: `npm install recharts`
- [ ] Create line chart component showing:
  - Observed value over time
  - Baseline (mean) over time
  - Anomaly score over time (secondary Y-axis)
- [ ] Add tooltips showing full event details

### Step 3: Create Stats Cards
**File**: `dashboard/src/components/alerts/StatsCard.tsx`

- [ ] Card component with:
  - Title
  - Value (large number)
  - Icon
  - Severity color (optional)

---

## Phase 4: Main Alerts Page 📄
**Estimated Time**: 2-3 days

**File**: `dashboard/src/pages/AnomalyAlertsPage.tsx`

### Step 1: Page Structure
- [ ] Create page component with useState hooks:
  ```typescript
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [deviceFilter, setDeviceFilter] = useState('all');  // ✅ Device name filter
  const [deviceTypeFilter, setDeviceTypeFilter] = useState('all');  // ✅ Device type filter
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [offset, setOffset] = useState(0);
  const [limit] = useState(50);
  const [hasMore, setHasMore] = useState(false);
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [resolutionNotes, setResolutionNotes] = useState('');
  ```

- [ ] Add fetch functions:
  ```typescript
  const fetchStats = async () => { /* ... */ };
  const fetchIncidents = async () => { /* ... */ };
  const fetchIncidentDetails = async (incidentId: string) => { /* ... */ };
  const resolveIncident = async (incidentId: string, notes: string) => { /* ... */ };
  ```

### Step 2: Header Stats Section
- [ ] Grid of 4 StatsCard components
- [ ] Fetch stats on mount
- [ ] Auto-refresh every 30 seconds

### Step 3: Filters Bar
- [ ] Status dropdown (All/Open/Active/Resolved)
- [ ] Severity dropdown (All/Critical/Warning/Info)
- [ ] Endpoint dropdown (populate from endpoints API - Modbus, OPC-UA, sensors)
- [ ] Endpoint Type dropdown (All/Modbus/OPC-UA/BACnet/MQTT-Sensor/Agent-System)
- [ ] Date range inputs
- [ ] Apply/Clear buttons
- [ ] Wire up to fetchIncidents() function

### Step 4: Incidents Table
- [ ] Table with columns:
  - Severity (SeverityBadge)
  - **Endpoint Name** (monitored device)
  - **Endpoint Type** (Modbus, OPC-UA, etc.)
  - Metric
  - Status (StatusBadge)
  - First Seen
  - Last Seen
  - Score (ScoreBadge)
  - Event Count
  - Actions (View/Resolve buttons)
- [ ] Handle row click → open details modal
- [ ] Add pagination controls (Previous/Next)
- [ ] Loading state (skeleton or spinner)
- [ ] Empty state ("No incidents found")

### Step 5: Incident Details Modal
- [ ] Dialog component with:
  - Header (severity badge + endpoint name + metric)
  - Summary grid (endpoint type, status, score, timestamps)
  - Affected endpoints section (if multi-endpoint incident)
  - Timeline chart (IncidentTimelineChart)
  - Events table (related anomaly_events with endpoint names)
  - Resolution form (textarea + button)
- [ ] Fetch incident details when modal opens
- [ ] Handle resolve button click

### Step 6: Real-Time Updates
- [ ] Add auto-refresh every 30 seconds
- [ ] Show toast notification for new critical incidents
- [ ] Highlight new rows (optional)

---

## Phase 5: Navigation Integration 🔗
**Estimated Time**: 30 minutes

**File**: `dashboard/src/App.tsx`

- [ ] Import AnomalyAlertsPage
  ```typescript
  import { AnomalyAlertsPage } from './pages/AnomalyAlertsPage';
  ```

- [ ] Add route button in navigation menu (around line 900-950)
  ```tsx
  <Button
    variant={currentView === 'anomaly-alerts' ? 'default' : 'outline'}
    size="sm"
    onClick={() => setCurrentView('anomaly-alerts')}
  >
    <AlertOctagon className="w-4 h-4 mr-2" />
    Anomaly Alerts
  </Button>
  ```

- [ ] Add view rendering (around line 1050)
  ```tsx
  {currentView === 'anomaly-alerts' && <AnomalyAlertsPage />}
  ```

- [ ] Import AlertOctagon icon from lucide-react

---

## Phase 6: Testing & Polish ✅
**Estimated Time**: 1-2 days

### Unit Tests
- [ ] Test badge components render correctly
- [ ] Test filter state updates
- [ ] Test pagination logic

### Integration Tests
- [ ] Test API endpoints return correct data
- [ ] Test filtering queries
- [ ] Test resolution workflow

### E2E Tests (Playwright)
- [ ] Navigate to alerts page
- [ ] Apply filters
- [ ] View incident details
- [ ] Resolve incident
- [ ] Verify toast notifications

### Performance
- [ ] Test with 100+ incidents
- [ ] Verify table renders smoothly
- [ ] Check TimescaleDB query performance (< 500ms)
- [ ] Test auto-refresh doesn't cause lag

### Mobile Responsiveness
- [ ] Test on mobile viewport
- [ ] Verify filters collapse gracefully
- [ ] Check table scrolls horizontally if needed

### Accessibility
- [ ] Add ARIA labels to buttons
- [ ] Test keyboard navigation
- [ ] Test with screen reader

---

## Optional Enhancements 🚀
**For Future Iterations**

- [ ] WebSocket subscription for real-time updates (no polling)
- [ ] Browser push notifications for critical alerts
- [ ] Export incidents to CSV
- [ ] Bulk resolve (select multiple incidents)
- [ ] Advanced filtering (regex on metric names)
- [ ] Slack/PagerDuty integration
- [ ] Alert sound on critical incidents
- [ ] Incident comments/discussion thread
- [ ] Metric correlation visualization (heatmap)
- [ ] Incident trend analysis (charts over time)

---

## Verification Checklist ✓

Before marking complete, verify:

- [ ] All API endpoints return correct JSON structure
- [ ] Database indexes are created for performance
- [ ] Frontend fetches data correctly from API
- [ ] Filters update table results as expected
- [ ] Pagination works (Previous/Next buttons)
- [ ] Details modal shows full incident context
- [ ] Resolution workflow updates database and UI
- [ ] Stats cards display accurate counts
- [ ] Toast notifications appear for new critical alerts
- [ ] Page is mobile-responsive
- [ ] No console errors or warnings
- [ ] TypeScript compilation succeeds
- [ ] All tests pass

---

## Quick Commands Reference

### Backend Development
```bash
# Run API server
cd api && npm run dev

# Apply database migrations (automatic on API build)
docker compose up -d api --build

# Or verify migration status
docker compose logs api | grep "Migration"

# Test API endpoint
curl http://localhost:3002/api/v1/anomaly-incidents?limit=10
```

### Frontend Development
```bash
# Run dashboard
cd dashboard && npm run dev

# Install dependencies
cd dashboard && npm install recharts

# Type check
cd dashboard && npm run type-check

# Run tests
cd dashboard && npm run test:e2e
```

### Database Queries (PostgreSQL)
```sql
-- Check recent incidents
SELECT * FROM anomaly_incidents 
ORDER BY last_seen DESC 
LIMIT 10;

-- Count by status
SELECT status, COUNT(*) 
FROM anomaly_incidents 
GROUP BY status;

-- Count by severity
SELECT severity, COUNT(*) 
FROM anomaly_incidents 
GROUP BY severity;

-- Check events for incident
SELECT * FROM anomaly_events 
WHERE fingerprint = 'your_fingerprint_here'
ORDER BY timestamp_ms DESC 
LIMIT 50;
```

---

## Implementation Priority

**MUST HAVE (P0)**: 
- Database migration
- Incidents API routes
- Main table view
- Incident details modal
- Resolution workflow

**SHOULD HAVE (P1)**:
- Stats cards
- Filters
- Timeline chart
- Pagination

**NICE TO HAVE (P2)**:
- Auto-refresh
- Toast notifications
- Mobile responsiveness

**FUTURE (P3)**:
- WebSocket updates
- Export functionality
- Bulk operations

---

## Troubleshooting

### Issue: No incidents showing
- Check if `anomaly_events` table has data (edge devices sending anomalies?)
- Verify MQTT handler is receiving events: `kubectl logs -n <namespace> <api-pod> | grep "anomaly"`
- Check Redis connection for correlation caching

### Issue: Slow queries
- Verify TimescaleDB indexes exist: `\d+ anomaly_events` in psql
- Check chunk exclusion is working: `EXPLAIN ANALYZE SELECT ...`
- Consider adding composite indexes for common filter combinations

### Issue: Filters not working
- Check API query params are passed correctly
- Verify SQL WHERE clauses handle NULL/empty values
- Check date formatting (ISO 8601 vs Unix milliseconds)

---

## Success Metrics

After implementation, track:
- **MTTR (Mean Time to Resolve)**: How long from incident detection to resolution?
- **False Positive Rate**: How many incidents are marked as non-issues?
- **Critical Alert Response Time**: How quickly are critical alerts acknowledged?
- **User Engagement**: How often is the alerts page accessed?

