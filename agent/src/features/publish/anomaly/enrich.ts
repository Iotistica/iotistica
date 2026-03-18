import type { AnomalyDetectionService } from '../../../anomaly/index.js';
import { extractRawDeviceState, normalizeDeviceState } from '../../../anomaly/device-state.js';
import type { Logger } from '../types.js';

/**
 * Enriches pre-parsed messages with anomaly scores, thresholds, and forecasts
 * from the edge anomaly service.  Supports both OPC-UA (direct object) and
 * Modbus ({readings: [...]}) formats.
 */
export class AnomalyEnricher {
  constructor(
    private readonly getService: () => AnomalyDetectionService | undefined,
    private readonly deviceUuid: string,
    private readonly protocol: string | undefined,
    private readonly logger?: Logger,
  ) {}

  enrich(messages: unknown[], deviceName: string): unknown[] {
    const service = this.getService();
    if (!service) return messages;

    const predictions = service.getPredictions() || {};
    const enriched: unknown[] = [];

    for (const data of messages) {
      const d = data as any;

      // Modbus format: { readings: [...] }
      if (d.readings && Array.isArray(d.readings)) {
        for (const reading of d.readings) {
          if (typeof reading !== 'object' || reading === null) continue;
          const readingDeviceName: string = reading.deviceName || deviceName;
          const fieldName: string | undefined = reading.metric || reading.registerName;
          const rawState = reading.deviceState ?? reading.state ?? reading.status ?? extractRawDeviceState(d);
          reading.device_state = normalizeDeviceState(this.protocol as any, rawState);
          if (rawState !== undefined) reading.raw_device_state = rawState;

          if (fieldName) {
            this.attachScores(service, predictions, reading, readingDeviceName, fieldName);
          }
        }
      }
      // OPC-UA format: direct reading object
      else if (d.deviceName && (d.registerName || d.metric) && d.value !== undefined) {
        const readingDeviceName: string = d.deviceName;
        const fieldName: string = d.registerName || d.metric;
        const rawState = d.deviceState ?? d.state ?? d.status ?? extractRawDeviceState(d);
        d.device_state = normalizeDeviceState(this.protocol as any, rawState);
        if (rawState !== undefined) d.raw_device_state = rawState;
        this.attachScores(service, predictions, d, readingDeviceName, fieldName);
      }

      enriched.push(data);
    }

    return enriched;
  }

  private attachScores(
    service: AnomalyDetectionService,
    predictions: Record<string, any>,
    target: any,
    deviceName: string,
    fieldName: string,
  ): void {
    const metricName = `${this.deviceUuid}_${deviceName}_${fieldName}`;
    const score = service.getAnomalyScore(metricName);
    if (score === undefined) return;

    target.anomaly_score = score;

    const metadata = service.getAnomalyMetadata(metricName);
    if (metadata) {
      target.anomaly_threshold = metadata.threshold;
      target.baseline_samples = metadata.samples;
      target.detection_methods = metadata.methods;
    }

    const p = predictions[metricName];
    if (p) {
      target.predicted_next = p.predicted_next;
      target.trend = p.trend;
      target.trend_strength = p.trend_strength;
      target.forecast_confidence = p.confidence;
      if (p.time_to_threshold) target.time_to_threshold = p.time_to_threshold;
    }
  }
}
