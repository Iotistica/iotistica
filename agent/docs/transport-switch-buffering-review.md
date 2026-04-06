# Transport Switch Buffering Review

## Scope

This note reviews the agent publish path around the state transport switch in CloudSync and documents the buffering and spooling mechanisms already present in the agent.

The goal is to support a graceful transition from direct publishing to local buffering when cloud transport is degraded, without introducing a new persistence subsystem.

## Current State Transport Flow

The current state-report path is:

1. `CloudSync.reportCurrentState()` builds a full report payload.
2. `CloudSync.sendReport()` selects the transport.
3. MQTT is attempted first when `mqttManager.isConnected()` is true.
4. If MQTT publish fails, the code falls through to HTTP.
5. If the overall send fails, the stripped report is queued into `OfflineQueue<DeviceStateReport>('state-reports', 1000)`.

This means the transport switch happens late. The report is assembled first, and only at send time does the code decide whether to try MQTT, HTTP, or queue for later.

## Verified Spooling Capabilities

### 1. Durable MQTT message spool

Files:

- `src/mqtt/manager.ts`
- `src/mqtt/buffer.ts`
- `src/db/models/buffer.model.ts`

Behavior:

- `MqttManager` enables `MessageBufferSync` during infrastructure initialization.
- `MessageBufferSync.handlePublish()` intercepts `publish()` and `publishNoQueue()`.
- Messages are durably persisted in SQLite table `message_buffer`.
- Flush is batched and retry-aware.
- Quotas, TTL cleanup, retry backoff, and oldest-record dropping already exist.

Important limitation:

- This layer buffers only when MQTT is disconnected or when `bufferEvenWhenOnline` is enabled.
- There is no higher-level transport gate that says "MQTT is technically connected, but do not publish right now because the transport is switching or degraded."

### 2. Durable endpoint telemetry spool with claim-before-publish semantics

Files:

- `src/features/publish/manager.ts`
- `src/db/models/buffer.model.ts`

Behavior:

- Endpoint telemetry batches are stronger than the generic MQTT path.
- `PublishManager.publishOnline()` first writes a claimed record with `enqueueClaimed()`.
- The claimed row is deleted only after publish succeeds.
- If shutdown or publish failure occurs, the row is marked for retry instead of being lost.

This is the strongest existing pattern in the agent. It already implements the right delivery shape for graceful transitions:

- persist first
- attempt delivery second
- delete only after success

### 3. Durable CloudSync report queue

Files:

- `src/managers/cloud-sync.ts`
- `src/logging/offline-queue.ts`
- `src/db/models/offline-queue.model.ts`

Behavior:

- State reports are queued only after `sendReport()` fails.
- The queue is persisted to SQLite in `offline_queue`.
- Queue size is capped at 1000 items.
- Oldest entries are dropped when full.
- Successful report delivery triggers a rate-limited flush of queued reports.

Important limitation:

- This queue is reactive, not proactive.
- It helps after send failure, but it does not stop new send attempts during a transport transition.

### 4. In-memory MQTT pending publish queue

File:

- `src/mqtt/manager.ts`

Behavior:

- `MqttManager` also maintains an in-memory `pendingPublishes` queue with a fixed maximum.
- This queue is not durable and does not survive restart or power loss.

Conclusion:

- This queue is useful for short-lived local backpressure.
- It should not be treated as the primary outage spool.

### 5. Cloud log buffering and disk spool

Files:

- `src/logging/cloud-backend.ts`
- `src/api/actions.ts`

Behavior:

- Cloud log shipping has its own buffer, pending batch tracking, and optional disk-backed spool.
- Pending batches are retained for retry.
- Spool replay on restart is supported.
- The device API already exposes health counters for this subsystem.

This spool is separate from telemetry and CloudSync state reporting.

## Gap During Transport Switching

The missing behavior is a short-lived "do not publish directly" mode during transport degradation or handoff.

