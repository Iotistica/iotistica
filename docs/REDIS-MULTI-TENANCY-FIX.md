# Redis Multi-Tenancy Security Fix

## Critical Issues Addressed

This document provides comprehensive fixes for the multi-tenancy security and scalability issues identified in the Redis implementation code review.

### Issues Fixed:
1. ✅ Tenant not in method signature (security)
2. ✅ Redis Cluster slot collision (hash tags)
3. ✅ Consumer group name collision (cross-tenant leaks)
4. ✅ SCAN across all tenants (scalability)
5. ✅ Wildcard subscribe leak (security)  
6. ✅ Pub/Sub channel parsing not validated (security)
7. ✅ MAXLEN memory explosion (200 per device instead of 1000)
8. ✅ Added TTL expiry for streams (24h retention)

---

## 1. File: `api/src/redis/client.ts` - Clean Duplicates First

**Problem**: The file has duplicate/malformed code from partial patches in publishDeviceMetrics method (lines ~150-175).

**Action**: Manually remove the duplicate publishDeviceMetrics method and fix the signature.

**Find this section (lines ~150-175):**
```typescript
  public async publishDeviceMetrics(deviceUuid: string, metrics: any): Promise<boolean> {
    const channel = deviceMetricsChannel(deviceUuid);
     const message = JSON.stringify({
       tenantId,
       deviceUuid,
       metrics,
       timestamp: new Date().toISOString(),
     });
      return await this.publish(channel, message);

    return await this.publish(channel, message);
  }
```

**Replace with:**
```typescript
  public async publishDeviceMetrics(tenantId: string, deviceUuid: string, metrics: any): Promise<boolean> {
    const channel = deviceMetricsChannel(tenantId, deviceUuid);
    const message = JSON.stringify({
      deviceUuid,
      metrics,
      timestamp: new Date().toISOString(),
    });
    return await this.publish(channel, message);
  }
```

---

## 2. File: `api/src/redis/client.ts` - Update Stream Methods

### 2.1 Update `addMetric` method signature and implementation

**Find (around line 180):**
```typescript
  /**
   * Add metric to Redis Stream
   * Stream key: metrics:{deviceUuid}
   * Automatically trims stream to ~1000 entries (approximate, Redis optimizes)
   * 
   * @param deviceUuid - Device UUID
   * @param metrics - Metrics object to store
   * @returns Stream ID (e.g., "1699564800000-0") or null on error
   */
  public async addMetric(deviceUuid: string, metrics: any): Promise<string | null> {
    if (!this.isReady()) {
       logger.warn('  Redis not ready, skipping metric stream write');
      return null;
    }

    const streamKey = metricsStreamKey(deviceUuid);
    
    try {
      // Flatten metrics object for Redis Stream fields
      // Redis Streams store key-value pairs, so we JSON stringify nested objects
      const fields: Record<string, string> = {
        timestamp: new Date().toISOString(),
        data: JSON.stringify(metrics)
      };

      // XADD with MAXLEN ~ 1000 (approximate trimming, more efficient than exact)
      // '*' auto-generates stream ID based on timestamp
      const streamId = await this.client!.xadd(
        streamKey,
        'MAXLEN',
        '~', // Approximate trimming (more efficient)
        '1000',
        '*', // Auto-generate ID
        ...Object.entries(fields).flat()
      );

      return streamId;
    } catch (error) {
       logger.error('  Failed to add metric to Redis Stream:', error);
      return null;
    }
  }
```

