# Fleet-Device Relationship Architecture

## Overview

Fleets provide a logical grouping and management layer for devices (agents) in the Iotistic IoT platform. This document explains the relationship model, use cases, and implementation details.

## Database Relationship

### Entity Relationship

```
┌──────────────┐         ┌──────────────┐
│   fleets     │         │   devices    │
├──────────────┤         ├──────────────┤
│ fleet_id PK  │◄────────│ fleet_id FK  │
│ fleet_name   │    1:N  │ device_uuid  │
│ fleet_type   │         │ name         │
│ ...          │         │ status       │
└──────────────┘         └──────────────┘

One Fleet HAS MANY Devices
One Device BELONGS TO One Fleet
```

### Schema Definition

**Fleets Table:**
```sql
CREATE TABLE fleets (
  fleet_id VARCHAR(100) PRIMARY KEY,
  fleet_name VARCHAR(255),
  customer_id UUID,
  fleet_type VARCHAR(20),  -- 'virtual', 'physical', 'mixed'
  billing_enabled BOOLEAN DEFAULT false,
  status VARCHAR(50) DEFAULT 'active',
  ...
);
```

**Devices Table (existing column):**
```sql
ALTER TABLE devices ADD COLUMN fleet_id VARCHAR(100);
-- Foreign key to fleets.fleet_id
```

## Fleet Types

### 1. Physical Fleet (Organizational)

**Purpose:** Group existing hardware devices for organization and management

**Characteristics:**
- No billing (billing_enabled = false)
- Devices are manually assigned after fleet creation
- Used for:
  - Geographic grouping (e.g., "North America Sensors")
  - Environmental separation (e.g., "Production Floor 3")
  - Project-based organization (e.g., "HVAC Monitoring Q1")

**Workflow:**
1. Create physical fleet via dashboard
2. Navigate to device settings
3. Assign devices to fleet from dropdown
4. Devices now grouped under fleet for filtering/viewing

**Example Use Case:**
```
Fleet: "Building A - Floor 1"
  ├─ Raspberry Pi #1 (Temperature Sensors)
  ├─ Raspberry Pi #2 (Humidity Sensors)
  └─ Raspberry Pi #3 (Air Quality Monitors)
```

### 2. Virtual Fleet (Billed K8s Deployment)

**Purpose:** Deploy virtual agents in the cloud with automated billing

**Characteristics:**
- Billing enabled (billing_enabled = true)
- Billed hourly based on resource tier
- Devices (virtual agents) auto-created on fleet creation
- Kubernetes pods deployed in cloud
- Auto-stop on budget exceeded

**Workflow:**
1. Create virtual fleet with parameters:
   - agent_count (number of virtual agents)
   - devices_per_agent (devices each agent manages)
2. System calculates cost tier based on total devices
3. K8s pods deployed (agent containers)
4. Virtual devices created and assigned to fleet
5. Hourly billing starts
6. Monitor cost vs budget

**Example Use Case:**
```
Fleet: "Staging Environment Test"
  ├─ Virtual Agent #1 → manages 3 virtual sensors
  ├─ Virtual Agent #2 → manages 3 virtual sensors
  └─ Virtual Agent #3 → manages 3 virtual sensors
  
Cost: Small tier ($0.007/hr = $5/mo)
Budget: $10/month (auto-stops at $10)
```

### 3. Mixed Fleet

**Purpose:** Combine physical and virtual devices in single fleet

**Characteristics:**
- Can contain both hardware and cloud devices
- Billing applies only to virtual portion
- Used for hybrid deployments

**Example Use Case:**
```
Fleet: "Hybrid Production"
  ├─ Physical Raspberry Pi #1 (edge gateway)
  ├─ Virtual Agent #1 (cloud aggregator)
  └─ Physical Arduino #2 (field sensor)
```

## Resource Tier Pricing (Virtual Fleets Only)

Pricing calculated based on **total devices** in fleet:

| Total Devices | Tier    | Hourly Cost | Monthly Cost (730h) |
|--------------|---------|-------------|---------------------|
| 1-5          | Small   | $0.007      | $5.00              |
| 6-15         | Medium  | $0.012      | $8.50              |
| 16-30        | Large   | $0.021      | $15.00             |
| 31-50        | XLarge  | $0.035      | $25.00             |

