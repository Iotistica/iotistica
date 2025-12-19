# Alert Suppression Metadata

**Status**: ✅ Implemented  
**Date**: 2025-12-18  
**Purpose**: Enable cloud-side deduplication and flapping detection

## Overview

Edge devices now include suppression metadata in anomaly alerts, enabling cloud services to:
- Deduplicate alerts without hardcoded cooldown periods
- Distinguish persistent issues from flapping metrics
- Track incident lifecycle (first detection → resolution)
- Implement intelligent escalation policies

## Added Fields

```typescript
interface AnomalyAlert {
  // ... existing fields ...
  
  // Alert suppression metadata (for cloud-side deduplication)
  cooldownSec: number;         // Cooldown period in seconds
  firstSeen: number;           // Unix timestamp (ms) when first detected
  consecutiveCount: number;    // Consecutive detections without reset
}
```

### Field Semantics

#### `cooldownSec`
- **Type**: `number` (seconds)
- **Purpose**: Cooldown period configured for this metric
- **Cloud Usage**: Determine if alert should be suppressed
- **Example**: `300` (5 minutes)

```typescript
// Cloud-side deduplication
if (now - alert.timestamp < alert.cooldownSec * 1000) {
  logger.debug('Alert within cooldown, suppressing');
  return;
}
```

#### `firstSeen`
- **Type**: `number` (Unix timestamp in milliseconds)
- **Purpose**: When this fingerprint was first detected
- **Cloud Usage**: Calculate incident duration
- **Behavior**: Preserved across consecutive detections

```typescript
// Track incident duration
const incidentDuration = now - alert.firstSeen;
if (incidentDuration > 3600000 && alert.consecutiveCount >= 3) {
  // Persistent issue for 1+ hour → escalate
  notifyOncall(alert);
}
```

#### `consecutiveCount`
- **Type**: `number` (1+)
- **Purpose**: Consecutive detections without reset
- **Cloud Usage**: Detect flapping vs persistent issues
- **Reset**: When cooldown expires without detection

```typescript
// Flapping detection
if (alert.count > 100 && alert.consecutiveCount < 3) {
  // Fired 100+ times but never sustained → flapping
  logger.warn('Flapping metric detected', { 
    metric: alert.metric,
    count: alert.count,
    consecutive: alert.consecutiveCount 
  });
  suppressAlert(alert);
}

// Persistent issue detection
if (alert.consecutiveCount >= 5) {
  // 5+ consecutive detections → genuine persistent issue
  escalate(alert);
}
```

## Edge Behavior

### First Detection
```typescript
{
  id: "a1b2c3d4",
  metric: "cpu_usage",
  severity: "warning",
  count: 1,
  cooldownSec: 300,           // From config (5 min)
  firstSeen: 1734556800000,   // Now
  consecutiveCount: 1,        // First detection
  // ... other fields
}
```

### Within Cooldown (Second Detection After 2 Minutes)
```typescript
{
  id: "a1b2c3d4",            // Same ID (deduplicated)
  metric: "cpu_usage",
  severity: "warning",
  count: 2,                  // Incremented
  cooldownSec: 300,
  firstSeen: 1734556800000,  // Preserved from first detection
  consecutiveCount: 2,       // Incremented (still within cooldown)
  // ... other fields
}
```

### After Cooldown Expires (10 Minutes Later)
```typescript
{
  id: "e5f6g7h8",            // New ID (cooldown expired)
  metric: "cpu_usage",
  severity: "warning",
  count: 1,                  // Reset to 1
  cooldownSec: 300,
  firstSeen: 1734557400000,  // New timestamp
  consecutiveCount: 3,       // Preserved + 1 (persistent issue)
  // ... other fields
}
```

### Issue Resolved (1 Hour After Last Alert)
Next detection starts fresh:
```typescript
{
  consecutiveCount: 1,       // Reset to 1 (cooldown expired without detections)
  // ...
}
```

## Cloud-Side Usage Patterns

### 1. Intelligent Deduplication
```typescript
class CloudAlertManager {
  shouldSuppress(alert: AnomalyAlert): boolean {
    const now = Date.now();
    const lastAlert = this.getLastAlert(alert.fingerprint);
    
    if (!lastAlert) return false;
    
    // Use device's cooldown period (not hardcoded)
    const cooldownMs = alert.cooldownSec * 1000;
    return (now - lastAlert.timestamp) < cooldownMs;
  }
}
```

### 2. Flapping Detection
```typescript
function detectFlapping(alert: AnomalyAlert): boolean {
  // High count but low consecutive → flapping
  if (alert.count > 50 && alert.consecutiveCount < 3) {
    logger.warn('Flapping metric', {
      metric: alert.metric,
      totalFires: alert.count,
      consecutive: alert.consecutiveCount,
      suggestion: 'Increase threshold or cooldown'
    });
    return true;
  }
  return false;
}
```

### 3. Persistent Issue Escalation
```typescript
function shouldEscalate(alert: AnomalyAlert): boolean {
  const incidentDuration = Date.now() - alert.firstSeen;
  
  // Escalate if:
  // - 5+ consecutive detections
  // - Incident ongoing for 30+ minutes
  // - Critical severity
  return (
    alert.consecutiveCount >= 5 &&
    incidentDuration > 1800000 && // 30 min
    alert.severity === 'critical'
  );
}
```

