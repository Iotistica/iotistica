# Fleet Management System

Unified fleet management for organizing, monitoring, and billing both **virtual agents** and **physical devices**.

## Overview

The fleet system provides:
- **Grouping**: Organize devices by purpose, location, environment, or customer
- **Usage Tracking**: Monitor runtime hours and resource consumption
- **Billing**: Optional usage-based billing (primarily for virtual fleets)
- **Analytics**: Fleet-wide statistics and performance metrics

## Fleet Types

### 1. Virtual Fleets (Cloud-Deployed Agents)
Virtual agents deployed on Kubernetes for testing, development, or simulation.

**Characteristics**:
- Billing enabled by default (pay-per-use)
- Hourly or monthly billing
- Dynamic provisioning (create/destroy on demand)
- Resource tracking (CPU, memory, endpoints)

**Use Cases**:
- Customer testing platform before buying hardware
- Development/staging environments
- Proof-of-concept demonstrations
- Simulation and load testing

```typescript
// Create virtual fleet
const virtualFleet = {
  fleet_id: 'fleet-demo-abc123',
  fleet_name: 'Demo Environment',
  customer_id: customerId,
  fleet_type: 'virtual',
  billing_enabled: true,
  billing_mode: 'hourly',
  cost_per_hour: 0.059,
  target_device_count: 5,
  environment: 'development',
  deployment_config: {
    agentCount: 5,
    devicesPerAgent: 10,
    resourceTier: 'medium'
  }
};
```

### 2. Physical Fleets (Customer-Owned Hardware)
Raspberry Pi and other physical devices deployed at customer sites.

**Characteristics**:
- Billing disabled (customer owns hardware)
- Grouping and monitoring only
- Location-based organization
- Environment tracking (production, staging)

**Use Cases**:
- Factory floor sensor networks
- Building automation systems
- Retail store monitoring
- Remote site deployments

```typescript
// Create physical fleet
const physicalFleet = {
  fleet_id: 'fleet-factory-floor',
  fleet_name: 'Factory Floor Sensors',
  customer_id: customerId,
  fleet_type: 'physical',
  billing_enabled: false,
  description: 'Production line monitoring devices',
  environment: 'production',
  location: 'Toronto Manufacturing Plant',
  tags: {
    department: 'operations',
    building: 'Plant-A',
    floor: '2'
  }
};
```

### 3. Mixed Fleets
Combination of virtual and physical devices (advanced use case).

**Example**: Physical edge gateways + virtual cloud processors

---

## Database Schema

### Core Table: `fleets`

```sql
CREATE TABLE fleets (
    fleet_id VARCHAR(100) PRIMARY KEY,      -- Unique fleet identifier
    fleet_name VARCHAR(255) NOT NULL,
    customer_id UUID NOT NULL,
    
    fleet_type VARCHAR(20),                 -- 'virtual', 'physical', 'mixed'
    description TEXT,
    
    -- Billing (for virtual fleets)
    billing_enabled BOOLEAN DEFAULT false,
    billing_mode VARCHAR(20),               -- 'hourly', 'monthly'
    cost_per_hour DECIMAL(10,4),
    cost_per_month DECIMAL(10,2),
    total_running_hours DECIMAL(10,2),
    current_cost DECIMAL(10,2),
    budget_limit DECIMAL(10,2),
    
    -- State
    status VARCHAR(50) DEFAULT 'active',    -- 'active', 'stopped', 'deleted'
    
    -- Metadata
    tags JSONB,
    environment VARCHAR(50),                -- 'production', 'staging', 'development'
    location VARCHAR(255),                  -- Physical location or cloud region
    
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);
```

### Linking Devices to Fleets

**Existing field**: `devices.fleet_id` links devices to their fleet.

```sql
-- All devices in a fleet
SELECT * FROM devices WHERE fleet_id = 'fleet-abc123';

-- Fleet summary with device count
SELECT 
  f.*,
  COUNT(d.uuid) as device_count,
  COUNT(d.uuid) FILTER (WHERE d.is_online) as online_count
FROM fleets f
LEFT JOIN devices d ON d.fleet_id = f.fleet_id
WHERE f.fleet_id = 'fleet-abc123'
GROUP BY f.fleet_id;
```

---

## API Endpoints

### Fleet Management

#### Create Fleet
```http
POST /api/fleets
Authorization: Bearer <jwt>

{
  "fleet_name": "Production Monitoring",
  "fleet_type": "physical",
  "description": "Factory floor sensors",
  "environment": "production",
  "location": "Toronto Plant A",
  "tags": {
    "department": "manufacturing",
    "cost-center": "CC-1234"
  }
}

Response:
{
  "fleet_id": "fleet-a7b3c9",
  "fleet_name": "Production Monitoring",
  "status": "active",
  "created_at": "2026-02-14T10:30:00Z"
}
```