**Formula:**
```
total_devices = agent_count × devices_per_agent
```

## Device Assignment

### Physical Fleet Assignment

**UI Flow:**
1. Navigate to Device Settings page
2. Select "Fleet" dropdown
3. Choose from available fleets
4. Save → device.fleet_id updated

**API Endpoint:**
```bash
PATCH /api/v1/devices/:uuid
Content-Type: application/json
Authorization: Bearer <token>

{
  "fleet_id": "fleet-abc123"
}
```

**Bulk Assignment:**
```bash
PATCH /api/v1/devices/bulk-assign
Content-Type: application/json
Authorization: Bearer <token>

{
  "device_uuids": ["uuid1", "uuid2", "uuid3"],
  "fleet_id": "fleet-abc123"
}
```

### Virtual Fleet Auto-Assignment

When creating a virtual fleet, devices are **automatically created and assigned**:

1. Fleet created with agent_count=5, devices_per_agent=3
2. System deploys 5 K8s pods (virtual agents)
3. System creates 15 virtual device records
4. All 15 devices assigned to fleet (devices.fleet_id = fleet.fleet_id)
5. Provisioning status tracked until deployment complete

## Billing & Metering

### Virtual Fleet Billing Process

**Hourly Metering Service:**
```typescript
// Runs every hour
async function meterVirtualFleets() {
  const activeFleets = await db.query(`
    SELECT * FROM fleets 
    WHERE billing_enabled = true 
    AND status = 'active'
  `);

  for (const fleet of activeFleets) {
    const deviceCount = await getFleetDeviceCount(fleet.fleet_id);
    const hourlyCharge = calculateHourlyCost(deviceCount);
    
    // Update current cost
    await db.query(`
      UPDATE fleets 
      SET current_cost = current_cost + $1 
      WHERE fleet_id = $2
    `, [hourlyCharge, fleet.fleet_id]);
    
    // Check budget
    if (fleet.budget_limit && fleet.current_cost >= fleet.budget_limit) {
      await stopFleet(fleet.fleet_id); // Auto-stop
      await sendBudgetAlert(fleet.customer_id, fleet.fleet_id);
    }
  }
}
```

**Event Tracking:**
All billing changes logged in `fleet_usage_events` table:
- `cost_updated` - Hourly charge applied
- `budget_alert` - 80% budget threshold reached
- `started` - Fleet resumed (billing starts)
- `stopped` - Fleet paused (billing stops)
- `deployment_complete` - K8s pods ready

## Fleet Operations

### Start/Stop Fleet

**API Endpoints:**
```bash
# Start fleet (resume billing)
POST /api/v1/fleets/:fleet_id/start

# Stop fleet (pause billing)
POST /api/v1/fleets/:fleet_id/stop
```

**Behavior:**
- **Physical Fleet:** Status change only (devices unaffected)
- **Virtual Fleet:** 
  - Stop: Scale K8s pods to 0, billing paused
  - Start: Scale K8s pods to agent_count, billing resumed

### Delete Fleet

**API Endpoint:**
```bash
DELETE /api/v1/fleets/:fleet_id
```

**Behavior:**
- Soft delete (status = 'deleted')
- **Physical Fleet:** Devices remain, fleet_id set to NULL
- **Virtual Fleet:** K8s pods destroyed, virtual devices deleted

## Device Filtering & Views

### Filter Devices by Fleet

**UI:**
```typescript
// Device sidebar filter
const fleetFilter = selectedFleetId;
const filteredDevices = devices.filter(d => d.fleet_id === fleetFilter);
```

**API:**
```bash
GET /api/v1/devices?fleet_id=fleet-abc123
```

### Fleet Dashboard Views

**Fleet Summary View:**
```sql
SELECT 
  f.fleet_id,
  f.fleet_name,
  COUNT(d.device_uuid) as device_count,
  COUNT(CASE WHEN d.status = 'online' THEN 1 END) as online_count,
  f.current_cost,
  f.budget_limit
FROM fleets f
LEFT JOIN devices d ON d.fleet_id = f.fleet_id
GROUP BY f.fleet_id;
```

## Implementation Checklist