Today:

- `CloudSync.sendReport()` tries MQTT whenever the MQTT client is connected.
- `MessageBufferSync` only buffers when the MQTT connection is down, not when the system is intentionally quiescing direct publish.
- State reporting therefore keeps attempting direct send during the transition window.

That creates two problems:

1. repeated direct-send attempts during a known degraded period
2. a semantic mismatch between control-plane knowledge and publish admission

In other words, the agent knows the transport is unhealthy only after failed publish attempts, but the publish layer has no explicit mode for buffering-first during that period.

## Proposed Solution

### Design summary

Add a small transport gate that can switch direct publish into buffer-only mode without changing the existing storage models.

Use the existing durable stores:

- `message_buffer` for MQTT payloads
- `offline_queue` for state reports

Do not introduce a new queue type.

### Proposed control states

Add a manager-level publish mode with explicit semantics:

- `direct`: normal behavior
- `buffer-only`: accept publishes, but persist instead of sending
- `recovering`: keep buffering and do not flush until transport stability is confirmed

This can live in `MqttManager` or `MessageBufferSync`, but the effective admission check should be enforced in `MessageBufferSync.handlePublish()` and in the CloudSync state-report path.

### Minimal implementation approach

1. Add publish-mode state to `MqttManager`.
2. Expose `setPublishMode()` and `getPublishMode()`.
3. Update `MessageBufferSync.handlePublish()` to buffer when any of the following is true:
   - MQTT disconnected
   - `bufferEvenWhenOnline` enabled
   - publish mode is not `direct`
4. Update `MessageBufferSync.flushBuffer()` so it does not flush while publish mode is `buffer-only` or `recovering`.
5. In `CloudSync.sendReport()`, short-circuit to queue when CloudSync has entered `buffer-only` mode.
6. In `recovering` mode, skip MQTT and use HTTP fallback only.
7. When transport health is restored, move from `recovering` to `direct` only after a small stability condition, such as:
   - MQTT reconnect event plus one successful report
   - or N consecutive successful sends
8. On transition back to `direct`, request buffered flush explicitly.

### Why this fits existing code patterns

This solution reuses patterns already in the repo:

- `MessageBufferSync` already provides SQLite-backed MQTT persistence and flush control.
- `PublishManager` already uses claim-before-publish and delete-after-success semantics.
- `OfflineQueue` already stores CloudSync reports durably and flushes later.

The change is therefore not architectural. It is a small admission-control improvement at the point where transport choice is made.

## Recommended Behavior by Flow

### Endpoint telemetry

Recommended behavior:

- Keep the existing `PublishManager` durable claim-first path.
- If the system enters buffer-only or recovering mode, skip live publish and immediately follow the offline path.

This is already close to what `PublishManager.publishOffline()` does when MQTT is disconnected. The only change is to let transport mode drive the same branch even while the socket still reports connected.

### CloudSync state reports

Recommended behavior:

- If CloudSync detects a transport handoff or degraded period, enqueue the stripped report immediately instead of attempting MQTT then HTTP repeatedly.
- Exit buffer-only only after transport stability is re-established.

This makes state reporting deterministic during failover and avoids treating the transition itself as a stream of send failures.

## Implementation Notes

If a code change is made, the lowest-risk sequence is:

1. introduce publish mode in `MqttManager`
2. wire `MessageBufferSync.handlePublish()` to honor the mode
3. prevent flush while mode is not `direct`
4. teach `CloudSync.sendReport()` to short-circuit into `OfflineQueue` in `buffer-only` mode and prefer HTTP during `recovering`
5. add one status field to the existing buffer-status output so the active publish mode is visible via the device API

## Bottom Line

The agent already has the persistence primitives needed for graceful transport switching.

What is missing is not storage. What is missing is a small explicit transition state between "publish live" and "flush backlog" so the system can stop direct publishing early, buffer locally, and resume only after transport stability is confirmed.