#### List Customer Fleets
```http
GET /api/fleets?customer_id=<uuid>
Authorization: Bearer <jwt>

Response:
{
  "fleets": [
    {
      "fleet_id": "fleet-a7b3c9",
      "fleet_name": "Production Monitoring",
      "fleet_type": "physical",
      "device_count": 12,
      "online_devices": 11,
      "status": "active"
    },
    {
      "fleet_id": "fleet-virtual-demo",
      "fleet_name": "Demo Environment",
      "fleet_type": "virtual",
      "device_count": 5,
      "online_devices": 5,
      "billing_enabled": true,
      "current_cost": 9.36,
      "status": "active"
    }
  ]
}
```

#### Get Fleet Details
```http
GET /api/fleets/:fleet_id
Authorization: Bearer <jwt>

Response:
{
  "fleet_id": "fleet-a7b3c9",
  "fleet_name": "Production Monitoring",
  "fleet_type": "physical",
  "status": "active",
  "environment": "production",
  "location": "Toronto Plant A",
  "device_count": 12,
  "online_devices": 11,
  "offline_devices": 1,
  "virtual_devices": 0,
  "physical_devices": 12,
  "total_endpoints": 87,
  "avg_cpu_usage": 23.5,
  "devices": [
    {
      "uuid": "abc-123",
      "device_name": "sensor-gateway-01",
      "device_type": "raspberrypi4-64",
      "is_online": true,
      "endpoint_count": 8
    }
  ]
}
```

### Virtual Fleet Provisioning

#### Estimate Cost
```http
POST /api/fleets/virtual/estimate
Authorization: Bearer <jwt>

{
  "agent_count": 5,
  "devices_per_agent": 10
}

Response:
{
  "monthly_cost": 42.50,
  "hourly_cost": 0.059,
  "resource_tier": "medium",
  "breakdown": {
    "agent_size": "medium",
    "cost_per_agent": 8.50,
    "total_agents": 5
  }
}
```

#### Deploy Virtual Fleet
```http
POST /api/fleets/virtual/deploy
Authorization: Bearer <jwt>

{
  "fleet_name": "Development Environment",
  "agent_count": 5,
  "devices_per_agent": 10,
  "billing_mode": "hourly",
  "budget_limit": 50.00,
  "environment": "development"
}

Response:
{
  "fleet_id": "fleet-dev-xyz789",
  "deployment_id": "deploy-abc123",
  "status": "provisioning",
  "estimated_ready": "2026-02-14T10:35:00Z"
}
```

#### Start/Stop Virtual Fleet
```http
POST /api/fleets/:fleet_id/stop
Authorization: Bearer <jwt>

Response:
{
  "fleet_id": "fleet-dev-xyz789",
  "status": "stopped",
  "stopped_at": "2026-02-14T15:30:00Z",
  "final_cost": 3.54,
  "total_hours": 60
}

POST /api/fleets/:fleet_id/start
Authorization: Bearer <jwt>

Response:
{
  "fleet_id": "fleet-dev-xyz789",
  "status": "active",
  "started_at": "2026-02-14T16:00:00Z"
}
```

### Device Management

#### Add Device to Fleet
```http
PATCH /api/devices/:uuid
Authorization: Bearer <jwt>

{
  "fleet_id": "fleet-a7b3c9"
}

Response:
{
  "uuid": "abc-123",
  "device_name": "sensor-gateway-01",
  "fleet_id": "fleet-a7b3c9",
  "updated_at": "2026-02-14T10:30:00Z"
}
```

#### Remove Device from Fleet
```http
PATCH /api/devices/:uuid
Authorization: Bearer <jwt>

{
  "fleet_id": null
}
```

---

## Usage Tracking & Billing

### How It Works

**Virtual Fleets** (Billing Enabled):
1. Cron job runs every hour
2. For each active fleet, increment `total_running_hours` by 1
3. Add `cost_per_hour` to `current_cost`
4. Check if `current_cost >= budget_limit`
5. If over budget, auto-stop fleet and notify customer

**Physical Fleets** (Billing Disabled):
- No cost tracking
- Monitor uptime and device health only
- Purely organizational grouping

### Metering Service

