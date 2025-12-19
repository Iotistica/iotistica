# Hard vs Soft Detectors - Safety-Critical Anomaly Detection

**Status**: ✅ Implemented  
**Author**: AI Assistant  
**Date**: 2025-12-18

## Overview

Anomaly detectors fall into two categories: **HARD** (physical/safety constraints) and **SOFT** (statistical/ML methods). This distinction is **critical for safety systems** - hard detectors cannot be "outvoted" by statistical confidence.

## The Problem: Safety Issues Being Outvoted

### ❌ Bad: Soft Detectors Outvote Hard Detector
```typescript
// Temperature: 105°C (exceeds physical limit of 100°C)

ExpectedRange: isAnomaly=true,  confidence=1.0, weight=1.5
ZScore:        isAnomaly=false, confidence=0.2, weight=0.8
MAD:           isAnomaly=false, confidence=0.1, weight=1.0
IQR:           isAnomaly=false, confidence=0.0, weight=0.8
EWMA:          isAnomaly=false, confidence=0.3, weight=0.6

// Bad fusion logic (pure voting):
fusionScore = (1.0×1.5 + 0×0.8 + 0×1.0 + 0×0.8 + 0×0.6) / (1.5+0.8+1.0+0.8+0.6)
            = 1.5 / 4.7 = 0.32 < threshold 0.6
isAnomaly = false  ❌ SAFETY VIOLATION IGNORED!
```

### ✅ Good: Hard Detector Always Wins
```typescript
// Same scenario with hard detector override:

if (HARD_DETECTORS.has('expected_range') && expectedRange.isAnomaly) {
  isAnomaly = true;              // ✅ Cannot be outvoted
  suggestedSeverity = 'critical'; // ✅ High severity
  message = "⚠️ HARD LIMIT VIOLATED by: expected_range";
}
```

## Hard vs Soft Detectors

### HARD DETECTORS (Physical/Safety Constraints)

**Definition**: Detectors that represent **physical laws** or **safety limits** that cannot be violated.

| Detector | Example Constraint | Why It's Hard |
|----------|-------------------|---------------|
| **ExpectedRange** | Temperature: 0-100°C | Physical damage threshold |
| | Pressure: 0-150 PSI | Safety valve rating |
| | Voltage: 110-120V | Electrical specification |
| **RateChange** | CPU: >50% spike | Likely hardware failure |
| | Memory: >30% drop | Memory leak/corruption |
| | Network: >80% loss | Link failure |

**Characteristics**:
- ✅ **Binary decision**: Limit violated or not (no gray area)
- ✅ **Always alerts**: Cannot be suppressed by statistics
- ✅ **High severity**: Suggests `critical` or `warning`
- ✅ **No false positives**: Physical limits are absolute

**Code Pattern**:
```typescript
export const HARD_DETECTORS = new Set(['expected_range', 'rate_change']);

if (HARD_DETECTORS.has(detector.method) && detector.isAnomaly) {
  return {
    isAnomaly: true,
    suggestedSeverity: 'critical',
    message: '⚠️ HARD LIMIT VIOLATED'
  };
}
```

### SOFT DETECTORS (Statistical/ML Methods)

**Definition**: Detectors that use **statistical analysis** or **machine learning** to identify patterns.

| Detector | Method | Why It's Soft |
|----------|--------|---------------|
| **ZScore** | Standard deviations from mean | Sensitive to outliers |
| **MAD** | Median absolute deviation | Robust but probabilistic |
| **IQR** | Interquartile range | Distribution-dependent |
| **EWMA** | Exponential moving average | Trend-following (lagging) |

**Characteristics**:
- ⚠️ **Probabilistic**: Based on historical patterns
- ⚠️ **Confidence-based**: Can be wrong (false positives)
- ⚠️ **Lower severity**: Suggests `warning` or `info`
- ⚠️ **Requires tuning**: Thresholds depend on data

**Code Pattern**:
```typescript
export const SOFT_DETECTORS = new Set(['zscore', 'mad', 'iqr', 'ewma']);

// Soft detectors participate in fusion voting
fusionScore = Σ(confidence × weight) / Σ(weights);

if (fusionScore > threshold) {
  return {
    isAnomaly: true,
    suggestedSeverity: 'warning',
    message: 'Statistical anomaly detected'
  };
}
```

## Fusion Logic with Hard/Soft Distinction

