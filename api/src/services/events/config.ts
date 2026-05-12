/**
 * Event Sourcing Configuration
 * Controls event publishing verbosity and retention
 */

export const EventSourcingConfig = {
  // ============================================================================
  // Event Publishing Controls
  // ============================================================================
  
  /**
   * Publish device.heartbeat events?
   * - true: Every state report creates an event (VERY noisy - 1000s/day per device)
   * - false: Only publish meaningful connectivity changes (recommended)
   * 
   * Default: false (rely on device.online/offline for connectivity tracking)
   */
  PUBLISH_HEARTBEAT_EVENTS: process.env.PUBLISH_HEARTBEAT_EVENTS === 'true' || false,

  /**
   * Publish current_state.updated events?
   * - 'always': Every state report creates an event (noisy)
   * - 'changes': Only when apps or config actually changes (recommended)
   * - 'never': Don't publish state update events
   * 
   * Default: 'changes'
   */
  PUBLISH_STATE_UPDATES: (process.env.PUBLISH_STATE_UPDATES as 'always' | 'changes' | 'never') || 'changes',

  /**
   * Sample high-frequency events?
   * When enabled, only publish 1 out of every N events for high-frequency event types
   * 
   * Example: SAMPLE_RATE=10 means 1 in 10 events is published (10% sampling)
   * 
   * Default: 1 (no sampling - publish all events)
   */
  SAMPLE_RATE: parseInt(process.env.EVENT_SAMPLE_RATE || '1'),

  /**
   * Event types to apply sampling to (when SAMPLE_RATE > 1)
   * Only these event types will be sampled, others always published
   */
  SAMPLED_EVENT_TYPES: [
    'device.heartbeat',
    'current_state.updated',
  ] as const,

  // ============================================================================
  // Event Retention
  // ============================================================================

  /**
   * How long to keep events before archiving/deleting
   * 
   * Default: 90 days
   */
  RETENTION_DAYS: parseInt(process.env.EVENT_RETENTION_DAYS || '90'),

  /**
   * Archive old events instead of deleting?
   * - true: Move to archive table (for compliance/historical analysis)
   * - false: Permanently delete old events
   * 
   * Default: false
   */
  ARCHIVE_OLD_EVENTS: process.env.ARCHIVE_OLD_EVENTS === 'true' || false,

  // ============================================================================
  // Performance Optimization
  // ============================================================================

  /**
   * Batch event publishing?
   * When enabled, events are queued and published in batches
   * Reduces database load but adds slight delay (100-500ms)
   * 
   * Default: false (publish immediately)
   */
  ENABLE_BATCHING: process.env.ENABLE_EVENT_BATCHING === 'true' || false,

  /**
   * Batch size (when batching enabled)
   * 
   * Default: 10 events
   */
  BATCH_SIZE: parseInt(process.env.EVENT_BATCH_SIZE || '10'),

  /**
   * Maximum batch delay in milliseconds
   * Flush batch even if not full after this time
   * 
   * Default: 500ms
   */
  BATCH_DELAY_MS: parseInt(process.env.EVENT_BATCH_DELAY_MS || '500'),

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Should we publish this event?
   * Checks both explicit disable flags and sampling rate
   */
  shouldPublishEvent(eventType: string): boolean {
    // Check explicit disable flags first
    if (eventType === 'device.heartbeat' && !this.PUBLISH_HEARTBEAT_EVENTS) {
      return false;
    }

    // Non-sampled events always publish
    if (!this.SAMPLED_EVENT_TYPES.includes(eventType as any)) {
      return true;
    }

    // No sampling configured
    if (this.SAMPLE_RATE <= 1) {
      return true;
    }

    // Apply sampling: 1 in N events
    return Math.random() < (1 / this.SAMPLE_RATE);
  },

  /**
   * Should we publish state update events?
   */
  shouldPublishStateUpdate(hasChanges: boolean): boolean {
    if (this.PUBLISH_STATE_UPDATES === 'never') {
      return false;
    }
    if (this.PUBLISH_STATE_UPDATES === 'always') {
      return true;
    }
    // 'changes' mode - only publish if state changed
    return hasChanges;
  },

  /**
   * Get current configuration summary
   */
  getSummary() {
    return {
      heartbeat_events: this.PUBLISH_HEARTBEAT_EVENTS ? 'enabled' : 'disabled',
      state_updates: this.PUBLISH_STATE_UPDATES,
      sampling: this.SAMPLE_RATE > 1 ? `1 in ${this.SAMPLE_RATE}` : 'disabled',
      retention_days: this.RETENTION_DAYS,
      batching: this.ENABLE_BATCHING ? 'enabled' : 'disabled',
      batch_size: this.BATCH_SIZE,
    };
  },
};

export default EventSourcingConfig;
