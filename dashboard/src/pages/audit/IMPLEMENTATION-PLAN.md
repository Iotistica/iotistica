# Audit Page Implementation Plan - Split View (Option B)

## ✅ COMPLETED: Foundation Components

### Step 1: Base Structure ✅
- [x] Created `types.ts` - Type definitions for AuditEvent, AuditFilters, AuditStats
- [x] Created `AuditFilters.tsx` - Left sidebar with filters
- [x] Created `AuditEventStream.tsx` - Center event list
- [x] Created `AuditEventDetails.tsx` - Right detail panel
- [x] Created `AuditPage.tsx` - Main container with 3-panel layout

## 📋 IMPLEMENTATION ROADMAP

### Phase 1: Integration & API (Week 1 - Days 1-3)

#### ✅ STEP 2: Add Route to Dashboard (30 mins)
**Files to modify:**
- `dashboard/src/App.tsx` or router config

**Actions:**
```typescript
// Add route
import AuditPage from './pages/audit/AuditPage';

<Route path="/audit" element={<AuditPage />} />
```

#### ✅ STEP 3: Add Navigation Link (15 mins)
**Files to modify:**
- `dashboard/src/components/Sidebar.tsx` or navigation component

**Actions:**
```typescript
// Add menu item
{
  path: '/audit',
  label: 'Audit & Activity',
  icon: '📋' // or actual icon component
}
```

#### 🔧 STEP 4: Create Unified Events API Endpoint (4 hours)
**Files to create/modify:**
- `api/src/routes/audit.ts` - NEW
- `api/src/services/audit.service.ts` - NEW
- `api/src/index.ts` - Register route

**API Specification:**
```typescript
GET /api/v1/audit/events
Query Parameters:
  - limit: number (default 50)
  - page: number (default 1)
  - categories: string[] (device,user,system,mqtt,security,billing)
  - severity: string[] (info,warning,error,critical)
  - startDate: ISO date string
  - endDate: ISO date string
  - entitySearch: string (search entity names/IDs)
  - actorSearch: string (search user emails)

Response:
{
  success: boolean,
  events: AuditEvent[],
  count: number,
  totalPages: number,
  categoryBreakdown: { device: 10, user: 5, ... }
}
```

**Implementation:**
```sql
-- Create view to unify events table with category mapping
CREATE VIEW audit_events_unified AS
  SELECT 
    id,
    event_id,
    event_timestamp as timestamp,
    CASE 
      WHEN event_type LIKE 'device.%' THEN 'device'
      WHEN event_type LIKE 'user.%' THEN 'user'
      WHEN event_type LIKE 'system.%' THEN 'system'
      WHEN event_type LIKE 'mqtt.%' THEN 'mqtt'
      WHEN event_type LIKE 'security.%' THEN 'security'
      WHEN event_type LIKE 'billing.%' THEN 'billing'
      ELSE 'system'
    END as category,
    event_type as type,
    COALESCE(metadata->>'severity', 'info') as severity,
    aggregate_type as entity_type,
    aggregate_id as entity_id,
    data,
    metadata
  FROM events
  ORDER BY event_timestamp DESC;
```

#### 🔧 STEP 5: Connect Frontend to API (2 hours)
**Files to modify:**
- `dashboard/src/pages/audit/AuditPage.tsx` - Update fetchEvents function

**Actions:**
- Replace TODO comment with actual API call
- Add error handling and retry logic
- Add loading states
- Test filtering and pagination

### Phase 2: Enhance Event Categories (Week 1 - Days 4-5)

#### 🎨 STEP 6: Add User Action Events (3 hours)
**Database changes:**
- Ensure user actions are logged to events table

**Event types to capture:**
```typescript
'user.login'           // User logged in
'user.logout'          // User logged out
'user.password_change' // Password changed
'config.updated'       // Configuration changed
'deployment.created'   // K8s deployment triggered
'api_key.created'      // API key generated
'api_key.revoked'      // API key revoked
```

**Files to modify:**
- `api/src/middleware/auth.ts` - Log login/logout events
- `api/src/routes/*.ts` - Add event logging to critical actions

#### 🎨 STEP 7: Add System Events (2 hours)
**Event types:**
```typescript
'system.startup'       // Service started
'system.shutdown'      // Service stopped
'license.updated'      // License changed
'billing.subscription_changed'
'k8s.deployment_succeeded'
'k8s.deployment_failed'
```

**Integration:**
- Pull events from billing service
- Pull K8s deployment events
- Add health check status changes

#### 🎨 STEP 8: Add MQTT Activity Events (3 hours)
**Event types:**
```typescript
'mqtt.client_connected'
'mqtt.client_disconnected'
'mqtt.publish'          // Optional: high volume
'mqtt.subscribe'
'mqtt.acl_denied'       // Security: failed auth
```