### Algorithm
```typescript
// Step 1: Run all detectors
const results = detectors.map(d => d.detect(value, buffer, config));

// Step 2: Separate hard vs soft triggers
const hardTriggered = results.filter(r => 
  HARD_DETECTORS.has(r.method) && r.isAnomaly
);
const softTriggered = results.filter(r => 
  SOFT_DETECTORS.has(r.method) && r.isAnomaly
);

// Step 3: Hard detectors override everything
if (hardTriggered.length > 0) {
  return {
    isAnomaly: true,
    suggestedSeverity: fusionScore > 0.8 ? 'critical' : 'warning',
    isHardDetectorTriggered: true,
    message: `⚠️ HARD LIMIT VIOLATED by: ${hardTriggered.map(d => d.method).join(', ')}`
  };
}

// Step 4: Soft detectors use fusion voting
const fusionScore = Σ(confidence × weight) / Σ(weights);
if (fusionScore > threshold) {
  return {
    isAnomaly: true,
    suggestedSeverity: fusionScore > 0.7 ? 'warning' : 'info',
    isHardDetectorTriggered: false,
    message: `Statistical anomaly: ${softTriggered.map(d => d.method).join(', ')}`
  };
}
```

## Severity Mapping

### Hard Detector Severity
```typescript
if (isHardDetectorTriggered) {
  if (fusionScore > 0.8) {
    severity = 'critical';  // Extreme violation
  } else {
    severity = 'warning';   // Moderate violation
  }
}
```

### Soft Detector Severity
```typescript
if (softDetectorsTriggered.length > 0) {
  if (fusionScore > 0.7) {
    severity = 'warning';   // High confidence anomaly
  } else {
    severity = 'info';      // Low confidence anomaly
  }
}
```

### Severity Decision Table

| Trigger Type | Fusion Score | Severity | Example |
|--------------|--------------|----------|---------|
| Hard | > 0.8 | `critical` | Temp 110°C (limit: 100°C) |
| Hard | 0.6-0.8 | `warning` | Temp 102°C (slight violation) |
| Soft | > 0.7 | `warning` | 3 σ from mean (high confidence) |
| Soft | 0.6-0.7 | `info` | 2 σ from mean (moderate) |
| None | < 0.6 | - | Normal operation |

## Real-World Examples

### Example 1: Temperature Exceeds Physical Limit (Hard Detector)
```typescript
// Scenario: CPU temperature 105°C (limit: 100°C)

const result = detectWithFusion(105, buffer, config);

// Result:
{
  isAnomaly: true,
  isHardDetectorTriggered: true,
  suggestedSeverity: 'critical',
  fusionScore: 0.95,
  triggeredBy: ['expected_range', 'zscore', 'mad'],
  message: '⚠️ HARD LIMIT VIOLATED by: expected_range (severity: critical) | Also detected by soft methods: zscore, mad'
}

// ✅ Hard detector (expected_range) triggered
// ✅ Severity set to critical
// ✅ Soft detectors (zscore, mad) also confirm
// ✅ Alert fires immediately (cannot be suppressed)
```

### Example 2: Statistical Outlier Only (Soft Detector)
```typescript
// Scenario: CPU temperature 28°C (limit: 100°C, mean: 22°C, σ: 2°C)

const result = detectWithFusion(28, buffer, config);

// Result:
{
  isAnomaly: true,
  isHardDetectorTriggered: false,
  suggestedSeverity: 'info',
  fusionScore: 0.65,
  triggeredBy: ['zscore', 'mad'],
  message: 'Statistical anomaly detected: fusion score 0.65 > 0.6 (2/6 detectors) | Triggered by: zscore, mad'
}

// ✅ Soft detectors triggered (zscore, mad)
// ✅ Severity set to info (not critical)
// ✅ Can be suppressed by temporal confirmation if desired
```

### Example 3: Hard Detector Prevents Outvoting
```typescript
// Scenario: Pressure 160 PSI (limit: 150 PSI)
// Statistical detectors say "normal" (noise in historical data)

const result = detectWithFusion(160, buffer, config);

// Without hard detector logic:
{
  isAnomaly: false,  // ❌ Outvoted by soft detectors
  fusionScore: 0.35  // Low fusion score
}

// With hard detector logic:
{
  isAnomaly: true,   // ✅ Hard detector wins
  isHardDetectorTriggered: true,
  suggestedSeverity: 'critical',
  message: '⚠️ HARD LIMIT VIOLATED by: expected_range'
}
```

## Configuration

### Metric-Level Hard/Soft Configuration
```typescript
const metricConfig: MetricConfig = {
  name: 'temperature',
  enabled: true,
  methods: ['fusion'],
  threshold: 3.0,
  windowSize: 100,
  
  // CRITICAL: Define expected range (hard limit)
  expectedRange: [0, 100],  // Physical constraint
  
  fusion: {
    threshold: 0.6,
    enableOverrides: true,  // Allow hard detectors to override (default: true)
    weights: {
      'expected_range': 1.5,  // Hard detector
      'rate_change': 1.2,     // Hard detector
      'mad': 1.0,             // Soft detector
      'zscore': 0.8,          // Soft detector
    }
  }
};
```

### Disabling Hard Detector Override (NOT RECOMMENDED)
```typescript
// WARNING: Only disable for non-safety-critical metrics
const fusionConfig = {
  enableOverrides: false,  // ❌ Hard detectors can be outvoted
};

// Use case: Development/testing environments only
```

## API Reference

### Constants