```typescript
// api/src/services/fleet-metering.service.ts
export class FleetMeteringService {
  
  // Run every hour (cron: 0 * * * *)
  async trackUsage(): Promise<void> {
    const activeFleets = await query(`
      SELECT fleet_id, cost_per_hour, budget_limit
      FROM fleets
      WHERE status = 'active' 
        AND billing_enabled = true
    `);
    
    for (const fleet of activeFleets.rows) {
      // Increment usage (1 hour)
      await query(`
        UPDATE fleets 
        SET total_running_hours = total_running_hours + 1,
            current_cost = current_cost + $1
        WHERE fleet_id = $2
      `, [fleet.cost_per_hour, fleet.fleet_id]);
      
      // Check budget
      const updated = await this.getFleet(fleet.fleet_id);
      
      if (updated.budget_limit && 
          updated.current_cost >= updated.budget_limit) {
        // Auto-stop to prevent overcharges
        await this.stopFleet(fleet.fleet_id);
        await this.sendBudgetAlert(fleet.fleet_id);
      }
      
      // Alert at 80% budget threshold
      if (updated.budget_limit && 
          updated.current_cost >= updated.budget_limit * 0.8) {
        await this.sendBudgetWarning(fleet.fleet_id);
      }
    }
  }
  
  async stopFleet(fleetId: string): Promise<void> {
    // Get all devices in fleet
    const devices = await query(`
      SELECT uuid, device_type FROM devices WHERE fleet_id = $1
    `, [fleetId]);
    
    // Stop virtual agents (terminate K8s pods)
    for (const device of devices.rows) {
      if (device.device_type === 'virtual') {
        await virtualAgentDeployer.terminate(device.uuid);
      }
    }
    
    // Update fleet status
    await query(`
      UPDATE fleets 
      SET status = 'stopped', 
          stopped_at = CURRENT_TIMESTAMP
      WHERE fleet_id = $1
    `, [fleetId]);
  }
}
```

### Reset Billing Period (Monthly)

```typescript
// Reset costs at start of each month (cron: 0 0 1 * *)
async resetMonthlyBilling(): Promise<void> {
  await query(`
    UPDATE fleets 
    SET current_cost = 0
    WHERE billing_enabled = true
  `);
  
  // Archive previous month's costs to billing_history table
  // (optional - for historical tracking)
}
```

---

## Dashboard UI Components

### Fleet List Page

```tsx
// dashboard/src/pages/FleetsPage.tsx
export function FleetsPage() {
  const { data: fleets } = useQuery('/api/fleets');
  
  return (
    <div>
      <h1>My Fleets</h1>
      
      <FleetFilters />
      
      {fleets.map(fleet => (
        <FleetCard 
          key={fleet.fleet_id}
          fleet={fleet}
          onStart={() => handleStart(fleet.fleet_id)}
          onStop={() => handleStop(fleet.fleet_id)}
          onDelete={() => handleDelete(fleet.fleet_id)}
        />
      ))}
      
      <Button onClick={() => navigate('/fleets/create')}>
        + Create Fleet
      </Button>
    </div>
  );
}
```

### Fleet Card Component

```tsx
// dashboard/src/components/FleetCard.tsx
export function FleetCard({ fleet }) {
  const isVirtual = fleet.fleet_type === 'virtual';
  const isRunning = fleet.status === 'active';
  
  return (
    <Card>
      <CardHeader>
        <h3>{fleet.fleet_name}</h3>
        <Badge variant={isRunning ? 'success' : 'secondary'}>
          {fleet.status}
        </Badge>
      </CardHeader>
      
      <CardContent>
        <div className="stats-grid">
          <Stat label="Devices" value={fleet.device_count} />
          <Stat label="Online" value={fleet.online_devices} />
          <Stat label="Type" value={fleet.fleet_type} />
          <Stat label="Environment" value={fleet.environment} />
        </div>
        
        {isVirtual && fleet.billing_enabled && (
          <div className="billing-info">
            <h4>Usage & Billing</h4>
            <p>Running time: {fleet.total_running_hours}h</p>
            <p>Current cost: ${fleet.current_cost}</p>
            <p>Budget: ${fleet.budget_limit}</p>
            <ProgressBar 
              value={fleet.current_cost} 
              max={fleet.budget_limit}
              variant={
                fleet.current_cost >= fleet.budget_limit * 0.8 
                  ? 'danger' 
                  : 'primary'
              }
            />
          </div>
        )}
      </CardContent>
      
      <CardFooter>
        <Button onClick={() => navigate(`/fleets/${fleet.fleet_id}`)}>
          View Details
        </Button>
        
        {isVirtual && (
          <>
            {isRunning ? (
              <Button variant="outline" onClick={onStop}>
                Stop Fleet
              </Button>
            ) : (
              <Button variant="primary" onClick={onStart}>
                Start Fleet
              </Button>
            )}
          </>
        )}
      </CardFooter>
    </Card>
  );
}
```

---

## Use Case Examples

### Example 1: Virtual Fleet for Testing

**Scenario**: Customer wants to test platform before purchasing hardware.

