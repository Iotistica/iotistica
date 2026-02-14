# Fleet-Device Relationship - Quick Reference

## Relationship Model

```
Fleet (1) ──< HAS MANY >── (N) Devices/Agents
```

Each device belongs to ONE fleet (via `devices.fleet_id`)
Each fleet can have MANY devices

## Fleet Types

### 1. Physical Fleet
- **Purpose:** Organize existing hardware (Raspberry Pi, Arduino, etc.)
- **Billing:** No billing (billing_enabled = false)
- **Workflow:** Create fleet → Assign existing devices via UI
- **Example:** "Building A - Floor 1" containing 3 Raspberry Pi sensors

### 2. Virtual Fleet
- **Purpose:** Deploy cloud-based virtual agents
- **Billing:** Hourly billing based on resource tier
- **Workflow:** Create fleet with agent_count + devices_per_agent → System auto-deploys K8s pods → Virtual devices auto-created
- **Example:** "Staging Environment" with 5 virtual agents, each managing 3 devices = 15 total devices

### 3. Mixed Fleet
- Combination of physical + virtual devices in one fleet
- Billing applies only to virtual portion

## Key Concepts

### Agents vs Devices
- **Agent:** The device running IoT agent software (physical hardware or virtual K8s pod)
- **Device:** Any monitored endpoint (sensor, actuator, gateway)
- **Relationship:** One agent can manage multiple devices/sensors
  - Example: Raspberry Pi (agent) manages 3 BME688 sensors (devices)

### Virtual Fleet Pricing

| Total Devices | Tier   | Cost/Hour | Cost/Month |
|--------------|--------|-----------|------------|
| 1-5          | Small  | $0.007    | $5.00      |
| 6-15         | Medium | $0.012    | $8.50      |
| 16-30        | Large  | $0.021    | $15.00     |
| 31-50        | XLarge | $0.035    | $25.00     |

**Formula:** total_devices = agent_count × devices_per_agent

## Device Assignment

### Physical Fleet
1. Create fleet in UI
2. Navigate to device settings
3. Select fleet from dropdown
4. Save → `devices.fleet_id` updated

### Virtual Fleet
1. Create fleet with parameters (agent_count, devices_per_agent)
2. System deploys K8s pods
3. Virtual devices auto-created
4. All devices automatically assigned to fleet
5. No manual assignment needed

## UI Components

### ✅ Implemented
- Fleet management page (list view)
- Create fleet dialog (with cost estimation)
- Start/Stop controls for virtual fleets
- Metrics dashboard (fleet counts, costs, devices)
- Filter by fleet type

### ⏳ Pending
- Device assignment dropdown in device settings
- Bulk device assignment dialog
- Fleet details page (device list, billing history)
- Fleet filtering in device sidebar
- Virtual agent deployment integration

## API Endpoints

**Fleet Management:**
```bash
POST /api/v1/fleets              # Create fleet
GET /api/v1/fleets               # List fleets
GET /api/v1/fleets/:id           # Get details
PATCH /api/v1/fleets/:id         # Update fleet
DELETE /api/v1/fleets/:id        # Delete (soft)
POST /api/v1/fleets/:id/start    # Start billing
POST /api/v1/fleets/:id/stop     # Stop billing
```

**Device Assignment (pending implementation):**
```bash
PATCH /api/v1/devices/:uuid      # Assign to fleet
{
  "fleet_id": "fleet-abc123"
}
```

## Next Steps

1. **Test fleet creation dialog**
   - Create physical fleet (no billing)
   - Create virtual fleet (with cost estimation)
   - Verify fleet appears in list

2. **Implement device assignment UI**
   - Add fleet dropdown to device settings
   - Enable manual assignment to physical fleets

3. **Virtual agent deployment**
   - Hook fleet creation to K8s deployer
   - Auto-create virtual devices
   - Track provisioning status

4. **Enable billing metering**
   - Implement hourly cron job
   - Update current_cost for active virtual fleets
   - Check budget thresholds
   - Send alerts

---

**See:** [Complete Documentation](./FLEET-DEVICE-RELATIONSHIP.md)
