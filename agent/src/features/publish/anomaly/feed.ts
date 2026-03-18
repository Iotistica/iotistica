import type { AnomalyDetectionService } from '../../../anomaly/index.js';
import { extractRawDeviceState } from '../../../anomaly/device-state.js';
import type { Logger } from '../types.js';

/**
 * Walks each batch message, extracts every numeric field, and feeds them to the
 * anomaly detector.  The service is resolved lazily via `getService` so that
 * late injection (configureAnomalyFeed called after construction) is supported.
 */
export class AnomalyFeed {
  // Per-batch dedup — reset at the start of every processBatch() call
  private batchVisited = new WeakSet<object>();
  private batchProcessedMetrics = new Set<string>();

  constructor(
    private readonly getService: () => AnomalyDetectionService | undefined,
    private readonly deviceUuid: string,
    private readonly protocol: string | undefined,
    private readonly logger?: Logger,
  ) {}

  processBatch(messages: unknown[], deviceName: string): void {
    const service = this.getService();
    if (!service?.hasConfiguredMetrics()) return;
    const timestampMs = Date.now();
    this.batchVisited = new WeakSet();
    this.batchProcessedMetrics.clear();

    for (const data of messages) {
      this.extractNumericFields(data, deviceName, timestampMs);
    }

    if (this.batchProcessedMetrics.size > 0) {
      this.logger?.debug('[ANOMALY] Endpoint processing complete', {
        deviceName,
        messageCount: messages.length,
        extractedMetricCount: this.batchProcessedMetrics.size,
        sampleMetrics: Array.from(this.batchProcessedMetrics).slice(0, 10),
      });
    }
  }

  // --- helpers ----------------------------------------------------------------

