# Redis Multi-Tenant Key Format

## Overview

All Redis keys are tenant-scoped using the **`customerId`** from the validated license JWT.

**SECURITY UPDATE**: All public functions now require explicit `tenantId` parameter to prevent 
cross-tenant data leaks. Never rely on implicit global context.

**CLUSTER OPTIMIZATION**: All keys use hash tags `{tenantId}` to force tenant data into the 
same Redis Cluster slot, preventing CROSSSLOT errors.

The tenant identifier can be obtained via (but always pass explicitly):

```typescript
LicenseValidator.getInstance().getLicense().customerId
```

## Key Format

```
tenant:{customerId}:<type>:<...>
**Hash Tag Format** (for Redis Cluster):
```
tenant:{customerId}:...
```
The curly braces `{customerId}` force Redis Cluster to hash only that portion,
ensuring all keys for a tenant map to the same slot.

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
| Consumer group (metrics) | `{customerId}:metrics-writers` |
| Consumer group (logs) | `{customerId}:log-writers` |
| Consumer name | `{customerId}:worker-{pid}-{timestamp}` |

## Key Builder Module

All key construction is centralised in `api/src/redis/tenant-keys.ts`. No other file
should interpolate Redis key strings directly.

**BREAKING CHANGE**: All functions now require explicit `tenantId` parameter.

Exported helpers (updated signatures):

| Helper | Returns |
|--------|---------|
| `tenantPrefix(tenantId)` | `tenant:{tenantId}` with hash tag |
| `deviceStateChannel(tenantId, uuid)` | State pub/sub channel |
| `deviceMetricsChannel(tenantId, uuid)` | Metrics pub/sub channel |
| `deviceMetricsPattern(tenantId)` | Wildcard psubscribe pattern (tenant-scoped) |
| `metricsStreamKey(tenantId, uuid)` | Metrics stream key |
| `metricsStreamScanPattern(tenantId)` | SCAN MATCH pattern (tenant-scoped) |
| `parseMetricsStreamKey(key)` | Parse and validate: `{ tenantId, uuid }` |
| `parseMetricsChannel(channel)` | Parse and validate: `{ tenantId, uuid }` |
| `deviceLogsStreamKey(tenantId)` | Log queue stream key |
| `consumerGroupName(tenantId, group)` | Tenant-scoped consumer group |
| `consumerName(tenantId, worker)` | Tenant-scoped consumer name |

**Security Helpers** (new):
- `parseMetricsStreamKey(key)` - Parses and validates tenant ownership
- `parseMetricsChannel(channel)` - Parses and validates tenant ownership

**Legacy Helpers** (deprecated, do not use for new code):
- `uuidFromMetricsStreamKey(key)` - Use `parseMetricsStreamKey()` instead
- `uuidFromMetricsChannel(channel)` - Use `parseMetricsChannel()` instead
- `getCustomerId()` - Use explicit tenantId parameters instead
- `tenantPrefixLegacy()` - Use `tenantPrefix(tenantId)` instead
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
