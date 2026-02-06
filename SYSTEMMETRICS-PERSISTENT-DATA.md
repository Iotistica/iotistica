# SystemMetrics Persistent Data Implementation

## Overview
Implemented persistent chart data storage for SystemMetrics telemetry using the same context pattern as MQTT charts. Data now survives navigation and component unmount/remount cycles.

## Changes Made

### 1. Created SystemMetricsContext (`dashboard/src/contexts/SystemMetricsContext.tsx`)
**Pattern**: Same as MqttContext - global state provider that persists across navigation

**Features**:
- Per-device metrics history storage (keyed by deviceUuid)
- Ring buffer with max 30 points per device
- Separate tracking for current stats and chart history
- Methods:
  - `getDeviceHistory(deviceUuid)` - Retrieve persisted chart data
  - `getCurrentStats(deviceUuid)` - Get latest system stats
  - `addMetricsDataPoint(deviceUuid, point)` - Add new data point
  - `updateCurrentStats(deviceUuid, stats)` - Update current stats
  - `clearDeviceHistory(deviceUuid)` - Clear single device
  - `clearAllHistory()` - Clear all devices

**Data Structure**:
```typescript
interface SystemMetricsDataPoint {
  timestamp: number;        // Unix timestamp
  time: string;             // Formatted for display
  cpuPercent: number;
  memoryUsedPercent: number;
  networkRxMbps: number;
  networkTxMbps: number;
  temperature?: number;
}
```

### 2. Updated Main App Provider (`dashboard/src/main.tsx`)
**Change**: Added SystemMetricsProvider to provider hierarchy

**Provider Stack**:
```tsx
<ThemeProvider>
  <AuthProvider>
    <DeviceStateProvider>
      <MetricsHistoryProvider>
        <SystemMetricsProvider>  // NEW
          <MqttProvider>
            <App />
          </MqttProvider>
        </SystemMetricsProvider>
      </MetricsHistoryProvider>
    </DeviceStateProvider>
  </AuthProvider>
</ThemeProvider>
```

### 3. Refactored SystemMetrics Component (`dashboard/src/components/SystemMetrics.tsx`)
**Changes**:
1. **Import**: Added `useSystemMetrics` hook
2. **State Management**: 
   - Local state (`cpuHistory`, `memoryHistory`, `networkHistory`) now hydrated from context
   - Restored on component mount from persisted data
3. **WebSocket Handler**: Updated to persist data points to context
4. **API Fetch Handler**: Updated to persist data points to context (30min period only)

**Restoration Logic**:
```typescript
useEffect(() => {
  if (persistedHistory.length > 0) {
    console.log('[SystemMetrics] Restoring from persisted history:', persistedHistory.length, 'points');
    // Convert context data back to component state format
    const cpu = persistedHistory.map(p => ({ time: p.time, value: p.cpuPercent }));
    const memory = persistedHistory.map(p => ({ time: p.time, used: p.memoryUsedPercent }));
    const network = persistedHistory.map(p => ({ 
      time: p.time, 
      download: p.networkRxMbps, 
      upload: p.networkTxMbps 
    }));
    
    setCpuHistory(cpu);
    setMemoryHistory(memory);
    setNetworkHistory(network);
  }
}, [device.deviceUuid]);
```

**Persistence Logic** (WebSocket handler):
```typescript
// Only persist if we have all three metrics for the timestamp
if (data.cpu && data.memory && data.network) {
  const lastPoint = {
    timestamp: Date.now(),
    time: formatTime(...),
    cpuPercent: data.cpu[last].value,
    memoryUsedPercent: data.memory[last].used,
    networkRxMbps: data.network[last].download,
    networkTxMbps: data.network[last].upload,
  };
  addMetricsDataPoint(device.deviceUuid, lastPoint);
}
```

**Persistence Logic** (API handler):
```typescript
// Only persist for 30min period (real-time data)
if (period === '30min') {
  addMetricsDataPoint(device.deviceUuid, {
    timestamp: new Date(m.recorded_at).getTime(),
    time,
    cpuPercent: Math.round(m.cpu_usage || 0),
    memoryUsedPercent: Math.round(m.memory_usage || 0),
    networkRxMbps: Math.round((m.network_rx_rate || 0) / 1024),
    networkTxMbps: Math.round((m.network_tx_rate || 0) / 1024),
  });
}
```

## Behavior

### Before (Old Behavior)
1. Navigate to SystemMetrics for online device
2. Watch charts populate with data (30 points over 30 minutes)
3. Navigate to different view
4. Navigate back to SystemMetrics
5. **Charts start from scratch** ❌