```bash
# 1. Customer creates virtual fleet
POST /api/fleets/virtual/deploy
{
  "fleet_name": "Platform Evaluation",
  "agent_count": 3,
  "devices_per_agent": 5,
  "billing_mode": "hourly",
  "budget_limit": 25.00,
  "environment": "development"
}

# 2. System deploys 3 virtual agents with 5 OPC UA endpoints each
# fleet_id: "fleet-eval-abc123"
# Devices created: eval-agent-1, eval-agent-2, eval-agent-3
# All have fleet_id = "fleet-eval-abc123"

# 3. Customer tests for 8 hours
# Cost: $0.06/hour × 8 hours = $0.48

# 4. Customer stops fleet
POST /api/fleets/fleet-eval-abc123/stop

# 5. Customer decides to buy hardware, deletes virtual fleet
DELETE /api/fleets/fleet-eval-abc123
```

### Example 2: Physical Fleet for Factory

**Scenario**: Customer groups 10 Raspberry Pis monitoring production line.

```bash
# 1. Create physical fleet
POST /api/fleets
{
  "fleet_name": "Assembly Line Sensors",
  "fleet_type": "physical",
  "description": "Production line monitoring - Building A",
  "environment": "production",
  "location": "Toronto - Building A - Floor 2",
  "tags": {
    "department": "manufacturing",
    "line": "assembly-line-3"
  }
}

# 2. Add existing devices to fleet
PATCH /api/devices/pi-sensor-01
{ "fleet_id": "fleet-assembly-abc123" }

PATCH /api/devices/pi-sensor-02
{ "fleet_id": "fleet-assembly-abc123" }
# ... repeat for all 10 devices

# 3. View fleet dashboard
GET /api/fleets/fleet-assembly-abc123
# Shows: 10 devices, 9 online, 72 total endpoints

# 4. No billing - customer owns hardware
# Fleet is purely organizational
```

---

## Migration & Backwards Compatibility

### Existing Devices

Existing devices with `fleet_id` set will automatically link to fleets table once migration runs.

**Migration Strategy**:
1. Run migration `135_add_fleet_management.sql`
2. Query for unique `fleet_id` values in devices table
3. Create fleet records for existing fleets (default to `physical` type)

```sql
-- Auto-create fleets for existing fleet_ids
INSERT INTO fleets (fleet_id, fleet_name, fleet_type, customer_id, billing_enabled)
SELECT DISTINCT
  d.fleet_id,
  COALESCE(d.fleet_id, 'Unnamed Fleet'),
  CASE WHEN d.device_type = 'virtual' THEN 'virtual' ELSE 'physical' END,
  '00000000-0000-0000-0000-000000000001'::uuid,  -- Replace with actual customer_id
  CASE WHEN d.device_type = 'virtual' THEN true ELSE false END
FROM devices d
WHERE d.fleet_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM fleets f WHERE f.fleet_id = d.fleet_id);
```

---

## Monitoring & Alerts

### Prometheus Metrics

```prometheus
# Fleet count by type
fleet_count_by_type{type="virtual"} 3
fleet_count_by_type{type="physical"} 12

# Virtual fleet costs
fleet_current_cost{fleet_id="fleet-abc123"} 9.36
fleet_budget_limit{fleet_id="fleet-abc123"} 50.00

# Device counts per fleet
fleet_device_count{fleet_id="fleet-abc123",status="online"} 5
fleet_device_count{fleet_id="fleet-abc123",status="offline"} 0
```

### Alert Rules

```yaml
groups:
  - name: fleet_alerts
    rules:
      - alert: FleetBudgetExceeded
        expr: fleet_current_cost >= fleet_budget_limit
        labels:
          severity: critical
        annotations:
          summary: "Fleet {{ $labels.fleet_id }} exceeded budget"
          
      - alert: FleetBudgetWarning
        expr: fleet_current_cost >= fleet_budget_limit * 0.8
        labels:
          severity: warning
        annotations:
          summary: "Fleet {{ $labels.fleet_id }} at 80% of budget"
```

---

## Summary

The unified fleet system supports:

✅ **Virtual Fleets**: Cloud-deployed agents with usage-based billing
✅ **Physical Fleets**: Customer-owned hardware with organizational grouping
✅ **Mixed Fleets**: Combination of both (advanced)
✅ **Flexible Billing**: Hourly, monthly, or disabled
✅ **Budget Controls**: Auto-stop when budget exceeded
✅ **Rich Metadata**: Tags, environment, location, description
✅ **Analytics**: Device counts, resource usage, cost projections
✅ **Backwards Compatible**: Works with existing `devices.fleet_id` column

All powered by one simple table: **`fleets`** 🎯