**HARD_DETECTORS**
```typescript
export const HARD_DETECTORS = new Set(['expected_range', 'rate_change']);
```
Detectors that represent physical/safety constraints.

**SOFT_DETECTORS**
```typescript
export const SOFT_DETECTORS = new Set(['zscore', 'mad', 'iqr', 'ewma']);
```
Detectors that use statistical/ML methods.

### FusionResult Interface

```typescript
interface FusionResult {
  method: 'fusion';
  isAnomaly: boolean;
  fusionScore: number;
  contributingDetectors: WeightedDetectorResult[];
  triggeredBy?: string[];
  
  // Hard vs Soft distinction
  suggestedSeverity?: 'critical' | 'warning' | 'info';
  isHardDetectorTriggered?: boolean;  // True if hard detector triggered
  
  message: string;
}
```

## Safety Guidelines

### ✅ DO: Always Use Hard Detectors for Safety-Critical Metrics

```typescript
// Temperature monitoring
const config: MetricConfig = {
  name: 'temperature',
  expectedRange: [0, 100],  // ✅ Hard limit
  methods: ['fusion'],
  fusion: {
    enableOverrides: true,   // ✅ Allow hard detectors to win
  }
};
```

### ❌ DON'T: Disable Hard Detector Override for Safety Metrics

```typescript
// Pressure monitoring
const config: MetricConfig = {
  name: 'pressure',
  expectedRange: [0, 150],
  methods: ['fusion'],
  fusion: {
    enableOverrides: false,  // ❌ DANGEROUS for safety metrics
  }
};
```

### ✅ DO: Set Appropriate Expected Ranges

```typescript
// Physical constraints based on specifications
const configs = {
  temperature: { expectedRange: [0, 100] },      // °C (component rating)
  pressure: { expectedRange: [0, 150] },         // PSI (safety valve)
  voltage: { expectedRange: [110, 120] },        // V (electrical spec)
  rpm: { expectedRange: [0, 5000] },             // Motor rating
};
```

### ✅ DO: Use Severity in Alert Routing

```typescript
const result = detectWithFusion(value, buffer, config);

if (result.isAnomaly) {
  if (result.suggestedSeverity === 'critical') {
    // Immediate notification (SMS, PagerDuty, etc.)
    await sendCriticalAlert(result);
  } else if (result.suggestedSeverity === 'warning') {
    // Standard notification (email, Slack, etc.)
    await sendWarningAlert(result);
  } else {
    // Log only (dashboard, metrics, etc.)
    await logInfo(result);
  }
}
```

## Testing

### Test Hard Detector Override
```typescript
test('hard detector (expected_range) cannot be outvoted', () => {
  const buffer = createBuffer(100);
  
  // Build normal baseline (mean=50)
  for (let i = 0; i < 50; i++) {
    addToBuffer(buffer, 50);
  }
  
  const config: MetricConfig = {
    name: 'temperature',
    methods: ['fusion'],
    threshold: 3.0,
    windowSize: 100,
    expectedRange: [0, 100],
  };
  
  // Value outside expectedRange
  const result = detectWithFusion(150, buffer, config, undefined, {
    threshold: 0.99, // Very high threshold (would block soft detectors)
    minimumAgreement: 10, // Require 10 detectors (impossible)
  });
  
  expect(result.isAnomaly).toBe(true); // ✅ Hard detector wins
  expect(result.isHardDetectorTriggered).toBe(true);
  expect(result.suggestedSeverity).toBe('critical');
});
```

## Migration Guide

### Existing Deployments

1. **Review metric configurations** - Ensure all safety-critical metrics have `expectedRange` defined
2. **Enable fusion** - Add `methods: ['fusion']` to metric configs
3. **Set expected ranges** - Define physical/safety limits for hard detectors
4. **Test severity mapping** - Verify critical alerts route correctly
5. **Monitor hard detector triggers** - Track when physical limits are violated

### Backward Compatibility

- ✅ `OVERRIDE_DETECTORS` still works (alias for `HARD_DETECTORS`)
- ✅ Existing fusion logic unchanged (just enhanced with severity)
- ✅ Opt-in via `fusion.enableOverrides` (default: true)

## References

### Industry Standards
- **IEC 61508**: Functional safety of electrical/electronic systems
- **ISO 26262**: Automotive safety standard
- **NFPA 70**: National Electrical Code (voltage limits)

### Related Docs
- [ANOMALY-DETECTOR-FUSION.md](./ANOMALY-DETECTOR-FUSION.md) - Ensemble detection
- [ANOMALY-TEMPORAL-CONFIRMATION.md](./ANOMALY-TEMPORAL-CONFIRMATION.md) - N-of-M pattern
- [detectors.ts](../src/ai/anomaly/detectors.ts) - Individual detector implementations

---

**Summary**: Hard detectors (physical/safety constraints) **cannot be outvoted** by soft detectors (statistical methods). This prevents safety issues from being suppressed by statistical confidence. Always use hard detectors for safety-critical metrics with properly defined expected ranges.