**Replace with:**
```typescript
  /**
   * Add metric to Redis Stream
   * Stream key: tenant:{tenantId}:metrics:{deviceUuid}
   * Trims to ~200 entries per device (reduced from 1000 to prevent memory explosion)
   * Sets 24h TTL on stream key to eventually clean up inactive devices
   * 
   * @param tenantId - Tenant identifier (customerId)
   * @param deviceUuid - Device UUID
   * @param metrics - Metrics object to store
   * @returns Stream ID (e.g., "1699564800000-0") or null on error
   */
  public async addMetric(tenantId: string, deviceUuid: string, metrics: any): Promise<string | null> {
    if (!this.isReady()) {
       logger.warn('Redis not ready, skipping metric stream write');
      return null;
    }

    const streamKey = metricsStreamKey(tenantId, deviceUuid);
    
    try {
      // Flatten metrics object for Redis Stream fields
      // Redis Streams store key-value pairs, so we JSON stringify nested objects
      const fields: Record<string, string> = {
        timestamp: new Date().toISOString(),
        data: JSON.stringify(metrics)
      };

      // XADD with MAXLEN ~ 200 (reduced from 1000 to prevent memory explosion)
      // With 10k devices: 200 * 10k = 2M entries (manageable)
      // '*' auto-generates stream ID based on timestamp
      const streamId = await this.client!.xadd(
        streamKey,
        'MAXLEN',
        '~', // Approximate trimming (more efficient)
        '200', // Reduced from 1000 for memory safety
        '*', // Auto-generate ID
        ...Object.entries(fields).flat()
      );

      // Set 24h TTL on stream key to eventually clean up inactive devices
      // This prevents abandoned device streams from accumulating indefinitely
      await this.client!.expire(streamKey, 86400); // 24 hours

      return streamId;
    } catch (error) {
       logger.error('Failed to add metric to Redis Stream:', error);
      return null;
    }
  }
```

### 2.2 Update `ensureConsumerGroup` to use tenant-scoped groups

**Find (around line 225):**
```typescript
  /**
   * Ensure consumer group exists for a device's metrics stream
   */
  private async ensureConsumerGroup(streamKey: string): Promise<void> {
    try {
      await this.client!.xgroup('CREATE', streamKey, this.metricsConsumerGroup, '0', 'MKSTREAM');
      logger.debug(`Created consumer group for ${streamKey}`);
    } catch (err: any) {
      if (!err.message.includes('BUSYGROUP')) {
        throw err; // Unexpected error
      }
      // Group already exists, that's fine
    }
  }
```

**Replace with:**
```typescript
  /**
   * Ensure consumer group exists for a device's metrics stream
   * SECURITY: Consumer groups are tenant-scoped to prevent cross-tenant message stealing
   */
  private async ensureConsumerGroup(tenantId: string, streamKey: string): Promise<void> {
    const groupName = consumerGroupName(tenantId, this.metricsConsumerGroup);
    
    try {
      await this.client!.xgroup('CREATE', streamKey, groupName, '0', 'MKSTREAM');
      logger.debug(`Created consumer group ${groupName} for ${streamKey}`);
    } catch (err: any) {
      if (!err.message.includes('BUSYGROUP')) {
        throw err; // Unexpected error
      }
      // Group already exists, that's fine
    }
  }
```

### 2.3 Update `readMetrics` method

**Find (around line 245):**
```typescript
  /**
   * Read metrics from Redis Stream using consumer groups
   * Used by background worker to batch process metrics with at-least-once delivery
   * 
   * @param deviceUuid - Device UUID (or '*' for all streams)
   * @param count - Maximum number of messages to read (default: 100)
   * @param blockMs - Block for this many ms if no messages (default: 5000, 0 = no block)
   * @returns Array of stream entries with {id, deviceUuid, metrics, timestamp}
   */
  public async readMetrics(
    deviceUuid: string = '*',
    count: number = 100,
    blockMs: number = 5000
  ): Promise<Array<{ id: string; deviceUuid: string; metrics: any; timestamp: string }>> {
```

