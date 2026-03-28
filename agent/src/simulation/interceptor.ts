import type { AnomalyDetectionService } from '../anomaly/index.js';
import type { AnomalyBaselineRecord } from '../anomaly/storage.js';
import { LogComponents } from '../logging/types.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import type { AnomalySimulationConfig } from './types.js';

type InterceptContext = {
  endpointName: string;
};

export class BaselineLiveInterceptor {
  private readonly metricSet: Set<string>;
  // Maps short field name → full metric key for UUID-prefixed configured metrics.
  // Allows matching message fields like "temperature" against keys like "uuid1_uuid2_temperature".
  private readonly fieldNameToFullKey: Map<string, string>;
  private readonly cache = new Map<string, { at: number; baseline: AnomalyBaselineRecord | null }>();
  private readonly loggedTransformPath = new Set<string>();
  private readonly loggedStrictMiss = new Set<string>();
  private loggedNonBaselineSource = false;
  private loggedMissingStorage = false;
  private loggedMissingBaselineDeviceId = false;
  private readonly loggedDerivedBaselineDeviceId = new Set<string>();
  private cyclePhase = 0;

  // Canonical 3-part metric key: {agentUuid}_{deviceUuid}_{fieldName}
  private static readonly UUID_METRIC_RE =
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}_(.+)$/i;

  // Canonical 3-part metric key capture: {agentUuid}_{deviceUuid}_{fieldName}
  private static readonly UUID_METRIC_WITH_DEVICE_RE =
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}_([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})_(.+)$/i;

  constructor(
    private readonly config: AnomalySimulationConfig,
    private readonly anomalyService?: AnomalyDetectionService,
    private readonly logger?: AgentLogger,
  ) {
    this.metricSet = new Set((config.metrics || []).map((m) => m.toLowerCase()));

    this.fieldNameToFullKey = new Map();
    for (const m of (config.metrics || [])) {
      const match = BaselineLiveInterceptor.UUID_METRIC_RE.exec(m);
      if (match) {
        const fieldName = match[1].toLowerCase();
        if (fieldName && !this.fieldNameToFullKey.has(fieldName)) {
          this.fieldNameToFullKey.set(fieldName, m.toLowerCase());
        }
      }
    }

    this.logger?.infoSync('Initialized live data interceptor metric mapping', {
      component: LogComponents.metrics,
      configuredMetricCount: this.metricSet.size,
      shortNameMappingCount: this.fieldNameToFullKey.size,
      sampleMappings: Array.from(this.fieldNameToFullKey.entries()).slice(0, 5),
    });
  }

  async apply(messages: any[], context: InterceptContext): Promise<any[]> {
    if (!Array.isArray(messages) || messages.length === 0) {
      return messages;
    }

    const transformed = await Promise.all(messages.map((message) => this.transformMessage(message, context)));

    this.logger?.infoSync('Live data baseline interception applied', {
      component: LogComponents.metrics,
      endpointName: context.endpointName,
      messageCount: transformed.length,
      pattern: this.config.pattern,
      valueSource: this.config.valueSource || 'static',
      metrics: Array.from(this.metricSet),
    });

    return transformed;
  }

  private async transformMessage(message: any, context: InterceptContext): Promise<any> {
    if (!message || typeof message !== 'object') {
      return message;
    }

    const copy = Array.isArray(message) ? [...message] : { ...message };

    // Protocol-style payloads with explicit metric field names.
    const explicitMetric = this.resolveExplicitMetric(copy);
    if (explicitMetric && typeof copy.value === 'number') {
      copy.value = await this.transformMetricValue(explicitMetric, copy.value, context.endpointName);
    }

    // CAN payloads: signals map with metric names as keys.
    if (copy.signals && typeof copy.signals === 'object' && !Array.isArray(copy.signals)) {
      const nextSignals: Record<string, any> = { ...copy.signals };
      for (const [key, value] of Object.entries(nextSignals)) {
        if (typeof value !== 'number') continue;
        nextSignals[key] = await this.transformMetricValue(key, value, context.endpointName);
      }
      copy.signals = nextSignals;
    }

    // Generic object payloads: apply only for configured metric keys.
    for (const [key, value] of Object.entries(copy)) {
      if (key === 'value' || key === 'signals') {
        continue;
      }
      if (typeof value !== 'number') {
        continue;
      }
      if (!this.isMetricConfigured(key)) {
        continue;
      }
      copy[key] = await this.transformMetricValue(key, value, context.endpointName);
    }

    return copy;
  }

  private resolveExplicitMetric(message: Record<string, any>): string | null {
    const candidates = [message.metric, message.register, message.nodeId, message.oid];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    return null;
  }

  /** Returns true if the key matches a configured metric (full key or extracted short field name). */
  private isMetricConfigured(key: string): boolean {
    const lower = key.toLowerCase();
    return this.metricSet.has(lower) || this.fieldNameToFullKey.has(lower);
  }

  /** Resolves a short field name to the full canonical metric key, or returns the key unchanged. */
  private resolveBaselineKey(metric: string): string {
    const lower = metric.toLowerCase();
    return this.fieldNameToFullKey.get(lower) ?? lower;
  }

  /** Deterministically derives device UUID from canonical metric key. */
  private deriveDeviceIdFromMetric(metric: string): string | undefined {
    const match = BaselineLiveInterceptor.UUID_METRIC_WITH_DEVICE_RE.exec(metric);
    if (!match) {
      return undefined;
    }
    return match[1].toLowerCase();
  }

  private async transformMetricValue(metric: string, currentValue: number, endpointName: string): Promise<number> {
    if (!this.isMetricConfigured(metric)) {
      return currentValue;
    }

    const baselineKey = this.resolveBaselineKey(metric);
    const transformPathKey = `${endpointName}:${baselineKey}`;
    if (!this.loggedTransformPath.has(transformPathKey)) {
      this.loggedTransformPath.add(transformPathKey);
      this.logger?.infoSync('Interceptor transform path active', {
        component: LogComponents.metrics,
        endpointName,
        incomingMetric: metric,
        baselineMetric: baselineKey,
        valueSource: this.config.valueSource || 'static',
        strictBaseline: this.config.strictBaseline ?? false,
      });
    }

    this.logger?.debugSync('Interceptor metric accepted for transformation', {
      component: LogComponents.metrics,
      endpointName,
      incomingMetric: metric,
      baselineMetric: baselineKey,
      valueSource: this.config.valueSource || 'static',
      strictBaseline: this.config.strictBaseline ?? false,
    });

    const baseline = await this.getBaseline(baselineKey, endpointName);
    if (!baseline) {
      if (this.config.strictBaseline) {
        const strictMissKey = `${endpointName}:${baselineKey}`;
        if (!this.loggedStrictMiss.has(strictMissKey)) {
          this.loggedStrictMiss.add(strictMissKey);
          this.logger?.warnSync('Interceptor strict-baseline miss; value left unchanged', {
            component: LogComponents.metrics,
            endpointName,
            incomingMetric: metric,
            baselineMetric: baselineKey,
            original: currentValue,
            hint: 'Check baseline metric/deviceId/deviceState or set baselineDeviceId explicitly',
          });
        }

        this.logger?.debugSync('Interceptor skipped metric transform due to missing baseline in strict mode', {
          component: LogComponents.metrics,
          endpointName,
          incomingMetric: metric,
          baselineMetric: baselineKey,
          original: currentValue,
        });
        return currentValue;
      }

      this.logger?.debugSync('Interceptor applying pattern without baseline (non-strict mode)', {
        component: LogComponents.metrics,
        endpointName,
        incomingMetric: metric,
        baselineMetric: baselineKey,
        original: currentValue,
        pattern: this.config.pattern,
      });
      return this.applyPattern(metric, currentValue, undefined);
    }

    const center = this.getBaselineCenter(baseline, currentValue);
    const spread = this.getBaselineSpread(center, baseline);

    // Keep this an interception (not synthetic replacement): blend from current toward target.
    const target = this.applyPattern(metric, center, baseline);
    // alert pattern is intentionally aggressive to cross anomaly thresholds quickly.
    const blendWeight = this.config.pattern === 'alert' ? 1.0 : 0.4;
    const blended = currentValue + ((target - currentValue) * blendWeight);

    const bounded = this.applyBounds(blended, baseline);

    this.logger?.debugSync('Live data baseline interception applied', {
      component: LogComponents.metrics,
      metric,
      endpointName,
      original: currentValue,
      transformed: bounded,
      center,
      spread,
      pattern: this.config.pattern,
      mode: this.config.mode || 'inject',
    });

    return bounded;
  }

  private applyPattern(metric: string, base: number, baseline?: AnomalyBaselineRecord): number {
    const magnitude = this.config.magnitude || 3;
    const spread = this.getBaselineSpread(base, baseline);

    switch (this.config.pattern) {
      case 'spike':
        return base + (spread * magnitude * 1.8);
      case 'drift':
        return base + (spread * magnitude * 0.5);
      case 'alert':
        return base + (spread * Math.max(magnitude, 3) * 7.0);
      case 'cyclic':
        this.cyclePhase += 0.15;
        return base + (Math.sin(this.cyclePhase) * spread * magnitude * 1.2);
      case 'noisy':
        return base + (((Math.random() - 0.5) * 2) * spread * magnitude * 0.8);
      case 'extreme':
        return metric === 'cpu_temp' ? 95 :
          metric === 'cpu_usage' ? 98 :
          metric === 'memory_percent' ? 99 :
          base + (spread * magnitude * 3.2);
      case 'random':
        return base + (((Math.random() - 0.5) * 2) * spread * magnitude);
      case 'realistic':
      default:
        return base + (spread * magnitude * 0.6);
    }
  }

  private applyBounds(value: number, baseline?: AnomalyBaselineRecord): number {
    if (this.config.pattern === 'alert') {
      // Intentionally bypass baseline clamps so alert mode can exceed normal ranges.
      return value;
    }

    if (!baseline) {
      return value;
    }

    if (typeof baseline.min === 'number' && typeof baseline.max === 'number' && baseline.max >= baseline.min) {
      return Math.max(baseline.min, Math.min(baseline.max, value));
    }

    return value;
  }

  private async getBaseline(metric: string, endpointName: string): Promise<AnomalyBaselineRecord | null> {
    if (this.config.valueSource !== 'baseline') {
      if (!this.loggedNonBaselineSource) {
        this.loggedNonBaselineSource = true;
        this.logger?.warnSync('Live interceptor baseline lookup disabled by valueSource', {
          component: LogComponents.metrics,
          endpointName,
          valueSource: this.config.valueSource || 'static',
        });
      }
      return null;
    }

    const storage = this.anomalyService?.getStorage?.();
    if (!storage) {
      if (!this.loggedMissingStorage) {
        this.loggedMissingStorage = true;
        this.logger?.warnSync('Live interceptor anomaly storage unavailable; baseline lookup skipped', {
          component: LogComponents.metrics,
          endpointName,
        });
      }
      return null;
    }

    const now = Date.now();
    const cached = this.cache.get(metric);
    if (cached && (now - cached.at) < 30000) {
      this.logger?.infoSync('Baseline cache hit for live data interception', {
        component: LogComponents.metrics,
        endpointName,
        metric,
        cacheAgeMs: now - cached.at,
        found: !!cached.baseline,
      });
      return cached.baseline;
    }

    const minimumSamples = this.config.baselineMinSamples ?? 10;
    const deviceState = this.config.baselineDeviceState || 'unknown';
    const configuredDeviceId = this.config.baselineDeviceId?.trim().toLowerCase();
    const derivedDeviceId = this.deriveDeviceIdFromMetric(metric);
    const baselineDeviceId = configuredDeviceId || derivedDeviceId;

    if (!configuredDeviceId && derivedDeviceId) {
      const derivedKey = `${endpointName}:${metric}`;
      if (!this.loggedDerivedBaselineDeviceId.has(derivedKey)) {
        this.loggedDerivedBaselineDeviceId.add(derivedKey);
        this.logger?.infoSync('Derived baselineDeviceId from metric key', {
          component: LogComponents.metrics,
          endpointName,
          metric,
          baselineDeviceId: derivedDeviceId,
        });
      }
    }

    if (!baselineDeviceId) {
      if (!this.loggedMissingBaselineDeviceId) {
        this.loggedMissingBaselineDeviceId = true;
        this.logger?.warnSync('Live interceptor baselineDeviceId is required in baseline mode', {
          component: LogComponents.metrics,
          endpointName,
          metric,
          hint: 'Set anomaly_injection.baselineDeviceId or use canonical metric key format to derive device id',
        });
      }
      return null;
    }

    this.logger?.infoSync('Baseline lookup for live data interception', {
      component: LogComponents.metrics,
      endpointName,
      metric,
      deviceState,
      minimumSamples,
      deviceId: baselineDeviceId,
    });

    try {
      const baseline = await storage.getLatestBaseline(metric, -1, minimumSamples, null, deviceState, baselineDeviceId);
      if (baseline) {
        this.cache.set(metric, { at: now, baseline });

        this.logger?.infoSync('Baseline lookup result for live data interception', {
          component: LogComponents.metrics,
          endpointName,
          metric,
          deviceId: baselineDeviceId,
          deviceState,
          found: true,
          sampleCount: baseline.sample_count,
          mean: baseline.mean,
          stdDev: baseline.std_dev,
        });

        return baseline;
      }

      this.cache.set(metric, { at: now, baseline: null });
      this.logger?.infoSync('Baseline lookup result for live data interception', {
        component: LogComponents.metrics,
        endpointName,
        metric,
        deviceState,
        found: false,
        deviceId: baselineDeviceId,
      });
      return null;
    } catch (error) {
      this.logger?.warnSync('Failed to load baseline for live data interception', {
        component: LogComponents.metrics,
        metric,
        deviceId: baselineDeviceId,
        deviceState,
        error: error instanceof Error ? error.message : String(error),
      });
      this.cache.set(metric, { at: now, baseline: null });
      return null;
    }
  }

  private getBaselineCenter(baseline: AnomalyBaselineRecord, fallbackBase: number): number {
    if (typeof baseline.median === 'number') return baseline.median;
    if (typeof baseline.mean === 'number') return baseline.mean;
    if (typeof baseline.q1 === 'number' && typeof baseline.q3 === 'number') {
      return (baseline.q1 + baseline.q3) / 2;
    }
    if (typeof baseline.min === 'number' && typeof baseline.max === 'number') {
      return (baseline.min + baseline.max) / 2;
    }
    return fallbackBase;
  }

  private getBaselineSpread(base: number, baseline?: AnomalyBaselineRecord): number {
    if (!baseline) {
      return Math.max(Math.abs(base) * 0.1, 0.1);
    }

    if (typeof baseline.std_dev === 'number' && baseline.std_dev > 0) {
      return Math.max(baseline.std_dev, 0.1);
    }
    if (typeof baseline.iqr === 'number' && baseline.iqr > 0) {
      return Math.max(baseline.iqr / 1.35, 0.1);
    }
    if (typeof baseline.max === 'number' && typeof baseline.min === 'number' && baseline.max > baseline.min) {
      return Math.max((baseline.max - baseline.min) / 6, 0.1);
    }

    return Math.max(Math.abs(base) * 0.1, 0.1);
  }
}