**Files to modify:**
- `mosquitto/` - Configure logging
- `api/src/services/mqtt.service.ts` - Parse and store MQTT logs

### Phase 3: Enhanced Features (Week 2 - Days 1-3)

#### 🚀 STEP 9: Add Real-time Event Streaming (4 hours)
**Technology:** Server-Sent Events (SSE) or WebSocket

**Implementation:**
```typescript
// Backend: api/src/routes/audit.ts
GET /api/v1/audit/events/stream

// Frontend: AuditPage.tsx
useEffect(() => {
  const eventSource = new EventSource('/api/v1/audit/events/stream');
  eventSource.onmessage = (event) => {
    const newEvent = JSON.parse(event.data);
    setEvents(prev => [newEvent, ...prev]);
  };
  return () => eventSource.close();
}, []);
```

#### 🚀 STEP 10: Add Export Functionality (2 hours)
**Formats:** CSV, JSON, PDF (optional)

**Files to modify:**
- `dashboard/src/pages/audit/AuditPage.tsx` - Implement handleExport

**Implementation:**
```typescript
const exportToCSV = (events: AuditEvent[]) => {
  const headers = ['Timestamp', 'Category', 'Type', 'Severity', 'Entity', 'Actor', 'Description'];
  const rows = events.map(e => [
    e.timestamp,
    e.category,
    e.type,
    e.severity,
    e.entity_name || e.entity_id,
    e.actor_name || 'System',
    e.description,
  ]);
  // Convert to CSV and download
};
```

#### 🚀 STEP 11: Add Advanced Search (3 hours)
**Features:**
- Full-text search across event data
- Complex filters (AND/OR logic)
- Saved filter presets
- Quick filters (last 24h, last 7d, errors only, etc.)

**Files to create:**
- `dashboard/src/pages/audit/AdvancedSearch.tsx` - Modal component

#### 🚀 STEP 12: Add Bookmarking & Notes (2 hours)
**Features:**
- Users can bookmark important events
- Add private notes to events
- Flag events for follow-up

**Database:**
```sql
CREATE TABLE audit_bookmarks (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  event_id UUID NOT NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Phase 4: Security & Compliance (Week 2 - Days 4-5)

#### 🔒 STEP 13: Add Security Audit Tab (3 hours)
**Event types:**
```typescript
'security.auth.failed_login'
'security.auth.suspicious_activity'
'security.permission.denied'
'security.api_key.unauthorized_use'
'security.vpn.connection_failed'
```

**Features:**
- Dedicated security events view
- Failed login tracking
- IP address logging
- Geolocation (optional)

#### 🔒 STEP 14: Add Audit Log Integrity (4 hours)
**Features:**
- Tamper-proof event logs
- Event signature/hash
- Exportable audit trail for compliance

**Implementation:**
```sql
ALTER TABLE events 
ADD COLUMN signature TEXT,
ADD COLUMN previous_event_hash TEXT;