**Replace with:**
```typescript
  /**
   * Read metrics from Redis Stream using consumer groups
   * Used by background worker to batch process metrics with at-least-once delivery
   * SECURITY: Always scoped to single tenant (no cross-tenant reads)
   * 
   * @param tenantId - Tenant identifier (customerId)
   * @param deviceUuid - Device UUID (or '*' for all streams within this tenant)
   * @param count - Maximum number of messages to read (default: 100)
   * @param blockMs - Block for this many ms if no messages (default: 5000, 0 = no block)
   * @returns Array of stream entries with {id, deviceUuid, metrics, timestamp}
   */
  public async readMetrics(
    tenantId: string,
    deviceUuid: string = '*',
    count: number = 100,
    blockMs: number = 5000
  ): Promise<Array<{ id: string; deviceUuid: string; metrics: any; timestamp: string }>> {
    if (!this.isReady()) {
      return [];
    }

    try {
      // Build stream keys to read from (tenant-scoped)
      const streamKey = deviceUuid === '*' ? metricsStreamScanPattern(tenantId) : metricsStreamKey(tenantId, deviceUuid);
      const groupName = consumerGroupName(tenantId, this.metricsConsumerGroup);
      const consumerNameScoped = makeConsumerName(tenantId, this.metricsConsumerName);
      
      // For wildcard, scan only this tenant's streams (SECURITY: never scan global)
      let streamKeys: string[];
      if (deviceUuid === '*') {
        // Use SCAN instead of KEYS - non-blocking and safe for production
        // SECURITY: Pattern is already tenant-scoped (metricsStreamScanPattern includes tenantId)
        streamKeys = [];
        let cursor = '0';
        
        do {
          const result = await this.client!.scan(
            cursor,
            'MATCH',
            metricsStreamScanPattern(tenantId), // Already tenant-scoped
            'COUNT',
            100
          );
          cursor = result[0];
          streamKeys.push(...result[1]);
        } while (cursor !== '0');
        
        if (streamKeys.length === 0) {
          return []; // No streams yet
        }
      } else {
        streamKeys = [streamKey];
      }

      // Ensure consumer groups exist for all streams
      await Promise.all(streamKeys.map(key => this.ensureConsumerGroup(tenantId, key)));

      const entries: Array<{ id: string; deviceUuid: string; metrics: any; timestamp: string }> = [];

      // Use XREADGROUP for reliable processing with at-least-once delivery
      // In clustered Redis, read each stream separately to avoid CROSSSLOT errors
      // NOTE: Hash tags {tenantId} in keys force same slot, but still safer to iterate
      for (const key of streamKeys) {
        try {
          // Build xreadgroup args - conditionally include BLOCK option
          const xreadgroupArgs: any[] = [
            'GROUP',
            groupName, // Tenant-scoped group
            consumerNameScoped, // Tenant-scoped consumer
            'COUNT',
            count
          ];
          
          if (blockMs > 0) {
            xreadgroupArgs.push('BLOCK', blockMs);
          }
          
          xreadgroupArgs.push('STREAMS', key, '>');
          
          const results = await (this.client!.xreadgroup as any)(...xreadgroupArgs);

          if (!results) {
            continue; // No new messages for this stream
          }

          for (const [streamKeyResult, messages] of results as any[]) {
            // SECURITY: Parse and validate tenant matches
            const parsed = parseMetricsStreamKey(streamKeyResult);
            if (parsed.tenantId !== tenantId) {
              logger.error('Tenant mismatch in stream key', { 
                expected: tenantId, 
                actual: parsed.tenantId, 
                streamKey: streamKeyResult 
              });
              continue; // Skip this message - tenant leak attempt
            }
            
            const uuid = parsed.uuid;
            
            for (const [messageId, fields] of messages) {
              const fieldObj: Record<string, string> = {};
              for (let i = 0; i < fields.length; i += 2) {
                fieldObj[fields[i]] = fields[i + 1];
              }

              entries.push({
                id: messageId,
                deviceUuid: uuid,
                metrics: JSON.parse(fieldObj.data || '{}'),
                timestamp: fieldObj.timestamp || new Date().toISOString()
              });

              // Stop if we've reached the count limit across all streams
              if (entries.length >= count) {
                break;
              }
            }
            
            if (entries.length >= count) {
              break;
            }
          }
        } catch (err: any) {
          logger.error(`Failed to read from ${key}:`, { error: err.message });
        }
        
        if (entries.length >= count) {
          break;
        }
      }

      return entries;
    } catch (error) {
       logger.error('Failed to read metrics from Redis Stream:', error);
      return [];
    }
  }
```

### 2.4 Update `ackMetrics` method

**Find:**
```typescript
  /**
   * Acknowledge processed metrics using consumer group
   * Called after batch write to PostgreSQL succeeds
   * Provides at-least-once delivery guarantee
   * 
   * @param deviceUuid - Device UUID
   * @param messageIds - Array of stream message IDs to acknowledge
   * @returns Number of messages acknowledged
   */
  public async ackMetrics(deviceUuid: string, messageIds: string[]): Promise<number> {
    if (!this.isReady() || messageIds.length === 0) {
      return 0;
    }

    const streamKey = metricsStreamKey(deviceUuid);
    
    try {
      // XACK marks messages as processed in the consumer group
      // Messages remain in stream for other consumers or manual inspection
      const count = await this.client!.xack(
        streamKey,
        this.metricsConsumerGroup,
        ...messageIds
      );
      return count;
    } catch (error) {
      logger.error('Failed to acknowledge metrics:', error);
      return 0;
    }
  }
```