### ✅ Completed
- [x] Database migrations (fleets table, views, functions)
- [x] Fleet API endpoints (10 total)
- [x] Fleet management UI (FleetsPage)
- [x] Create fleet dialog (with cost estimation)
- [x] JWT authentication
- [x] Cost calculation logic

### ⏳ Pending
- [ ] Device assignment UI (dropdown in device settings)
- [ ] Bulk device assignment dialog
- [ ] Virtual agent deployment integration (K8s provisioner)
- [ ] Hourly metering service (cron job)
- [ ] Budget alert notifications
- [ ] Fleet device list view
- [ ] Fleet details page

## API Reference

### Fleet Endpoints

| Method | Endpoint                               | Auth | Description                    |
|--------|----------------------------------------|------|--------------------------------|
| GET    | `/api/v1/fleets`                       | ✓    | List fleets (with filters)     |
| POST   | `/api/v1/fleets`                       | ✓    | Create fleet                   |
| GET    | `/api/v1/fleets/:id`                   | ✓    | Get fleet details              |
| PATCH  | `/api/v1/fleets/:id`                   | ✓    | Update fleet                   |
| DELETE | `/api/v1/fleets/:id`                   | ✓    | Delete fleet (soft)            |
| POST   | `/api/v1/fleets/:id/start`             | ✓    | Start/resume fleet             |
| POST   | `/api/v1/fleets/:id/stop`              | ✓    | Stop/pause fleet               |
| GET    | `/api/v1/fleets/:id/billing`           | ✓    | Get billing summary            |
| GET    | `/api/v1/fleets/:id/usage-events`      | ✓    | Get usage event history        |
| POST   | `/api/v1/fleets/virtual/estimate`      | ✗    | Calculate cost (public)        |

### Device Endpoints (Fleet Assignment)

```bash
# Get device with fleet info
GET /api/v1/devices/:uuid

# Update device fleet
PATCH /api/v1/devices/:uuid
{
  "fleet_id": "fleet-abc123"
}

# Filter devices by fleet
GET /api/v1/devices?fleet_id=fleet-abc123

# Bulk assign devices
PATCH /api/v1/devices/bulk-assign
{
  "device_uuids": ["uuid1", "uuid2"],
  "fleet_id": "fleet-abc123"
}
```

## Best Practices

### Fleet Naming Conventions

**Physical Fleets:**
- Geographic: "North America - East Coast"
- Project: "HVAC Monitoring - Q1 2026"
- Environment: "Production - Building A"
- Team: "Data Science Team Sensors"

**Virtual Fleets:**
- Purpose-based: "Staging Environment"
- Temporary: "Load Test - Feb 2026"
- Development: "Dev Team Alpha"

### Budget Management

**Recommendations:**
1. **Set conservative budgets** for virtual fleets during testing
2. **Monitor cost daily** in first week to establish baseline
3. **Use alerts** at 80% threshold to prevent surprise auto-stops
4. **Right-size fleets** - start small, scale up as needed
5. **Stop unused fleets** - billing continues until explicitly stopped

### Device Organization

**Anti-patterns to avoid:**
- ❌ Creating fleets per device (defeats grouping purpose)
- ❌ Mixing unrelated devices in single fleet
- ❌ No fleet assignment (devices orphaned)

**Best practices:**
- ✅ Logical grouping by location, environment, or purpose
- ✅ Consistent naming across fleets
- ✅ Regular audit of fleet membership
- ✅ Virtual fleets for test environments (easy cleanup)

## Future Enhancements

### Planned Features
1. **Fleet Templates** - Pre-configured fleet types
2. **Auto-scaling** - Dynamic agent_count based on load
3. **Cost Optimization** - Recommendations for tier downgrades
4. **Fleet Permissions** - Role-based access to specific fleets
5. **Cross-region Deployment** - Virtual fleets in multiple regions
6. **Fleet Analytics** - Historical cost trends, usage patterns
7. **Alert Rules** - Custom thresholds beyond budget

---

**Related Documentation:**
- [Fleet API Documentation](../api/routes/fleets.ts)
- [Database Migrations](../api/database/migrations/141-143)
- [K8s Deployment Service](../billing/src/services/k8s-deployment-service.ts)
- [Device Management](./DEVICE-MANAGEMENT.md)
