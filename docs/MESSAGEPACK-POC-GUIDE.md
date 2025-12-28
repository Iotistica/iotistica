# MessagePack POC Testing Guide

## Overview

This guide covers the 1-day proof-of-concept test to measure actual MessagePack compression ratios in production.

## POC Objectives

1. Measure real-world compression ratios for sensor data batches
2. Validate bandwidth savings estimates (35-40% predicted)
3. Confirm CPU impact is acceptable
4. Verify format auto-detection works reliably
5. Gather data for go/no-go decision on full rollout

## POC Architecture

**Agent Side (READY):**
- ✅ Msgpack serialization implemented
- ✅ Compression logging enabled
- ✅ Format auto-detection working
- ✅ Environment variable toggle: `USE_MSGPACK_POC=true`

**Cloud API Side (NEEDS UPDATE):**
- ⚠️ Currently only deserializes JSON
- ⚠️ Msgpack messages will fail parsing
- ✅ Simple fix: `deserializePayload()` already detects format

## Testing Devices

**Recommended Setup:**
- 5 Raspberry Pi devices with active sensors
- Mix of sensor types (temperature, pressure, gas quality)
- Devices with high message volume (>100 msg/min)
- Representative production workload

## Deployment Steps

### 1. Enable POC on Test Devices

**SSH into each device:**
```bash
ssh pi@device-hostname
```

**Set environment variable:**
```bash
# Edit systemd service
sudo systemctl edit iotistic-agent

# Add this override:
[Service]
Environment="USE_MSGPACK_POC=true"

# Save and restart
sudo systemctl restart iotistic-agent
```

**Verify POC mode:**
```bash
# Check logs for compression stats
journalctl -u iotistic-agent -f | grep "MessagePack compression"
```

### 2. Update Cloud API (REQUIRED)

**File:** `api/src/mqtt/mqtt-manager.ts`

**Current code (line ~668):**
```typescript
// Parse JSON payload
let data: any;
try {
  data = JSON.parse(message);
} catch {
  data = message;
}
```

**Update to:**
```typescript
import { deserializePayload } from '../../agent/src/mqtt/manager'; // Or create api version

// Auto-detect format (msgpack or JSON)
const payload = deserializePayload(Buffer.isBuffer(message) ? message : Buffer.from(message));
const data = payload.format === 'binary' ? message : payload.data;
```

**Alternative (simpler):**
```typescript
import msgpack from 'msgpack-lite';

let data: any;
const buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);

// Try msgpack first (POC format detection)
if (buffer.length > 0) {
  const firstByte = buffer[0];
  if ((firstByte >= 0x90 && firstByte <= 0x9f) || 
      firstByte === 0xdc || firstByte === 0xdd ||
      (firstByte >= 0x80 && firstByte <= 0x8f)) {
    try {
      data = msgpack.decode(buffer);
    } catch {
      // Fall through to JSON
    }
  }
}

// Try JSON if not msgpack
if (!data) {
  try {
    data = JSON.parse(buffer.toString('utf-8'));
  } catch {
    data = message;
  }
}
```

### 3. Deploy Updated API

**Build and deploy:**
```bash
cd api
npm run build
# Deploy to cloud (K8s/Docker depending on setup)
kubectl rollout restart deployment/api -n <customer-namespace>
```

**Verify API can parse msgpack:**
```bash
# Check logs for any parsing errors
kubectl logs -f deployment/api -n <customer-namespace> | grep -i "error\|msgpack"
```

## Monitoring POC

### Agent-Side Metrics

**View compression stats:**
```bash
# On each device
journalctl -u iotistic-agent -f | grep "MessagePack compression"
```

**Example output:**
```json
{
  "level": "info",
  "timestamp": "2025-01-15T10:30:00Z",
  "component": "mqtt",
  "topic": "sensor-data",
  "jsonBytes": 2450,
  "msgpackBytes": 1580,
  "savingsBytes": 870,
  "compressionPct": "35.5%",
  "ratio": "2450:1580"
}
```

### Cloud-Side Metrics

**Monitor MQTT handler:**
```bash
# Check for deduplication working (msgId field preserved)
kubectl logs -f deployment/api | grep "Duplicate message detected"

# Check for parsing errors
kubectl logs -f deployment/api | grep -i "error.*parse"
```

### Network Bandwidth

**Measure before/after:**
```bash
# On device - monitor MQTT traffic
sudo tcpdump -i any port 1883 -w mqtt-traffic.pcap

# Analyze later
tcpdump -r mqtt-traffic.pcap -n | wc -l  # Message count
```

## Data Collection

### Compression Ratio Analysis

**Collect logs from all 5 devices:**
```bash
# Export 24h of compression logs
journalctl -u iotistic-agent --since "24 hours ago" \
  | grep "MessagePack compression" > /tmp/msgpack-stats.log

# Copy to analysis machine
scp pi@device:/tmp/msgpack-stats.log ./device1-stats.log
```