**Replace with:**
```typescript
  /**
   * Acknowledge processed metrics using consumer group
   * Called after batch write to PostgreSQL succeeds
   * Provides at-least-once delivery guarantee
   * 
   * @param tenantId - Tenant identifier (customerId)
   * @param deviceUuid - Device UUID
   * @param messageIds - Array of stream message IDs to acknowledge
   * @returns Number of messages acknowledged
   */
  public async ackMetrics(tenantId: string, deviceUuid: string, messageIds: string[]): Promise<number> {
    if (!this.isReady() || messageIds.length === 0) {
      return 0;
    }

    const streamKey = metricsStreamKey(tenantId, deviceUuid);
    const groupName = consumerGroupName(tenantId, this.metricsConsumerGroup);
    
    try {
      // XACK marks messages as processed in the consumer group
      // Messages remain in stream for other consumers or manual inspection
      const count = await this.client!.xack(
        streamKey,
        groupName, // Tenant-scoped group
        ...messageIds
      );
      return count;
    } catch (error) {
      logger.error('Failed to acknowledge metrics:', error);
      return 0;
    }
  }
```

### 2.5 Update `getStreamLength` method

**Find:**
```typescript
  /**
   * Get stream length (number of pending metrics)
   * Used for monitoring and alerting
   */
  public async getStreamLength(deviceUuid: string): Promise<number> {
    if (!this.isReady()) {
      return 0;
    }

    const streamKey = metricsStreamKey(deviceUuid);
    
    try {
      const length = await this.client!.xlen(streamKey);
      return length;
    } catch (error) {
      return 0;
    }
  }
```

**Replace with:**
```typescript
  /**
   * Get stream length (number of pending metrics)
   * Used for monitoring and alerting
   * 
   * @param tenantId - Tenant identifier (customerId)
   * @param deviceUuid - Device UUID
   */
  public async getStreamLength(tenantId: string, deviceUuid: string): Promise<number> {
    if (!this.isReady()) {
      return 0;
    }

    const streamKey = metricsStreamKey(tenantId, deviceUuid);
    
    try {
      const length = await this.client!.xlen(streamKey);
      return length;
    } catch (error) {
      return 0;
    }
  }
```

---

## 3. File: `api/src/redis/client.ts` - Update Pub/Sub Methods

### 3.1 Update `initializeSubscriber` with tenant validation

**Find (around line 400):**
```typescript
  /**
   * Initialize subscriber event handlers (called once)
   */
  private initializeSubscriber(): void {
    if (this.subscriberInitialized || !this.subscriber) {
      return;
    }

    // Pattern message handler (for wildcard subscriptions)
    this.subscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
      try {
        const data = JSON.parse(message);
        // Extract UUID from "tenant:{customerId}:device:{uuid}:metrics"
        const uuid = uuidFromMetricsChannel(channel);
        
        // Call all registered callbacks for this pattern
        const callbacks = this.patternCallbacks.get(pattern);
        if (callbacks) {
          callbacks.forEach(callback => callback(uuid, data.metrics));
        }
      } catch (error) {
        logger.error('[Redis] Error parsing pattern message:', error);
      }
    });

    // Channel message handler (for specific channel subscriptions)
    this.subscriber.on('message', (channel: string, message: string) => {
      try {
        const data = JSON.parse(message);
        // Extract UUID from "tenant:{customerId}:device:{uuid}:metrics"
        const uuid = uuidFromMetricsChannel(channel);
        
        // Call all registered callbacks for this channel
        const callbacks = this.channelCallbacks.get(channel);
        if (callbacks) {
          callbacks.forEach(callback => callback(uuid, data.metrics));
        }
      } catch (error) {
        logger.error('[Redis] Error parsing channel message:', error);
      }
    });

    // Error handler
    this.subscriber.on('error', (error: Error) => {
      logger.error('[Redis] Subscriber error:', error);
    });

    this.subscriberInitialized = true;
    logger.debug('[Redis] Subscriber event handlers initialized');
  }
```