### 4. Incident Timeline
```typescript
function buildIncidentTimeline(alerts: AnomalyAlert[]) {
  return {
    firstDetection: Math.min(...alerts.map(a => a.firstSeen)),
    latestDetection: Math.max(...alerts.map(a => a.timestamp)),
    totalOccurrences: alerts.reduce((sum, a) => sum + a.count, 0),
    maxConsecutive: Math.max(...alerts.map(a => a.consecutiveCount)),
    isFlapping: alerts.some(detectFlapping),
  };
}
```

### 5. Auto-Resolution
```typescript
function checkAutoResolve(alert: AnomalyAlert): boolean {
  const now = Date.now();
  const silenceDuration = now - alert.timestamp;
  const cooldownMs = alert.cooldownSec * 1000;
  
  // Auto-resolve if silent for 3x cooldown period
  if (silenceDuration > cooldownMs * 3) {
    logger.info('Auto-resolving alert', {
      fingerprint: alert.fingerprint,
      silentFor: silenceDuration,
      threshold: cooldownMs * 3
    });
    return true;
  }
  return false;
}
```

## Database Schema

```sql
-- Migration: 003_add_alert_suppression_metadata.sql

ALTER TABLE anomaly_alerts 
  ADD COLUMN cooldown_sec INTEGER NOT NULL DEFAULT 300;

ALTER TABLE anomaly_alerts 
  ADD COLUMN first_seen INTEGER NOT NULL DEFAULT 0;

ALTER TABLE anomaly_alerts 
  ADD COLUMN consecutive_count INTEGER NOT NULL DEFAULT 1;

-- Index for persistent alerts
CREATE INDEX idx_anomaly_alerts_consecutive 
  ON anomaly_alerts(metric, consecutive_count, first_seen);

-- Index for flapping detection
CREATE INDEX idx_anomaly_alerts_flapping 
  ON anomaly_alerts(fingerprint, count, consecutive_count);
```

## Benefits

### 1. **No Hardcoded Cooldowns**
Cloud doesn't need to know device-specific cooldown periods. Each alert carries its own configuration.

### 2. **Flapping Detection**
```
count=100, consecutiveCount=2 → Flapping (fired 100 times, never sustained)
count=10, consecutiveCount=10 → Persistent (all detections consecutive)
```

### 3. **Incident Duration Tracking**
`firstSeen` enables accurate incident timeline:
- Time to detection (MTTD)
- Incident duration
- Resolution time (MTTR)

### 4. **Intelligent Escalation**
```typescript
if (consecutiveCount >= 5 && (now - firstSeen) > 3600000) {
  // Persistent for 1+ hour → escalate to on-call
}
```

### 5. **Auto-Resolution**
Silent alerts (3x cooldown period) can be auto-resolved without manual intervention.

## Example: Production Scenario

### Flapping Network Interface
```
Time  | Event              | count | consecutiveCount
------|-------------------|-------|------------------
10:00 | Alert fired       | 1     | 1
10:02 | Within cooldown   | 2     | 2
10:05 | Cooldown expired  | 1     | 3
10:10 | Issue resolved    |       |
10:15 | Alert fired again | 1     | 1  (reset, >3x cooldown)
10:17 | Within cooldown   | 2     | 2
```

**Cloud Analysis**:
- `count` reaches 50+ over time
- `consecutiveCount` never exceeds 3
- **Action**: Flag as flapping, suggest tuning

### Persistent Disk Pressure
```
Time  | Event              | count | consecutiveCount
------|-------------------|-------|------------------
10:00 | Alert fired       | 1     | 1
10:02 | Within cooldown   | 2     | 2
10:05 | Cooldown expired  | 1     | 3
10:10 | Cooldown expired  | 1     | 4
10:15 | Cooldown expired  | 1     | 5 → ESCALATE
```

**Cloud Analysis**:
- `consecutiveCount` >= 5
- `firstSeen` shows 15+ minutes duration
- **Action**: Escalate to on-call engineer

## Migration Path

### Existing Deployments
1. Run migration: `003_add_alert_suppression_metadata.sql`
2. Restart agent (picks up new fields automatically)
3. Cloud services can optionally use new fields
4. Backward compatible (cloud ignores new fields if not implemented)

### New Deployments
Fields populated automatically from first alert.

## Testing

```typescript
describe('Alert Suppression Metadata', () => {
  it('should populate suppression metadata on first detection', () => {
    const alert = createAlert(dataPoint, buffer, config, result);
    expect(alert.cooldownSec).toBe(300);
    expect(alert.firstSeen).toBe(dataPoint.timestamp);
    expect(alert.consecutiveCount).toBe(1);
  });
  
  it('should preserve firstSeen during cooldown', () => {
    const firstAlert = createAlert(dp1, buffer, config, result);
    alertManager.addAlert(firstAlert);
    
    const secondAlert = createAlert(dp2, buffer, config, result);
    alertManager.addAlert(secondAlert);
    
    const stored = alertManager.getAlerts()[0];
    expect(stored.firstSeen).toBe(firstAlert.firstSeen);
    expect(stored.consecutiveCount).toBe(2);
  });
  
  it('should reset consecutiveCount after long silence', () => {
    // Test 3x cooldown period silence resets consecutive count
  });
});
```

## References

- **DevOps Principle**: CALMS - Measurement (track MTTR, MTTD accurately)
- **Related**: [alert-manager.ts](../src/ai/anomaly/alert-manager.ts)
- **Database**: [003_add_alert_suppression_metadata.sql](../database/migrations/003_add_alert_suppression_metadata.sql)
- **Types**: [types.ts](../src/ai/anomaly/types.ts)

---

**Recommendation Status**: ✅ **IMPLEMENTED**  
**Cloud Adoption**: Optional (backward compatible)  
**Edge Deployment**: Automatic (post-migration)
