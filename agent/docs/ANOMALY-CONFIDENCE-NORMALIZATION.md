# Anomaly Detection - Confidence Normalization

## Overview

Confidence normalization ensures all anomaly detectors produce **comparable, probabilistic confidence scores in the range [0, 1]**. This is critical for detector fusion, where votes from different algorithms must be combined mathematically.

Without normalization:
- ZScore might report confidence as raw deviation (e.g., 5.2)
- ExpectedRange might use binary (0 or 1)
- RateChange might use percentage (0-100)

**The Problem**: You cannot meaningfully combine `5.2 + 0 + 87%` in a weighted vote.

**The Solution**: Map all confidences to `[0, 1]` probability-like scores using appropriate normalization functions.

---

## Normalization Functions

### 1. Sigmoid Normalization (Default for Soft Detectors)

**Formula**: `confidence = 1 / (1 + e^(-k * (x / threshold)))`

**Use Case**: Soft detectors (statistical methods) where confidence should scale smoothly.

**Properties**:
- **Smooth scaling**: No discontinuities
- **Threshold mapping**: `deviation = threshold` → `confidence = 0.5`
- **Asymptotic bounds**: Approaches 0 for small deviations, 1 for large
- **Adjustable steepness**: `k` parameter controls transition sharpness (default: 2.0)

**Example**:
```typescript
// ZScore: deviation of 3.0 sigma with threshold 3.0
confidence = sigmoid(3.0, 3.0) = 0.5  // At threshold
confidence = sigmoid(6.0, 3.0) = 0.88 // 2x threshold
confidence = sigmoid(1.5, 3.0) = 0.27 // 0.5x threshold
```

**Graph**:
```
confidence
  1.0 |              ████████████
      |           ███
  0.5 |         ██ (at threshold)
      |       ██
  0.0 | ██████
      +-----------------------> deviation
      0    threshold    2x
```

**Applied To**:
- ZScore Detector
- MAD Detector
- IQR Detector
- EWMA Detector

---

### 2. Binary Normalization (Hard Detectors)

**Formula**: `confidence = deviation > 0 ? 1.0 : 0.0`

**Use Case**: Hard detectors (physical limits) where there is no gray area.

**Properties**:
- **No gradual scaling**: Either 1.0 (violation) or 0.0 (normal)
- **Immediate response**: Instant detection at threshold
- **Safety critical**: Ensures hard detectors cannot be "outvoted"

**Example**:
```typescript
// ExpectedRange: min=40, max=60
value = 50 → confidence = 0.0 (within range)
value = 61 → confidence = 1.0 (outside range)
value = 100 → confidence = 1.0 (still 1.0, no scaling)
```

**Graph**:
```
confidence
  1.0 |          ████████████████
      |          |
  0.5 |          |
      |          |
  0.0 | █████████
      +-----------------------> value
      min   max
```

**Applied To**:
- ExpectedRange Detector (physical limits)
- Any safety-critical detector with hard thresholds

---

### 3. Exponential Normalization (Rate Changes)

**Formula**: `confidence = 1 - e^(-(deviation/threshold)^2)`

**Use Case**: Rate change detection where sudden spikes should be emphasized.

**Properties**:
- **Emphasizes extremes**: Grows faster than linear for large deviations
- **Rapid detection**: Quickly reaches high confidence for spikes
- **Still bounded**: Always in [0, 1] range

**Example**:
```typescript
// RateChange: threshold = 10% per second
change = 5% → confidence = 0.22  (small change)
change = 10% → confidence = 0.63 (at threshold, higher than sigmoid's 0.5)
change = 20% → confidence = 0.98 (spike, almost 1.0)
```

**Graph**:
```
confidence
  1.0 |           ███████████████
      |         ██
  0.5 |       ██
      |     ██
  0.0 | ████
      +-----------------------> rate change
      0   threshold   2x
```

**Applied To**:
- RateChange Detector (sudden spikes more critical)

---

## Implementation by Detector

### ZScore Detector

**Before** (Linear scaling):
```typescript
const confidence = Math.min(1.0, zScore / (threshold * 2));
// Problem: zScore=3 → 0.5, zScore=6 → 1.0 (clamped, loses information)
```

**After** (Sigmoid):
```typescript
const confidence = sigmoid(zScore, threshold);
// zScore=3 → 0.5, zScore=6 → 0.88, zScore=9 → 0.95 (smooth scaling)
```

**Rationale**: ZScore is a soft statistical method. Sigmoid provides smooth, unbounded scaling.

---

### MAD Detector