**Replace with:**
```typescript
  /**
   * Initialize subscriber event handlers (called once)
   * SECURITY: Validates tenant in all received messages
   */
  private initializeSubscriber(): void {
    if (this.subscriberInitialized || !this.subscriber) {
      return;
    }

    // Pattern message handler (for wildcard subscriptions)
    this.subscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
      try {
        const data = JSON.parse(message);
        
        // SECURITY: Parse and validate tenant matches
        const parsed = parseMetricsChannel(channel);
        
        // Extract expected tenant from pattern (pattern format: tenant:{tenantId}:device:*:metrics)
        const patternMatch = pattern.match(/^tenant:\{([^}]+)\}:/);
        if (!patternMatch) {
          logger.error('[Redis] Invalid pattern format', { pattern });
          return;
        }
        const expectedTenant = patternMatch[1];
        
        if (parsed.tenantId !== expectedTenant) {
          logger.error('[Redis] Tenant mismatch in pub/sub message', { 
            expected: expectedTenant, 
            actual: parsed.tenantId, 
            channel 
          });
          return; // Skip this message - tenant leak attempt
        }
        
        // Call all registered callbacks for this pattern
        const callbacks = this.patternCallbacks.get(pattern);
        if (callbacks) {
          callbacks.forEach(callback => callback(parsed.uuid, data.metrics));
        }
      } catch (error) {
        logger.error('[Redis] Error parsing pattern message:', error);
      }
    });

    // Channel message handler (for specific channel subscriptions)
    this.subscriber.on('message', (channel: string, message: string) => {
      try {
        const data = JSON.parse(message);
        
        // SECURITY: Parse and validate tenant (though specific channels are pre-validated)
        const parsed = parseMetricsChannel(channel);
        
        // Call all registered callbacks for this channel
        const callbacks = this.channelCallbacks.get(channel);
        if (callbacks) {
          callbacks.forEach(callback => callback(parsed.uuid, data.metrics));
        }
      } catch (error) {
        logger.error('[Redis] Error parsing channel message:', error);
      }
    });

    // Error handler
    this.subscriber.on('error', (error: Error) => {
      logger.error('[Redis] Subscriber error:', error);
    });

    this.subscriberInitialized = true;
    logger.debug('[Redis] Subscriber event handlers initialized');
  }
```

### 3.2 Update `subscribeToDeviceMetrics` method

**Find:**
```typescript
  /**
   * Subscribe to device metrics updates (Phase 1)
   * Used by WebSocket manager to forward real-time updates to dashboard
   * 
   * @param deviceUuid - Device UUID or '*' for all devices (pattern subscription)
   * @param callback - Function to call when metrics received
   * @returns Promise<void>
   */
  public async subscribeToDeviceMetrics(
    deviceUuid: string,
    callback: (deviceUuid: string, metrics: any) => void
  ): Promise<void> {
    if (!this.isReady()) {
      throw new Error('Redis not connected - cannot subscribe');
    }

    // Get subscriber client from factory (separate connection for pub/sub)
    if (!this.subscriber) {
      this.subscriber = getRedisSubscriber();
      this.initializeSubscriber(); // Initialize handlers once
    }

    // Determine pattern or channel
    const pattern = deviceUuid === '*' ? deviceMetricsPattern() : deviceMetricsChannel(deviceUuid);
    
    if (deviceUuid === '*') {
      // Pattern subscription for all devices
      
      // Register callback
      if (!this.patternCallbacks.has(pattern)) {
        this.patternCallbacks.set(pattern, new Set());
        // Only subscribe to Redis if this is a new pattern
        await this.subscriber.psubscribe(pattern);
        logger.info(`[Redis] Subscribed to pattern: ${pattern}`);
      }
      this.patternCallbacks.get(pattern)!.add(callback);
      
    } else {
      // Single channel subscription
      
      // Register callback
      if (!this.channelCallbacks.has(pattern)) {
        this.channelCallbacks.set(pattern, new Set());
        // Only subscribe to Redis if this is a new channel
        await this.subscriber.subscribe(pattern);
        logger.info(`[Redis] Subscribed to channel: ${pattern}`);
      }
      this.channelCallbacks.get(pattern)!.add(callback);
    }

    logger.debug(`[Redis] Callback registered for ${deviceUuid === '*' ? 'pattern' : 'channel'}: ${pattern}`);
  }
```