**Parse and analyze:**
```bash
# Extract compression percentages
grep -oP 'compressionPct": "\K[0-9.]+' device1-stats.log | \
  awk '{ total += $1; count++ } END { print "Average: " total/count "%" }'

# Extract bytes saved
grep -oP 'savingsBytes": \K[0-9]+' device1-stats.log | \
  awk '{ total += $1 } END { print "Total saved: " total " bytes (" total/1024/1024 " MB)" }'
```

### CPU Impact

**Monitor CPU during POC:**
```bash
# Check agent CPU usage
top -b -n 1 | grep iotistic-agent

# Or with systemd
systemctl status iotistic-agent | grep CPU
```

**Compare to baseline:**
- Record CPU% before enabling msgpack
- Record CPU% after enabling msgpack
- Calculate delta

### Memory Impact

**Check memory usage:**
```bash
ps aux | grep iotistic-agent | awk '{print $4, $6}'
```

## Success Criteria

**Go Decision if:**
- ✅ Average compression ratio ≥ 30%
- ✅ No parsing errors in cloud API logs
- ✅ CPU increase ≤ 5%
- ✅ No message loss (deduplication working)
- ✅ Bandwidth savings measurable

**No-Go Decision if:**
- ❌ Compression ratio < 20%
- ❌ Parsing errors in production
- ❌ CPU increase > 10%
- ❌ Memory increase > 20%

## Rollback Plan

**If issues detected:**

**1. Disable POC on devices:**
```bash
ssh pi@device
sudo systemctl edit iotistic-agent
# Remove Environment="USE_MSGPACK_POC=true"
sudo systemctl restart iotistic-agent
```

**2. Verify normal operation:**
```bash
journalctl -u iotistic-agent -f | grep "Published.*messages"
```

**3. Cloud API:**
- Format detection is backward compatible
- No rollback needed (JSON still works)

## POC Timeline

**Day 0 (Setup):**
- Deploy updated cloud API with msgpack support
- Enable POC on 5 test devices
- Verify logs showing compression stats

**Day 1-7 (Monitoring):**
- Collect compression ratio logs
- Monitor CPU/memory impact
- Check for any errors or issues
- Validate deduplication still working

**Day 8 (Analysis):**
- Aggregate compression data from all devices
- Calculate average savings (bytes, percentage)
- Review CPU/memory metrics
- Make go/no-go decision

## Post-POC Actions

### If Go Decision

**1. Create rollout plan:**
- Phase 1: 10% of devices (config flag)
- Phase 2: 50% of devices
- Phase 3: 100% of devices

**2. Update documentation:**
- Add msgpack to architecture docs
- Update MQTT message format specs

**3. Remove POC logging:**
- Keep format detection
- Remove verbose compression logging
- Add periodic summary metrics

### If No-Go Decision

**1. Document findings:**
- Actual compression ratios measured
- CPU/bandwidth trade-off analysis
- Reasons for rejection

**2. Revert code:**
- Remove USE_MSGPACK_POC flag
- Keep format detection for future use
- Archive POC branch

**3. Consider alternatives:**
- GZIP compression at MQTT broker level
- Protobuf instead of msgpack
- Batch size optimization

## Troubleshooting

### No Compression Logs Appearing

**Check environment variable:**
```bash
systemctl show iotistic-agent | grep USE_MSGPACK_POC
```

**Check service override:**
```bash
systemctl cat iotistic-agent
```

### Cloud API Parsing Errors

**Check error logs:**
```bash
kubectl logs deployment/api | grep -i "error.*parse"
```

**Verify msgpack-lite installed:**
```bash
kubectl exec -it deployment/api -- npm list msgpack-lite
```

### High CPU Usage

**Profile serialization:**
```typescript
// Add to agent code
console.time('msgpack-serialize');
msgpack.encode(data);
console.timeEnd('msgpack-serialize');

console.time('json-serialize');
JSON.stringify(data);
console.timeEnd('json-serialize');
```

### Message Loss

**Check deduplication:**
```bash
# Cloud API logs should show msgId field preserved
kubectl logs deployment/api | grep "msgId"
```

**Verify msgId in payload:**
```typescript
// Agent: Log msgId before publish
console.log('Publishing with msgId:', data.msgId);
```

## Expected Results

**Compression Ratio:**
- Sensor batches: 35-40% reduction
- Single messages: 15-25% reduction
- Heartbeats: 10-20% reduction (small payload)

**CPU Impact:**
- Serialization: 30-50% faster than JSON
- Deserialization: 20-40% faster than JSON
- Overall: <3% CPU increase

**Bandwidth Savings:**
- 100 messages/min at 2KB each
- JSON: 200KB/min = 12MB/hour = 288MB/day
- Msgpack (35% savings): 130KB/min = 7.8MB/hour = 187MB/day
- **Savings: ~100MB/day per device**

**At Scale (100 devices):**
- Daily savings: ~10GB
- Monthly savings: ~300GB
- Annual savings: ~3.6TB

## Contact

**Questions during POC:**
- Check logs first: `journalctl -u iotistic-agent -f`
- Review this guide's troubleshooting section
- Contact: support@iotistic.ca

---

**Last Updated:** 2025-01-15  
**Status:** Ready for deployment  
**Version:** 1.0.0
