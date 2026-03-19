import type { AnomalyDetectionService } from '../../../anomaly/index.js';
import type { Protocol } from '../../../anomaly/types.js';
import type { Prediction } from '../../../anomaly/forecaster.js';
import { extractRawDeviceState, normalizeDeviceState } from '../../../anomaly/device-state.js';

type Reading = {
  [key: string]: any;
  deviceName?: string;
  metric?: string;
  registerName?: string;
  name?: string;
  value?: unknown;
  device_uuid?: string;
  deviceUuid?: string;
  deviceState?: unknown;
  state?: unknown;
  status?: unknown;
  readings?: Reading[];
  device_state?: unknown;
  raw_device_state?: unknown;
  anomaly_score?: number;
  anomaly_threshold?: number;
  baseline_samples?: number;
  detection_methods?: string[];
  predicted_next?: number;
  trend?: string;
  trend_strength?: number;
  forecast_confidence?: number;
  time_to_threshold?: {
    threshold: number;
    estimated_seconds: number;
    confidence: number;
  };
};

/**
 * Enriches pre-parsed messages with anomaly scores, thresholds, and forecasts
 * from the edge anomaly service.  Supports both OPC-UA (direct object) and
 * Modbus ({readings: [...]}) formats.
 */
export class AnomalyEnricher {
  constructor(
    private readonly getService: () => AnomalyDetectionService | undefined,
    private readonly deviceUuid: string,
    private readonly protocol: Protocol | undefined,
  ) {}

  enrich(messages: unknown[], deviceName: string): unknown[] {
    const service = this.getService();
    if (!service) return messages;

    const predictions = service.getPredictions();

    for (const data of messages) {
      const d = data as Reading;

      // Modbus format: { readings: [...] }
      if (d.readings && Array.isArray(d.readings)) {
        for (const reading of d.readings) {
          if (typeof reading !== 'object' || reading === null) continue;
          const readingDeviceName: string = reading.deviceName || deviceName;
          const fieldName: string | undefined = reading.metric || reading.registerName || reading.name;
          if (!fieldName) continue;

          this.applyDeviceState(reading, reading);
          this.attachScores(service, predictions, reading, readingDeviceName, fieldName);
        }
      }
      // OPC-UA format: direct reading object
      else if (d.deviceName && (d.metric || d.registerName || d.name) && d.value !== undefined) {
        const readingDeviceName: string = d.deviceName;
        const fieldName: string | undefined = d.metric || d.registerName || d.name;
        if (!fieldName) continue;

        this.applyDeviceState(d, d);
        this.attachScores(service, predictions, d, readingDeviceName, fieldName);
      }
    }

    return messages;
  }

  private applyDeviceState(target: Reading, source: Reading): void {
    const raw = extractRawDeviceState(source);

    if (raw === undefined) return;

    if (target.device_state === undefined) {
      target.device_state = normalizeDeviceState(this.protocol, raw);
    }
    if (target.raw_device_state === undefined) {
      target.raw_device_state = raw;
    }
  }

  private buildMetricKey(
    deviceIdentifier: string | undefined,
    deviceName: string,
    fieldName: string,
  ): string {
    const identifier =
      typeof deviceIdentifier === 'string' && deviceIdentifier.trim()
        ? deviceIdentifier.trim()
        : deviceName || 'unknown';

    return `${this.deviceUuid}_${identifier}_${fieldName}`;
  }

  private attachScores(
    service: AnomalyDetectionService,
    predictions: Record<string, Prediction> | undefined,
    target: Reading,
    deviceIdentifierName: string,
    fieldName: string,
  ): void {
    const metricName = this.buildMetricKey(
      target.device_uuid || target.deviceUuid || deviceIdentifierName,
      deviceIdentifierName,
      fieldName,
    );
    const score = service.getAnomalyScore(metricName);
    if (score === undefined) return;

    target.anomaly_score = score;

    const metadata = service.getAnomalyMetadata(metricName);
    if (metadata) {
      target.anomaly_threshold = metadata.threshold;
      target.baseline_samples = metadata.samples;
      target.detection_methods = metadata.methods;
    }

    const p = predictions?.[metricName];
    if (p) {
      target.predicted_next = p.predicted_next;
      target.trend = p.trend;
      target.trend_strength = p.trend_strength;
      target.forecast_confidence = p.confidence;
      if (p.time_to_threshold) target.time_to_threshold = p.time_to_threshold;
    }
  }
}