**Replace with:**
```typescript
  /**
   * Subscribe to device metrics updates (Phase 1)
   * Used by WebSocket manager to forward real-time updates to dashboard
   * SECURITY: Always scoped to single tenant (wildcard '*' still tenant-scoped)
   * 
   * @param tenantId - Tenant identifier (customerId)
   * @param deviceUuid - Device UUID or '*' for all devices within this tenant
   * @param callback - Function to call when metrics received
   * @returns Promise<void>
   */
  public async subscribeToDeviceMetrics(
    tenantId: string,
    deviceUuid: string,
    callback: (deviceUuid: string, metrics: any) => void
  ): Promise<void> {
    if (!this.isReady()) {
      throw new Error('Redis not connected - cannot subscribe');
    }

    // Get subscriber client from factory (separate connection for pub/sub)
    if (!this.subscriber) {
      this.subscriber = getRedisSubscriber();
      this.initializeSubscriber(); // Initialize handlers once
    }

    // Determine pattern or channel (tenant-scoped)
    const pattern = deviceUuid === '*' ? deviceMetricsPattern(tenantId) : deviceMetricsChannel(tenantId, deviceUuid);
    
    if (deviceUuid === '*') {
      // Pattern subscription for all devices within this tenant
      // SECURITY: Pattern is tenant-scoped, never global
      
      // Register callback
      if (!this.patternCallbacks.has(pattern)) {
        this.patternCallbacks.set(pattern, new Set());
        // Only subscribe to Redis if this is a new pattern
        await this.subscriber.psubscribe(pattern);
        logger.info(`[Redis] Subscribed to tenant-scoped pattern: ${pattern}`);
      }
      this.patternCallbacks.get(pattern)!.add(callback);
      
    } else {
      // Single channel subscription
      
      // Register callback
      if (!this.channelCallbacks.has(pattern)) {
        this.channelCallbacks.set(pattern, new Set());
        // Only subscribe to Redis if this is a new channel
        await this.subscriber.subscribe(pattern);
        logger.info(`[Redis] Subscribed to channel: ${pattern}`);
      }
      this.channelCallbacks.get(pattern)!.add(callback);
    }

    logger.debug(`[Redis] Callback registered for ${deviceUuid === '*' ? 'pattern' : 'channel'}: ${pattern}`);
  }
```

### 3.3 Update `unsubscribeFromDeviceMetrics` method

**Find:**
```typescript
  /**
   * Unsubscribe from device metrics updates
   * 
   * @param deviceUuid - Device UUID or '*' for all devices
   * @param callback - The callback to remove (optional - if not provided, removes all callbacks)
   */
  public async unsubscribeFromDeviceMetrics(
    deviceUuid: string,
    callback?: (deviceUuid: string, metrics: any) => void
  ): Promise<void> {
    if (!this.subscriber) {
      return;
    }

    const pattern = deviceUuid === '*' ? deviceMetricsPattern() : deviceMetricsChannel(deviceUuid);
```

**Replace with:**
```typescript
  /**
   * Unsubscribe from device metrics updates
   * 
   * @param tenantId - Tenant identifier (customerId)
   * @param deviceUuid - Device UUID or '*' for all devices
   * @param callback - The callback to remove (optional - if not provided, removes all callbacks)
   */
  public async unsubscribeFromDeviceMetrics(
    tenantId: string,
    deviceUuid: string,
    callback?: (deviceUuid: string, metrics: any) => void
  ): Promise<void> {
    if (!this.subscriber) {
      return;
    }

    const pattern = deviceUuid === '*' ? deviceMetricsPattern(tenantId) : deviceMetricsChannel(tenantId, deviceUuid);
```

---

## 4. File: `api/src/services/redis-log-queue.ts` - Apply Same Patterns

Apply all the same patterns to the log queue service:

1. Add `tenantId` parameter to constructor or pass via options
2. Update `deviceLogsStreamKey()` calls to `deviceLogsStreamKey(tenantId)`
3. Use `consumerGroupName(tenantId, 'log-writers')` for consumer group
4. Use `makeConsumerName(tenantId, workerName)` for consumer name
5. Add tenant validation in message processing
6. Reduce MAXLEN from 500K to 100K per tenant
7. Add EXPIRE TTL (24h) on log streams

**Key changes needed in redis-log-queue.ts:**