**Before** (Linear scaling):
```typescript
const confidence = Math.min(1.0, madScore / (threshold * 2));
```

**After** (Sigmoid):
```typescript
const confidence = sigmoid(madScore, threshold);
```

**Rationale**: MAD (Median Absolute Deviation) is robust to outliers. Sigmoid preserves sensitivity.

---

### IQR Detector

**Before** (Linear scaling):
```typescript
const deviation = iqr > 0 ? distance / iqr : 0;
const confidence = Math.min(1.0, deviation);
```

**After** (Sigmoid):
```typescript
const deviation = iqr > 0 ? distance / iqr : 0;
const confidence = sigmoid(deviation, 1.0);
```

**Rationale**: IQR (Interquartile Range) is quartile-based. Sigmoid smooths fence violations.

---

### ExpectedRange Detector

**Before** (Binary):
```typescript
const confidence = isAnomaly ? 1.0 : 0;
```

**After** (Binary, explicit):
```typescript
const confidence = binaryConfidence(Math.abs(deviation), 0.0);
```

**Rationale**: Physical limits (temperature, pressure) have no gray area. Binary is correct.

**Important**: This is a **hard detector** and will override soft detectors in fusion.

---

### RateChange Detector

**Before** (Linear scaling):
```typescript
const confidence = Math.min(1.0, percentChange / (threshold * 2));
```

**After** (Exponential):
```typescript
const confidence = exponentialConfidence(percentChange, threshold);
```

**Rationale**: Sudden spikes (e.g., CPU going 0% → 100% in 1s) are more critical than gradual changes. Exponential emphasizes extremes.

---

### EWMA Detector

**Before** (Linear scaling):
```typescript
const confidence = buffer.stdDev > 0 
  ? Math.min(1.0, deviation / (threshold * 2))
  : 0;
```

**After** (Sigmoid):
```typescript
const normalizedDeviation = buffer.stdDev > 0 ? deviation / buffer.stdDev : 0;
const confidence = sigmoid(normalizedDeviation, config.threshold || 2.0);
```

**Rationale**: EWMA (Exponentially Weighted Moving Average) is trend-based. Sigmoid captures gradual trend shifts.

---

## Testing Confidence Normalization

### Unit Tests for Normalization Functions

```typescript
describe('Sigmoid Function', () => {
  it('should return 0.5 at threshold', () => {
    expect(sigmoid(3.0, 3.0)).toBeCloseTo(0.5, 2);
  });
  
  it('should approach 1.0 for large deviations', () => {
    expect(sigmoid(15.0, 3.0)).toBeGreaterThan(0.95);
  });
  
  it('should approach 0.0 for small deviations', () => {
    expect(sigmoid(0.3, 3.0)).toBeLessThan(0.05);
  });
});
```

### Integration Tests for Detector Consistency

```typescript
it('All detectors should produce comparable confidence scores', () => {
  const buffer = createNormalBuffer(); // Mean=50, StdDev=5
  const anomalousValue = 100; // 10 sigma deviation
  
  const zscore = new ZScoreDetector().detect(buffer, anomalousValue, config);
  const mad = new MADDetector().detect(buffer, anomalousValue, config);
  const ewma = new EWMADetector().detect(buffer, anomalousValue, config);
  
  // All soft detectors should agree (within ±0.3)
  expect(Math.abs(zscore.confidence - mad.confidence)).toBeLessThan(0.3);
  expect(Math.abs(zscore.confidence - ewma.confidence)).toBeLessThan(0.3);
  
  // All should be high for obvious anomaly
  expect(zscore.confidence).toBeGreaterThan(0.7);
  expect(mad.confidence).toBeGreaterThan(0.7);
  expect(ewma.confidence).toBeGreaterThan(0.7);
});
```

### Range Validation

```typescript
it('should ensure all detector confidences are in [0, 1]', () => {
  const testValues = [50, 60, 80, 100, 200];
  
  testValues.forEach(value => {
    detectors.forEach(detector => {
      const result = detector.detect(buffer, value, config);
      
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(Number.isFinite(result.confidence)).toBe(true);
    });
  });
});
```

---

## Fusion Integration

With normalized confidence, detector fusion becomes mathematically sound:

```typescript
// All confidences are [0, 1] probability-like scores
const zscoreVote = 0.75 * 0.25;  // weight * confidence
const madVote = 0.85 * 0.25;
const ewmaVote = 0.80 * 0.20;
const rangeVote = 1.0 * 0.30;    // Hard detector: binary 1.0

const finalConfidence = zscoreVote + madVote + ewmaVote + rangeVote;
// = 0.1875 + 0.2125 + 0.16 + 0.30 = 0.86
```