-- Generate hash chain for integrity
CREATE TRIGGER events_integrity_trigger
BEFORE INSERT ON events
FOR EACH ROW
EXECUTE FUNCTION calculate_event_signature();
```

#### 🔒 STEP 15: Add Role-Based Access (2 hours)
**Features:**
- Admin: See all events
- User: See own device events only
- Auditor: Read-only access to all events

**Files to modify:**
- `api/src/middleware/auth.ts` - Add role checks
- `api/src/routes/audit.ts` - Filter events by user role

### Phase 5: Analytics & Insights (Week 3)

#### 📊 STEP 16: Add Dashboard/Overview Tab (4 hours)
**Features:**
- Event count trends (chart)
- Category breakdown (pie chart)
- Top error sources
- Recent activity summary
- Event heatmap (time of day)

**Libraries:**
- Recharts or Chart.js for visualizations

**Files to create:**
- `dashboard/src/pages/audit/AuditOverview.tsx`
- `dashboard/src/components/charts/EventTrendChart.tsx`

#### 📊 STEP 17: Add Alerting Rules (5 hours)
**Features:**
- Configure alert rules (e.g., > 10 errors in 5 mins)
- Email/webhook notifications
- Alert history

**Files to create:**
- `api/src/services/alert-engine.ts`
- `dashboard/src/pages/audit/AlertRules.tsx`

#### 📊 STEP 18: Add Event Correlation (3 hours)
**Features:**
- Group related events (e.g., deployment chain)
- Show event relationships
- Timeline view of correlated events

### Phase 6: Performance & Polish (Week 4)

#### ⚡ STEP 19: Add Infinite Scroll (2 hours)
**Replace:** "Load More" button with infinite scroll

**Library:** `react-intersection-observer`

#### ⚡ STEP 20: Add Virtual Scrolling (3 hours)
**For:** Large event lists (1000+ events)

**Library:** `react-window` or `react-virtual`

#### ⚡ STEP 21: Add Caching & Optimization (2 hours)
- Redis cache for frequent queries
- API response caching
- Frontend query caching (React Query)

#### 🎨 STEP 22: Polish UI/UX (4 hours)
- Add keyboard shortcuts (↑/↓ to navigate events)
- Add dark mode support
- Improve mobile responsiveness
- Add empty states and loading skeletons
- Add animations and transitions

#### 🧪 STEP 23: Testing (4 hours)
- Unit tests for components
- Integration tests for API
- E2E tests for critical flows

**Files to create:**
- `dashboard/src/pages/audit/__tests__/AuditPage.test.tsx`
- `api/src/routes/__tests__/audit.test.ts`

## 📊 PRIORITY MATRIX

### Must Have (MVP)
- ✅ Step 1: Base components (DONE)
- Step 2-3: Routing and navigation
- Step 4-5: API integration
- Step 6: User action events
- Step 10: Export to JSON/CSV

### Should Have
- Step 7: System events
- Step 8: MQTT events
- Step 9: Real-time streaming
- Step 11: Advanced search
- Step 13: Security audit

### Nice to Have
- Step 12: Bookmarking
- Step 14: Audit integrity
- Step 16-18: Analytics
- Step 19-22: Performance & Polish

### Future Enhancements
- AI-powered anomaly detection
- Natural language search
- Custom event retention policies
- SIEM integration (Splunk, ELK)

## 🎯 RECOMMENDED EXECUTION ORDER

### Sprint 1 (Week 1)
**Goal:** Working audit page with device events

1. Day 1-2: Steps 2-5 (Routing + API)
2. Day 3: Step 6 (User actions)
3. Day 4: Step 10 (Export)
4. Day 5: Testing & bug fixes

### Sprint 2 (Week 2)
**Goal:** Multi-category events + real-time

1. Day 1: Step 7-8 (System + MQTT events)
2. Day 2-3: Step 9 (Real-time streaming)
3. Day 4: Step 11 (Advanced search)
4. Day 5: Step 13 (Security audit)

### Sprint 3 (Week 3)
**Goal:** Analytics & insights

1. Day 1-2: Step 16 (Dashboard/overview)
2. Day 3-4: Step 17 (Alerting)
3. Day 5: Step 12 (Bookmarking)

### Sprint 4 (Week 4)
**Goal:** Polish & production-ready

1. Day 1-2: Steps 19-21 (Performance)
2. Day 3-4: Step 22 (UI/UX polish)
3. Day 5: Step 23 (Testing)

## 🚀 QUICK START (Next Steps)

**To get audit page visible in dashboard:**

1. **Add route** (5 mins):
   ```bash
   # Modify dashboard router
   # Import: import AuditPage from './pages/audit/AuditPage';
   # Add route: <Route path="/audit" element={<AuditPage />} />
   ```

2. **Add navigation link** (5 mins):
   ```bash
   # Find navigation/sidebar component
   # Add: { path: '/audit', label: 'Audit & Activity', icon: '📋' }
   ```

3. **Test with mock data** (10 mins):
   ```bash
   cd dashboard
   npm run dev
   # Navigate to http://localhost:8080/audit
   # Should see 3-panel layout
   ```

4. **Create API endpoint** (2-4 hours):
   ```bash
   # Create api/src/routes/audit.ts
   # Register route in api/src/index.ts
   # Test: curl http://localhost:4002/api/v1/audit/events
   ```

## 📝 NOTES

- **Data Source:** Currently using existing `events` table from event sourcing (Step 4)
- **Backwards Compatible:** Timeline page can be deprecated after audit page is stable
- **Scalability:** Consider time-series DB (TimescaleDB) for high-volume MQTT events
- **Security:** Ensure audit logs themselves are tamper-proof (Step 14)
- **Compliance:** Export features critical for SOC2/ISO27001 compliance

## 🤔 DECISIONS NEEDED

1. **Real-time:** SSE vs WebSocket? (Recommendation: SSE for simplicity)
2. **MQTT Events:** Log all publishes or just connections? (Recommendation: Connections only, sample publishes)
3. **Retention:** How long to keep audit logs? (Recommendation: 90 days standard, 1 year for security events)
4. **Storage:** Keep in PostgreSQL or move to dedicated audit DB? (Recommendation: PostgreSQL for now, partition by month)

---

**Ready to implement?** Start with Steps 2-3 to get the page visible, then tackle Step 4 (API) for real data!
