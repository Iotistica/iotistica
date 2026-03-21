import { Request, Response, NextFunction } from "express";
import { performance } from "perf_hooks";
import { DeviceTrafficStats } from "../types/traffic";

const deviceTrafficStats = new Map<string, DeviceTrafficStats>();

/**
 * Check if request is from a device
 * Devices send X-Device-API-Key or Authorization: Bearer header
 */
function isDeviceRequest(req: Request): boolean {
  return !!(
    req.headers['x-device-api-key'] ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer '))
  );
}

/**
 * Extract device UUID from request
 * Try: URL params, req.device (set by deviceAuth middleware), body
 */
function extractDeviceUuid(req: Request): string | null {
  // 1. From URL params (most common: /agents/:uuid/...)
  if (req.params.uuid) {
    return req.params.uuid;
  }

  // 2. From deviceAuth middleware (if already authenticated)
  if (req.device?.uuid) {
    return req.device.uuid;
  }

  // 3. From request body (state reports, telemetry)
  if (req.body) {
    // Direct field
    if (req.body.uuid || req.body.deviceUuid) {
      return req.body.uuid || req.body.deviceUuid;
    }

    // State report format: { "[uuid]": { ... } }
    const keys = Object.keys(req.body);
    if (keys.length === 1) {
      const key = keys[0];
      // Match UUID format
      if (key.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        return key;
      }
    }
  }

  return null;
}

/**
 * Traffic Logger Middleware
 * Only logs traffic for device requests (identified by X-Device-API-Key header)
 */
export function trafficLogger(req: Request, res: Response, next: NextFunction) {
  // Skip if not a device request
  if (!isDeviceRequest(req)) {
    next();
    return;
  }

  const start = performance.now();

  res.on("finish", () => {
    const duration = performance.now() - start;
    const endpoint = req.path;
    const method = req.method;
    const status = res.statusCode;

    const deviceUuid = extractDeviceUuid(req);

    // Skip if we couldn't extract device UUID
    if (!deviceUuid) {
      return;
    }

    // For 304 Not Modified: use X-Content-Length if available (original resource size)
    // Otherwise use Content-Length (actual bytes transmitted)
    const is304 = status === 304;
    let size: number;
    
    if (is304) {
      // For 304: check X-Content-Length header (set by endpoints to track original size)
      const xContentLength = res.getHeader("X-Content-Length") as string;
      size = parseInt(xContentLength) || 0;
    } else {
      // For all other responses: use actual Content-Length
      size = parseInt(res.getHeader("Content-Length") as string) || 0;
    }

    const key = `${deviceUuid}:${method}:${endpoint}`;
    const entry =
      deviceTrafficStats.get(key) ||
      ({
        deviceId: deviceUuid,
        endpoint,
        method,
        count: 0,
        totalBytes: 0,
        totalTime: 0,
        avgSize: 0,
        avgTime: 0,
        success: 0,
        failed: 0,
        statuses: {},
      } as DeviceTrafficStats);

    // Update stats
    entry.count++;
    entry.totalBytes += size;
    entry.totalTime += duration;
    entry.avgSize = entry.totalBytes / entry.count;
    entry.avgTime = entry.totalTime / entry.count;

    entry.statuses[status] = (entry.statuses[status] || 0) + 1;

    // 304 Not Modified is considered successful (cache hit)
    if ((status >= 200 && status < 300) || is304) entry.success++;
    else entry.failed++;

    deviceTrafficStats.set(key, entry);
  });

  next();
}

/**
 * Get all device traffic stats
 */
export function getTrafficStats(): DeviceTrafficStats[] {
  return Array.from(deviceTrafficStats.values());
}

/**
 * Get traffic stats for a specific device
 */
export function getDeviceTrafficStats(deviceUuid: string): DeviceTrafficStats[] {
  return Array.from(deviceTrafficStats.values()).filter(
    stat => stat.deviceId === deviceUuid
  );
}

/**
 * Get aggregated traffic stats per device (sum across all endpoints)
 */
export function getAggregatedDeviceStats(): Array<{
  deviceId: string;
  totalRequests: number;
  totalBytes: number;
  avgResponseTime: number;
  successRate: number;
  endpoints: number;
}> {
  const deviceGroups = new Map<string, DeviceTrafficStats[]>();

  // Group by device
  for (const stat of deviceTrafficStats.values()) {
    const existing = deviceGroups.get(stat.deviceId) || [];
    existing.push(stat);
    deviceGroups.set(stat.deviceId, existing);
  }

  // Aggregate per device
  return Array.from(deviceGroups.entries()).map(([deviceId, stats]) => {
    const totalRequests = stats.reduce((sum, s) => sum + s.count, 0);
    const totalBytes = stats.reduce((sum, s) => sum + s.totalBytes, 0);
    const totalTime = stats.reduce((sum, s) => sum + s.totalTime, 0);
    const totalSuccess = stats.reduce((sum, s) => sum + s.success, 0);

    return {
      deviceId,
      totalRequests,
      totalBytes,
      avgResponseTime: totalRequests > 0 ? totalTime / totalRequests : 0,
      successRate: totalRequests > 0 ? (totalSuccess / totalRequests) * 100 : 0,
      endpoints: stats.length
    };
  });
}