**Without normalization**:
```typescript
// Mixing apples, oranges, and elephants
const badFusion = (zScore=5.2) * 0.25 + (binary=1) * 0.25 + (percent=87) * 0.20;
// = 1.3 + 0.25 + 17.4 = 18.95 ??? (nonsensical)
```

---

## Best Practices

### 1. Choose the Right Normalization
- **Soft detectors** (statistical) → Sigmoid (smooth scaling)
- **Hard detectors** (physical limits) → Binary (0 or 1)
- **Rate changes** (spikes) → Exponential (emphasize extremes)

### 2. Calibrate Thresholds Carefully
- Sigmoid maps `deviation = threshold` → `confidence = 0.5`
- Ensure threshold represents "moderate anomaly" level
- Too low: false positives; too high: missed anomalies

### 3. Test Consistency Across Detectors
- For the same anomalous value, soft detectors should agree within ±0.3
- Hard detectors can differ (binary vs. scaled)
- Normal values should always produce low confidence (<0.2)

### 4. Avoid Premature Clamping
- Don't use `Math.min(1.0, ...)` on unbounded metrics
- Let sigmoid naturally approach 1.0 asymptotically
- Preserve information about extreme deviations

### 5. Document Normalization Strategy
- Clearly mark hard vs. soft detectors
- Explain why specific normalization was chosen
- Include expected confidence ranges in comments

---

## Performance Considerations

### Computational Cost
- **Sigmoid**: 1 exp() operation (~10 CPU cycles)
- **Binary**: 1 comparison (<1 CPU cycle)
- **Exponential**: 1 exp() + 1 power (~15 CPU cycles)

**Impact**: Negligible. Normalization adds <0.01ms per detection.

### Edge Device Optimization
```typescript
// Pre-compute steepness multiplier
const k = 2.0;
const precomputed_k_over_threshold = k / threshold;

// Faster sigmoid
function fastSigmoid(deviation: number): number {
  return 1 / (1 + Math.exp(-precomputed_k_over_threshold * deviation));
}
```

---

## Common Pitfalls

### 1. Mixing Normalized and Raw Scores
```typescript
// BAD: Mixing normalized and raw
const fusion = sigmoid(zScore, 3.0) + rawPercentage / 100;

// GOOD: All normalized
const fusion = sigmoid(zScore, 3.0) + sigmoid(percentage, 10.0);
```

### 2. Using Linear Scaling Beyond [0, 1]
```typescript
// BAD: Can exceed 1.0
const confidence = deviation / threshold;

// GOOD: Bounded [0, 1]
const confidence = sigmoid(deviation, threshold);
```

### 3. Treating All Detectors as Soft
```typescript
// BAD: Smoothing a hard detector
const rangeConfidence = sigmoid(outsideDistance, threshold);

// GOOD: Preserve binary nature
const rangeConfidence = binaryConfidence(outsideDistance, 0.0);
```

---

## Validation Checklist

Before deploying confidence normalization:

- [ ] All detector confidences are in `[0, 1]`
- [ ] No `NaN` or `Infinity` values
- [ ] Soft detectors agree within ±0.3 for same anomaly
- [ ] Hard detectors remain binary (0.0 or 1.0)
- [ ] Normal values produce low confidence (<0.2)
- [ ] Extreme anomalies produce high confidence (>0.8)
- [ ] Fusion math uses normalized confidences
- [ ] Tests validate consistency across detectors

---

## References

- **Sigmoid Function**: [Wikipedia - Sigmoid](https://en.wikipedia.org/wiki/Sigmoid_function)
- **Detector Fusion**: [ANOMALY-DETECTOR-FUSION.md](./ANOMALY-DETECTOR-FUSION.md)
- **Temporal Confirmation**: [ANOMALY-TEMPORAL-CONFIRMATION.md](./ANOMALY-TEMPORAL-CONFIRMATION.md)
- **Hard vs Soft Detectors**: [ANOMALY-HARD-VS-SOFT-DETECTORS.md](./ANOMALY-HARD-VS-SOFT-DETECTORS.md)

---

## Summary

Confidence normalization is essential for:
1. **Mathematically sound fusion** - Combining detector votes
2. **Comparable scores** - All detectors speak the same language
3. **Probabilistic interpretation** - `confidence = 0.8` means "80% certain"
4. **Smooth scaling** - No discontinuities or artifacts

**Key Principle**: Soft detectors use sigmoid, hard detectors use binary, rate changes use exponential.

This ensures the anomaly detection system produces **reliable, interpretable, and actionable confidence scores**.
