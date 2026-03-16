# AI/ML Services

This directory contains AI and machine learning services for edge devices.

## Structure

### `anomaly/` - Anomaly Detection
Edge-based anomaly pre-detection for sensor data and system metrics.

**Features**:
- 5 statistical detection methods (Z-score, MAD, IQR, Rate Change, EWMA)
- Lightweight (< 50MB RAM, < 5% CPU)
- Real-time alerting integrated with metrics reporting
- Circular buffers with incremental statistics
- Alert deduplication and prioritization

**Documentation**:
- Design: `docs/ANOMALY-DETECTION-DESIGN.md`
- Guide: `docs/ANOMALY-DETECTION-GUIDE.md`
- Summary: `docs/ANOMALY-DETECTION-SUMMARY.md`

**Usage**:
```typescript
import { AnomalyDetectionService } from './ai/anomaly';
import { loadConfigFromEnv, createSystemDataPoint } from './ai/anomaly/utils';

const config = loadConfigFromEnv();
const anomalyService = new AnomalyDetectionService(config, logger);

// Process data points
anomalyService.processDataPoint(
  createSystemDataPoint('cpu_usage', 75, '%')
);

// Get summary for reporting
const summary = anomalyService.getSummaryForReport();
```

## Future Modules

### `prediction/` (Planned)
- Time-series forecasting
- LSTM models for sensor prediction
- Maintenance prediction

### `clustering/` (Planned)
- K-means clustering for device grouping
- Behavior pattern recognition

### `federated/` (Planned)
- Federated learning across devices
- Privacy-preserving model training