```typescript
// Update constructor to accept tenantId
constructor(tenantId: string) {
  this.tenantId = tenantId;
  // ... rest of constructor
  this.consumerGroup = consumerGroupName(tenantId, 'log-writers');
  this.consumerName = makeConsumerName(tenantId, `worker-${process.pid}-${Date.now()}`);
  // ...
}

// Update streamKey getter
private get streamKey(): string { 
  return deviceLogsStreamKey(this.tenantId); 
}

// In XADD call - reduce MAXLEN and add EXPIRE
await this.redisIngestion.xadd(
  this.streamKey,
  'MAXLEN', '~', '100000', // Reduced from 500K
  '*',
  // ... fields
);

// Set TTL to clean up inactive log streams
await this.redisIngestion.expire(this.streamKey, 86400); // 24h
```

---

## 5. Update All Callers

Search for all places that call these methods and add the `tenantId` parameter:

```bash
# PowerShell search commands:
Get-ChildItem -Path "api\src" -Recurse -Filter "*.ts" | Select-String "addMetric\("
Get-ChildItem -Path "api\src" -Recurse -Filter "*.ts" | Select-String "readMetrics\("
Get-ChildItem -Path "api\src" -Recurse -Filter "*.ts" | Select-String "ackMetrics\("
Get-ChildItem -Path "api\src" -Recurse -Filter "*.ts" | Select-String "publishDeviceMetrics\("
Get-ChildItem -Path "api\src" -Recurse -Filter "*.ts" | Select-String "publishDeviceState\("
Get-ChildItem -Path "api\src" -Recurse -Filter "*.ts" | Select-String "subscribeToDeviceMetrics\("
```

For each caller, update to pass `tenantId` as the first parameter. You can get tenantId from:

```typescript
import { getCustomerId } from '../redis/tenant-keys';

const tenantId = getCustomerId(); // From validated license
```

Or if you already have access to the license:

```typescript
const tenantId = license.customerId;
```

---

## 6. Memory Safety Configuration

Add these environment variables for production:

```bash
# Per-device stream limits (reduced from 1000)
METRICS_STREAM_MAXLEN=200
LOG_STREAM_MAXLEN=100000

# Stream TTL (24 hours - cleans up inactive devices)
STREAM_TTL_SECONDS=86400

# Consumer group settings
METRICS_CONSUMER_GROUP=metrics-writers
LOG_CONSUMER_GROUP=log-writers

# Batch processing
METRICS_BATCH_SIZE=100
LOG_BATCH_SIZE=50
```

---

## 7. Testing Checklist

- [ ] No cross-tenant data leaks (test with 2+ tenants)
- [ ] Consumer groups isolated per tenant
- [ ] SCAN operations scoped to single tenant
- [ ] Pub/sub wildcard subscriptions tenant-scoped
- [ ] Channel parsing validates tenant ownership
- [ ] Stream keys use hash tags for Redis Cluster
- [ ] MAXLEN limits prevent memory explosion
- [ ] TTL expiry cleans up inactive streams
- [ ] All methods require explicit tenantId parameter

---

## 8. Migration Path (Backward Compatibility)

If you need to support existing code temporarily, you can create wrapper methods:

```typescript
// Legacy methods (deprecated)
/** @deprecated Use addMetric(tenantId, deviceUuid, metrics) */
public async addMetricLegacy(deviceUuid: string, metrics: any): Promise<string | null> {
  const tenantId = getCustomerId(); // From global license
  return this.addMetric(tenantId, deviceUuid, metrics);
}

/** @deprecated Use readMetrics(tenantId, deviceUuid, count, blockMs) */
public async readMetricsLegacy(deviceUuid: string = '*', count: number = 100, blockMs: number = 5000) {
  const tenantId = getCustomerId(); // From global license
  return this.readMetrics(tenantId, deviceUuid, count, blockMs);
}
```

But **DO NOT** use these for new code. They defeat the security purpose of explicit tenant parameters.

---

## Summary

These changes transform the Redis implementation from an implicit single-tenant design to an explicit, secure multi-tenant architecture that:

1. **Prevents tenant data leaks** - Explicit tenantId parameters, validated parsing
2. **Optimizes Redis Cluster** - Hash tags force tenant data to same slot
3. **Isolates consumer groups** - Tenant-scoped groups prevent message stealing
4. **Scales efficiently** - SCAN scoped per tenant, not global
5. **Secures pub/sub** - Wildcard subscriptions tenant-scoped, validated callbacks
6. **Manages memory** - Reduced MAXLEN (200 vs 1000) + TTL expiry
7. **Prevents DOS** - Per-tenant limits, no unbounded global SCAN

Apply these fixes methodically, test thoroughly with multiple tenants, and monitor Redis memory usage in production.