  private toFiniteNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return undefined;
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }

  // Canonical 3-part key: <endpointDeviceUuid>_<deviceIdentifier>_<fieldName>
  private buildMetricKey(deviceIdentifier: string | undefined, deviceName: string, fieldName: string): string {
    const identifier = (deviceIdentifier || deviceName || 'unknown').trim();
    return `${this.deviceUuid}_${identifier}_${fieldName}`;
  }

  private resolveDeviceId(...candidates: unknown[]): string | undefined {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
      if (typeof c === 'number' && Number.isFinite(c)) return String(c);
    }
    return undefined;
  }

  private dispatchToAnomaly(
    metricKey: string,
    point: Omit<Parameters<AnomalyDetectionService['processDataPoint']>[0], 'metric'>,
  ): boolean {
    const service = this.getService();
    if (!service) return false;
    if (!service.isMetricConfigured(metricKey)) return false;
    if (this.batchProcessedMetrics.has(metricKey)) return false;
    this.batchProcessedMetrics.add(metricKey);
    service.processDataPoint({ metric: metricKey, ...point });
    return true;
  }

  // Bare number payload — no device wrapper, falls back to endpoint identity.
  private dispatchDirectNumeric(value: number, deviceName: string, timestampMs: number, prefix: string): void {
    const fieldName = prefix || 'value';
    const metricKey = this.buildMetricKey(undefined, deviceName, fieldName);
    const fallbackDeviceId = deviceName ? `endpoint:${deviceName}` : undefined;

    this.logger?.warn('[ANOMALY] No explicit deviceId in payload; using fallback identity', {
      device: deviceName, protocol: this.protocol,
      metricKey, fallbackDeviceId, reason: 'direct_numeric_payload',
    });

    this.dispatchToAnomaly(metricKey, {
      source: 'endpoint', protocol: this.protocol as any, rawDeviceState: undefined,
      value, unit: '', timestamp: timestampMs, quality: 'GOOD',
      deviceId: fallbackDeviceId,
      tags: { sensorName: deviceName, endpointId: deviceName, field: fieldName },
    });
  }

  // OPC-UA reading object: { deviceName, metric|name, value, ... }
  private dispatchReadingObject(data: any, parentDeviceName: string, timestampMs: number): void {
    const readingDeviceName: string = data.deviceName;
    const payloadDeviceUuid: string | undefined = data.device_uuid || data.deviceUuid;
    const resolvedDeviceId = this.resolveDeviceId(data.deviceId, data.device_id);
    const fieldName: string = data.metric || data.name;
    const value = this.toFiniteNumber(data.value);
    const quality: string = data.quality || 'GOOD';

    if (value === undefined) {
      this.logger?.debug('[ANOMALY] Skipping non-numeric reading', {
        endpoint: parentDeviceName, deviceName: readingDeviceName, fieldName,
        rawType: typeof data.value, rawValue: data.value,
      });
      return;
    }

    const effectiveDeviceId = resolvedDeviceId || `endpoint:${parentDeviceName}`;
    if (!resolvedDeviceId && !payloadDeviceUuid) {
      this.logger?.warn('[ANOMALY] No explicit deviceId in payload; using fallback identity', {
        device: parentDeviceName, protocol: this.protocol,
        metricName: fieldName, deviceName: readingDeviceName, fallbackDeviceId: effectiveDeviceId,
        reason: 'reading_object_missing_device_id',
      });
    }

    const metricKey = this.buildMetricKey(payloadDeviceUuid || readingDeviceName, parentDeviceName, fieldName);
    this.dispatchToAnomaly(metricKey, {
      source: 'endpoint', protocol: this.protocol as any,
      rawDeviceState: data.deviceState ?? data.state ?? data.status ?? extractRawDeviceState(data),
      value, unit: data.unit || '', timestamp: timestampMs,
      quality: quality === 'GOOD' || quality === 'Good' ? 'GOOD' : 'BAD',
      deviceId: effectiveDeviceId,
      tags: {
        sensorName: parentDeviceName, endpointId: parentDeviceName,
        ...(payloadDeviceUuid && { deviceUuid: payloadDeviceUuid }),
        deviceName: readingDeviceName, fieldName,
      },
    });
  }

  // Modbus readings array: [{ deviceName, metric|registerName, value, ... }]
  private dispatchReadingsArray(readings: any[], parentDeviceName: string, timestampMs: number): void {
    for (const reading of readings) {
      if (typeof reading !== 'object' || reading === null) continue;

      const readingDeviceName: string = reading.deviceName || parentDeviceName;
      const payloadDeviceUuid: string | undefined = reading.device_uuid || reading.deviceUuid;
      const resolvedDeviceId = this.resolveDeviceId(reading.deviceId, reading.device_id);
      // metric (standard) > registerName (Modbus) > name (legacy)
      const fieldName: string | undefined = reading.metric || reading.registerName || reading.name;
      const value = this.toFiniteNumber(reading.value);
      const quality: string = reading.quality || 'GOOD';

      if (!fieldName) continue;

      if (value === undefined) {
        this.logger?.debug('[ANOMALY] Skipping non-numeric array reading', {
          endpoint: parentDeviceName, deviceName: readingDeviceName, fieldName,
          rawType: typeof reading.value, rawValue: reading.value,
        });
        continue;
      }

      const effectiveDeviceId = resolvedDeviceId || `endpoint:${parentDeviceName}`;
      if (!resolvedDeviceId && !payloadDeviceUuid) {
        this.logger?.warn('[ANOMALY] No explicit deviceId in payload; using fallback identity', {
          device: parentDeviceName, protocol: this.protocol,
          metricName: fieldName, deviceName: readingDeviceName, fallbackDeviceId: effectiveDeviceId,
          reason: 'readings_array_missing_device_id',
        });
      }

      const metricKey = this.buildMetricKey(payloadDeviceUuid || readingDeviceName, parentDeviceName, fieldName);
      this.dispatchToAnomaly(metricKey, {
        source: 'endpoint', protocol: this.protocol as any,
        rawDeviceState: reading.deviceState ?? reading.state ?? reading.status ?? extractRawDeviceState(reading),
        value, unit: reading.unit || '', timestamp: timestampMs,
        quality: quality === 'GOOD' || quality === 'Good' ? 'GOOD' : 'BAD',
        deviceId: effectiveDeviceId,
        tags: {
          sensorName: parentDeviceName, endpointId: parentDeviceName,
          ...(payloadDeviceUuid && { deviceUuid: payloadDeviceUuid }),
          deviceName: readingDeviceName, fieldName,
        },
      });
    }
  }

  // Walk a payload recursively; routes each numeric field to the anomaly service.
  // Fast-paths (in order): bare number → OPC-UA object → Modbus array → generic walk.
  private extractNumericFields(data: any, deviceName: string, timestampMs: number, prefix = '', depth = 0): void {
    if (!this.getService()) return;
    if (depth > 3) return;

    if (typeof data === 'object' && data !== null) { // circular-reference guard
      if (this.batchVisited.has(data)) return;
      this.batchVisited.add(data);
    }

    if (typeof data === 'number') {
      this.dispatchDirectNumeric(data, deviceName, timestampMs, prefix);
      return;
    }

    if (typeof data !== 'object' || data === null) return;

    if (!Array.isArray(data) && data.deviceName && (data.metric || data.name) && data.value !== undefined) {
      this.dispatchReadingObject(data, deviceName, timestampMs);
      return;
    }

    if (Array.isArray(data) && prefix === 'readings') {
      this.dispatchReadingsArray(data, deviceName, timestampMs);
      return;
    }

    const rawState = extractRawDeviceState(data);
    const payloadDeviceUuid: string | undefined =
      (typeof data.device_uuid === 'string' && data.device_uuid) ||
      (typeof data.deviceUuid === 'string' && data.deviceUuid) ||
      undefined;
    const resolvedDeviceId = this.resolveDeviceId(
      typeof data.deviceId === 'string' ? data.deviceId : undefined,
      typeof data.device_id === 'string' ? data.device_id : undefined,
    );
    const effectiveDeviceId = resolvedDeviceId || `endpoint:${deviceName}`;

    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'number') {
        const metricName = prefix ? `${prefix}_${key}` : key;
        const metricKey = this.buildMetricKey(payloadDeviceUuid, deviceName, metricName);

        if (!resolvedDeviceId) {
          this.logger?.warn('[ANOMALY] No explicit deviceId in payload; using fallback identity', {
            device: deviceName, protocol: this.protocol,
            metricKey, field: metricName, fallbackDeviceId: effectiveDeviceId,
            reason: 'nested_numeric_missing_device_id',
          });
        }

        this.dispatchToAnomaly(metricKey, {
          source: 'sensor', protocol: this.protocol as any, rawDeviceState: rawState,
          value, unit: '', timestamp: timestampMs, quality: 'GOOD',
          deviceId: effectiveDeviceId,
          tags: {
            sensorName: deviceName, endpointId: deviceName,
            ...(payloadDeviceUuid && { deviceUuid: payloadDeviceUuid }),
            field: metricName,
          },
        });
      } else if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
        this.extractNumericFields(value, deviceName, timestampMs, key, depth + 1);
      }
    }
  }
}
