# Heap Profiling Guide

## Quick Start

Enable heap snapshots to track memory leaks empirically:

```bash
# Rebuild agent with profiling code
./scripts/generate-agents.ps1 -BuildFromSource

# Start with profiling enabled (snapshots every 5 minutes)
docker exec -it <agent-container> sh -c "
  export ENABLE_HEAP_PROFILING=true
  export HEAP_SNAPSHOT_INTERVAL_MIN=5
  export HEAP_SNAPSHOT_DIR=/tmp/heap-snapshots
  node dist/app.js
"
```

**Or** modify `docker-compose.yml`:
```yaml
agent:
  environment:
    - ENABLE_HEAP_PROFILING=true
    - HEAP_SNAPSHOT_INTERVAL_MIN=5  # Take snapshot every 5 minutes
    - HEAP_SNAPSHOT_DIR=/tmp/heap-snapshots
```

## Extract Snapshots

```powershell
# Find agent container
$agent = docker ps --format "{{.Names}}" | Select-String -Pattern "agent" | Select-Object -First 1

# Copy snapshots to local machine
docker cp ${agent}:/tmp/heap-snapshots ./profiling/

# List snapshots
ls ./profiling/heap-snapshots/
```

## Analyze in Chrome DevTools

1. Open Chrome → Press **F12** (or right-click → Inspect)
2. Go to **Memory** tab
3. Click **Load** button (bottom of left panel)
4. Select `.heapsnapshot` file from `./profiling/heap-snapshots/`
5. Repeat to load **2+ snapshots** (before/after reconnections)

### Compare Snapshots

1. Load first snapshot (baseline)
2. Switch dropdown to **Comparison**
3. Load second snapshot (after Modbus reconnections)
4. Look for objects with **Delta > 0** and growing **Retained Size**

### What to Look For

**Evidence of leak (BEFORE fixes)**:
- `ModbusRTU` instances: Should be 1 per device, not accumulating
- `Socket` / `TcpSocketConnectWrap`: Should match ModbusRTU count
- Event listener closures: Search for `error` / `close` handlers
- `Timeout` objects: Reconnect timers should be cleared

**Evidence of fix (AFTER fixes)**:
- `ModbusRTU`: Stable count (1 per device)
- `(array)` under event emitters: Should not grow (listeners removed via `.off()`)
- `Timeout`: No accumulation (timers cleared in all paths)
- Retained size stable across snapshots

## Trigger Reconnections (Stress Test)

```bash
# Restart Modbus simulator to force reconnections
docker restart iotistic-modbus-sim
docker restart iotistic-modbus-sim-2

# Wait 2 minutes, restart again
# Take snapshot after each cycle
```

## Expected Results

### Before Fixes (Memory Leak)
```
Snapshot 1 (baseline):  ModbusRTU: 2, Listeners: 4
Snapshot 2 (+5 reconnects): ModbusRTU: 7, Listeners: 14
Snapshot 3 (+10 reconnects): ModbusRTU: 12, Listeners: 24
```
**Delta**: +5 ModbusRTU, +10 listeners per 5 reconnects → **LEAK**

### After Fixes (No Leak)
```
Snapshot 1 (baseline):  ModbusRTU: 2, Listeners: 4
Snapshot 2 (+5 reconnects): ModbusRTU: 2, Listeners: 4
Snapshot 3 (+10 reconnects): ModbusRTU: 2, Listeners: 4
```
**Delta**: 0 → **FIXED**

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_HEAP_PROFILING` | `false` | Enable heap snapshot capture |
| `HEAP_SNAPSHOT_INTERVAL_MIN` | `5` | Minutes between snapshots |
| `HEAP_SNAPSHOT_DIR` | `/tmp/heap-snapshots` | Snapshot output directory |

## Production Safety

- Snapshots are **NOT** taken unless `ENABLE_HEAP_PROFILING=true`
- No performance impact when disabled
- Snapshots are ~10-50 MB each (depending on heap size)
- Recommended: Enable only during leak investigation, then disable

## Cleanup

```powershell
# Remove snapshots from container
docker exec <agent-container> rm -rf /tmp/heap-snapshots/*

# Remove local copies
Remove-Item -Recurse -Force ./profiling/heap-snapshots
```
