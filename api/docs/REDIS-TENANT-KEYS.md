# Redis Multi-Tenant Key Format

## Overview

All Redis keys are tenant-scoped using the **`customerId`** from the validated license JWT
(`IOTISTIC_LICENSE_KEY`). No fallback mechanism is permitted. If the license is missing or
invalid the API refuses to start (exit code 1).

The tenant identifier is obtained exclusively via:

```typescript
LicenseValidator.getInstance().getLicense().customerId
```

## Key Format

```
tenant:{customerId}:<type>:<...>
```

| Purpose | Key pattern |
|---------|-------------|
| Device state pub/sub channel | `tenant:{customerId}:device:{deviceUuid}:state` |
| Device metrics pub/sub channel | `tenant:{customerId}:device:{deviceUuid}:metrics` |
| Device metrics wildcard pattern (psubscribe) | `tenant:{customerId}:device:*:metrics` |
| Device metrics Redis Stream | `tenant:{customerId}:metrics:{deviceUuid}` |
| Metrics stream SCAN pattern | `tenant:{customerId}:metrics:*` |
| Device log stream | `tenant:{customerId}:device:logs` |
| Sensor data ingestion stream | `tenant:{customerId}:device:sensors:ingestion` |
| Sensor data processing stream | `tenant:{customerId}:device:sensors:ready` |
| Sensor data dead-letter queue | `tenant:{customerId}:device:sensors:dlq` |

## Key Builder Module

All key construction is centralised in `api/src/redis/tenant-keys.ts`. No other file
should interpolate Redis key strings directly.

Exported helpers:

| Helper | Returns |
|--------|---------|
| `tenantPrefix()` | `tenant:{customerId}` |
| `deviceStateChannel(uuid)` | State pub/sub channel |
| `deviceMetricsChannel(uuid)` | Metrics pub/sub channel |
| `deviceMetricsPattern()` | Wildcard psubscribe pattern |
| `metricsStreamKey(uuid)` | Metrics stream key |
| `metricsStreamScanPattern()` | SCAN MATCH pattern |
| `uuidFromMetricsStreamKey(key)` | Extract UUID from stream key |
| `uuidFromMetricsChannel(channel)` | Extract UUID from channel |
| `deviceLogsStreamKey()` | Log queue stream key |
| `deviceSensorsIngestionStreamKey()` | Sensor ingestion stream key |
| `deviceSensorsReadyStreamKey()` | Sensor processing stream key |
| `deviceSensorsDlqStreamKey()` | Sensor dead-letter queue key |

## Startup Requirement

Because Redis keys are tenant-scoped, **Redis must be initialised only after a successful
license init**. The startup order enforced in `api/src/index.ts` is:

1. Database connection
2. System config load
3. **License validator init** (throws + exits on failure)
4. Redis connect
5. Queue workers start