### After (New Behavior)
1. Navigate to SystemMetrics for online device
2. Watch charts populate with data (30 points over 30 minutes)
3. Navigate to different view
4. Navigate back to SystemMetrics
5. **Charts restore previous data instantly** ✅
6. New data continues to append seamlessly

## Technical Details

### Storage Strategy
- **Global Context**: Data stored at app root level, survives component unmount
- **Per-Device Keying**: Each device has separate history (`deviceMetrics[deviceUuid]`)
- **Ring Buffer**: Automatically keeps last 30 points per device (30 minutes at 1-min intervals)
- **30min Period Only**: Only persist real-time WebSocket data (longer periods fetched fresh from API)

### Memory Management
- Max 30 points × N devices (where N = active devices)
- Each point ~200 bytes (6 fields × ~30 bytes each)
- Max memory per device: ~6 KB (negligible)
- Total for 10 devices: ~60 KB

### Data Flow
```
WebSocket/API → SystemMetrics Component → Context Storage
     ↓                    ↑                      ↓
  Live Data        Restore on Mount        Persist to Memory
                         ↑                      ↓
                    Component Unmount    Data Survives
                         ↑                      ↓
                    Navigate Back        Restore Again
```

## Testing

### Test Scenarios
1. **Single Device Navigation**:
   - Select online device
   - Wait for charts to populate (5-10 data points)
   - Navigate to different device
   - Navigate back
   - **Verify**: Charts restore immediately with previous data

2. **Multi-Device Switching**:
   - View Device A charts (accumulate data)
   - Switch to Device B charts (accumulate data)
   - Switch back to Device A
   - **Verify**: Device A charts restore previous data
   - Switch back to Device B
   - **Verify**: Device B charts restore previous data

3. **Page Navigation**:
   - View SystemMetrics charts
   - Navigate to different page (Applications, Networking, etc.)
   - Navigate back to SystemMetrics
   - **Verify**: Charts restore previous data

4. **Time Period Switching**:
   - View 30min charts (accumulate data)
   - Switch to 6h/12h/24h (fetch from API)
   - Switch back to 30min
   - **Verify**: 30min charts restore previous data (not refetched)

### Console Logs to Monitor
```bash
# On mount with persisted data
[SystemMetrics] Restoring from persisted history: 15 points

# On WebSocket data received
[SystemMetrics] Updating CPU history: adding 1 points

# On context persistence
# (No explicit log, but verify data survives navigation)
```

## Known Limitations

1. **Browser Refresh**: Data clears (not persisted to localStorage)
   - Same behavior as MQTT charts
   - Future enhancement: Add localStorage persistence

2. **30min Period Only**: Only real-time data persists
   - 6h/12h/24h periods always fetch fresh from API
   - Rationale: Historical data changes less frequently, API is source of truth

3. **No Cross-Session Persistence**: Data only lives during session
   - Same behavior as MQTT charts
   - Future enhancement: Add sessionStorage/localStorage

## Future Enhancements

### Phase 2 (Optional)
1. **LocalStorage Persistence**:
   - Save to localStorage on data update
   - Restore on app init
   - Survive browser refresh

2. **Compression**:
   - Compress older data points (reduce precision)
   - Store more history in same memory footprint

3. **Current Stats Persistence**:
   - Use `updateCurrentStats()` to persist latest system info
   - Restore on mount for instant display (no loading state)

4. **Longer Periods**:
   - Optionally persist 6h/12h/24h data
   - Trade-off: More memory vs faster display

## Comparison with MQTT Pattern

| Feature | MQTT Charts | SystemMetrics | Notes |
|---------|-------------|---------------|-------|
| Context Provider | ✅ MqttContext | ✅ SystemMetricsContext | Same pattern |
| Ring Buffer | ✅ 30 points | ✅ 30 points | Same limit |
| Per-Device Storage | ❌ Global only | ✅ Per-device | SystemMetrics improved |
| Data Persistence | ✅ Chart history | ✅ Chart history | Same behavior |
| LocalStorage | ❌ No | ❌ No | Future enhancement |
| Hook Export | ✅ useMqtt() | ✅ useSystemMetrics() | Same API |

## Files Modified

1. **Created**: `dashboard/src/contexts/SystemMetricsContext.tsx` (113 lines)
2. **Modified**: `dashboard/src/main.tsx` (+2 lines: import + provider)
3. **Modified**: `dashboard/src/components/SystemMetrics.tsx` (+40 lines: context integration)

**Total**: ~155 lines of new/modified code

## Rollback Plan

If issues arise:
1. Remove `<SystemMetricsProvider>` from main.tsx
2. Remove `useSystemMetrics()` calls from SystemMetrics.tsx
3. Remove persistence logic (addMetricsDataPoint calls)
4. Component reverts to local-only state (original behavior)

