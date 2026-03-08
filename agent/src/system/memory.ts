/**
 * AGENT PROCESS MEMORY MONITORING (Heap-based)
 * ==============================================
 * 
 * Monitors V8 heap usage to detect ACTUAL memory leaks, not allocator behavior.
 * 
 * Why heap instead of RSS:
 * - RSS includes allocator overhead, fragmentation, mmap regions, caching
 * - RSS can grow 50-100MB on edge devices without actual leaks (jemalloc/glibc)
 * - Heap tracks actual JavaScript object allocations
 * 
 * How it works:
 * 1. Waits 60s for startup stabilization
 * 2. Tracks heap_used trend over 10-minute window
 * 3. Detects sustained growth (>1MB/minute for 10 minutes)
 * 4. Allows normal plateau (heap stable for 5 minutes = healthy)
 */

import { memoryUsage } from 'process';import { getHeapStatistics } from 'v8';import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

// Heap tracking (more accurate than RSS)
let initialHeap: number = 0;
let baselineHeap: number = 0; // Sliding baseline (updates when stable)
let lastBaselineUpdate: number = 0;
let heapSamples: Array<{ 
	timestamp: number; 
	heapUsed: number; 
	external: number;
	totalHeapSize: number;
	heapSizeLimit: number;
	mallocedMemory: number;
}> = [];
const MAX_SAMPLES = 20; // 10 minutes of history at 30s intervals
const SAMPLE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const BASELINE_UPDATE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes minimum between baseline updates

// External memory tracking (Buffers, ArrayBuffers, native bindings, crypto)
let initialExternal: number = 0;
let baselineExternal: number = 0;

// Malloced memory tracking (GC allocation pressure signal)
// ⚠️ DIAGNOSTICS ONLY - Never use as hard threshold!
// - V8-internal metric, not strict allocation counter
// - Can jump due to allocator behavior
// - Use for context/investigation, not leak detection triggers
let initialMalloced: number = 0;
let baselineMalloced: number = 0;

// Survivor tracking (long-lived objects that survive GC cycles)
// NOTE: survivorBaseline is for DIAGNOSTICS/LOGGING only
// Actual leak detection uses calculateSurvivorGrowthRate() (windowed regression + monotonic check)
// This simple baseline tracker remains for visibility and debugging
let survivorBaseline: number = 0; // Minimum heap usage (post-GC baseline)
let lastSurvivorUpdate: number = 0;
const SURVIVOR_UPDATE_INTERVAL_MS = 2 * 60 * 1000; // Update survivor baseline every 2 minutes

// Legacy RSS tracking (for comparison only)
export let initialMemory: number = 0;
let baselineRSS: number = 0; // Sliding baseline (same logic as heap)
let lastMemoryCheck: number = 0;
let logger: AgentLogger | undefined;
let monitoringInterval: NodeJS.Timeout | undefined;
let memoryThresholdBreached: boolean = false;

// Memory leak simulation
let simulationInterval: NodeJS.Timeout | undefined;
let leakedObjects: any[] = [];

// Restart policy (prevents restart loops)
const RESTART_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour minimum between restarts
const MAX_RESTART_ATTEMPTS = 3; // Max restarts in 24 hours
const RESTART_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hour window
let lastRestartAttempt: number = 0;
let restartAttemptsSinceStartup: number = 0;

// Exported for tests only, as process.uptime cannot be stubbed
export const processUptime = () => Math.floor(process.uptime());

/**
 * Set logger for memory monitoring
 */
export function setMemoryLogger(agentLogger: AgentLogger | undefined): void {
	logger = agentLogger;
}

/**
 * Start active memory monitoring (runs independently of healthcheck)
 * This ensures memory leaks are detected even if /ping endpoint isn't called
 */
export function startMemoryMonitoring(
	intervalMs: number = 30000,
	thresholdBytes: number = 15 * 1024 * 1024,
	onThresholdBreached?: () => void
): void {
	// Don't start multiple monitors
	if (monitoringInterval) {
		logger?.warnSync('Memory monitoring already running', {
			component: LogComponents.metrics
		});
		return;
	}

	monitoringInterval = setInterval(async () => {
		try {
			const isHealthy = await healthcheck(thresholdBytes);
			
			// If threshold breached and callback provided
			if (!isHealthy && !memoryThresholdBreached) {
				memoryThresholdBreached = true;
				
				// Log detailed diagnostics (only once when first breached)
				const mem = memoryUsage();
				const currentHeap = mem.heapUsed;
				const currentRSS = mem.rss;
			const currentExternal = mem.external;
			const heapStats = getHeapStatistics();
			const heapGrowthRate = calculateHeapGrowthRate();
			const externalGrowthRate = calculateExternalGrowthRate();
			const mallocedGrowthRate = calculateMallocedGrowthRate();
			const heapTotalGrowthRate = calculateHeapTotalGrowthRate();
			const survivorGrowth = calculateSurvivorGrowthRate();
			const heapGrowthFromBaseline = currentHeap - baselineHeap;
			const heapGrowthFromInitial = currentHeap - initialHeap;
			const rssGrowthFromBaseline = currentRSS - baselineRSS;
			const rssGrowthFromInitial = currentRSS - initialMemory;
			const externalGrowthFromBaseline = currentExternal - baselineExternal;
			const externalGrowthFromInitial = currentExternal - initialExternal;
			const leakPattern = detectLeakPattern(currentHeap, currentRSS, currentExternal);
			
			// Log specific leak pattern with accurate message
			let leakMessage: string;
			if (leakPattern.pattern === 'survivor-leak') {
				leakMessage = '🚨 Survivor space leak detected - long-lived objects accumulating';
			} else if (leakPattern.pattern === 'buffer-crypto-native-leak') {
				leakMessage = '🚨 Buffer/Crypto/Native leak detected - all metrics growing';
			} else if (leakPattern.pattern === 'external-cache-leak') {
				leakMessage = '🚨 External memory leak detected - cache or native structures growing';
			} else if (leakPattern.pattern === 'js-object-retention') {
				leakMessage = '🚨 JavaScript object retention detected - heap growing';
			} else if (leakPattern.pattern === 'gc-pressure') {
				leakMessage = '🚨 GC pressure detected - heap and RSS growing';
			} else if (leakPattern.pattern === 'mixed-leak-jemalloc') {
				leakMessage = '🚨 Mixed leak detected - heap and RSS divergence (jemalloc)';
			} else if (leakPattern.pattern === 'external-leak') {
				leakMessage = '🚨 External memory threshold breached - sustained growth';
			} else if (leakPattern.pattern === 'rss-leak') {
				leakMessage = '🚨 RSS leak detected - resident set growing';
			} else {
				leakMessage = '🚨 Memory anomaly detected - investigation required';
			}
			
			logger?.errorSync(leakMessage, undefined, {
				component: LogComponents.metrics,
				// Heap metrics
				currentHeapMB: bytesToMB(currentHeap),
				baselineHeapMB: bytesToMB(baselineHeap),
				initialHeapMB: bytesToMB(initialHeap),
				heapGrowthFromBaselineMB: (heapGrowthFromBaseline / (1024 * 1024)).toFixed(2),
				heapGrowthFromInitialMB: (heapGrowthFromInitial / (1024 * 1024)).toFixed(2),
				heapGrowthRateMBperMin: heapGrowthRate?.toFixed(2) || 'null',
				heapThresholdMBperMin: getAdaptiveHeapThreshold(false).toFixed(2),
				heapThresholdBase: HEAP_GROWTH_RATE_MB_PER_MIN,
				heapThresholdAdaptive: (baselineHeap / (1024 * 1024) * ADAPTIVE_THRESHOLD_PERCENTAGE).toFixed(2),
				// Heap utilization (heapUsed vs heapTotal ratio)
				heapUtilization: ((heapStats.used_heap_size / heapStats.total_heap_size) * 100).toFixed(1) + '%',
				heapTotalGrowthRateMBperMin: heapTotalGrowthRate?.toFixed(2) || 'null',
				// RSS metrics
				currentRSSMB: bytesToMB(currentRSS),
				baselineRSSMB: bytesToMB(baselineRSS),
				rssGrowthFromBaselineMB: (rssGrowthFromBaseline / (1024 * 1024)).toFixed(2),
				rssGrowthFromInitialMB: (rssGrowthFromInitial / (1024 * 1024)).toFixed(2),
				// External memory metrics (Buffers, crypto, native)
				currentExternalMB: bytesToMB(currentExternal),
				baselineExternalMB: bytesToMB(baselineExternal),
				externalGrowthFromBaselineMB: (externalGrowthFromBaseline / (1024 * 1024)).toFixed(2),
				externalGrowthFromInitialMB: (externalGrowthFromInitial / (1024 * 1024)).toFixed(2),
				externalGrowthRateMBperMin: externalGrowthRate?.toFixed(2) || 'null',
				externalThresholdMBperMin: EXTERNAL_GROWTH_RATE_MB_PER_MIN,
				// GC signals (allocation pressure)
				totalHeapSizeMB: bytesToMB(heapStats.total_heap_size),
				heapSizeLimitMB: bytesToMB(heapStats.heap_size_limit),
				heapFragmentationMB: bytesToMB(heapStats.total_heap_size - heapStats.used_heap_size),
				heapLimitPressure: ((heapStats.used_heap_size / heapStats.heap_size_limit) * 100).toFixed(1) + '%',
				mallocedMemoryMB: bytesToMB(heapStats.malloced_memory),
				mallocedGrowthRateMBperMin: mallocedGrowthRate?.toFixed(2) || 'null',
				// Survivor tracking (long-lived objects)
				survivorBaselineMB: bytesToMB(survivorBaseline),
				survivorGrowthRateMBperMin: survivorGrowth?.rate.toFixed(2) || 'null',
				survivorFloorMonotonic: survivorGrowth?.isMonotonic ?? 'unknown',
				survivorRetainedMB: survivorGrowth?.retainedGrowth.toFixed(1) || 'null',
				// Leak pattern analysis
				leakPattern: leakPattern.pattern,
				leakDescription: leakPattern.description,
				uptimeSeconds: processUptime(),
				samples: heapSamples.length
			});
			
			if (onThresholdBreached) {
				// Check restart policy before invoking callback
				const eligibility = canAttemptRestart();
				
				if (eligibility.allowed) {
					logger?.warnSync('Restart policy allows restart - invoking callback', {
						component: LogComponents.metrics,
						attemptNumber: restartAttemptsSinceStartup + 1,
						maxAttempts: MAX_RESTART_ATTEMPTS
					});
					
					// Record attempt before callback (in case callback restarts immediately)
					recordRestartAttempt();
					
					onThresholdBreached();
				} else {
					logger?.errorSync('Restart blocked by policy - memory leak persists', undefined, {
						component: LogComponents.metrics,
						reason: eligibility.reason,
						attemptsSinceStartup: restartAttemptsSinceStartup,
						maxAttempts: MAX_RESTART_ATTEMPTS,
						lastRestartAgo: lastRestartAttempt > 0 
							? `${Math.floor((Date.now() - lastRestartAttempt) / (60 * 1000))} minutes ago`
							: 'never'
					});
				}
			}
		}
		
		// Reset flag if memory returns to normal
		if (isHealthy && memoryThresholdBreached) {
			memoryThresholdBreached = false;
			logger?.infoSync('Memory returned to normal levels', {
				component: LogComponents.metrics
			});
		}
	} catch (error) {
		logger?.errorSync(
			'Memory monitoring check failed',
			error instanceof Error ? error : new Error(String(error))
		);
	}
}, intervalMs);
}

/**
 * Stop active memory monitoring
 */
export function stopMemoryMonitoring(): void {
	if (monitoringInterval) {
		clearInterval(monitoringInterval);
		monitoringInterval = undefined;
		logger?.infoSync('Memory monitoring stopped', {
			component: LogComponents.metrics
		});
	}
}

/**
 * Check if restart attempt is allowed based on cooldown and max attempts
 */
function canAttemptRestart(): { allowed: boolean; reason?: string } {
	const now = Date.now();
	// Check cooldown (must wait 1 hour since last restart)
	if (lastRestartAttempt > 0 && now - lastRestartAttempt < RESTART_COOLDOWN_MS) {
		const remainingMs = RESTART_COOLDOWN_MS - (now - lastRestartAttempt);
		const remainingMin = Math.ceil(remainingMs / (60 * 1000));
		return {
			allowed: false,
			reason: `Restart cooldown active (${remainingMin} minutes remaining)`
		};
	}
	
	// Check max attempts (3 restarts in 24 hours)
	if (restartAttemptsSinceStartup >= MAX_RESTART_ATTEMPTS) {
		return {
			allowed: false,
			reason: `Max restart attempts reached (${MAX_RESTART_ATTEMPTS} in 24 hours)`
		};
	}
	
	return { allowed: true };
}

/**
 * Record restart attempt timestamp
 * Call this BEFORE attempting restart to update cooldown timer
 */
export function recordRestartAttempt(): void {
	const now = Date.now();
	lastRestartAttempt = now;
	restartAttemptsSinceStartup++;
	
	logger?.warnSync('Memory leak restart attempt recorded', {
		component: LogComponents.metrics,
		attemptNumber: restartAttemptsSinceStartup,
		maxAttempts: MAX_RESTART_ATTEMPTS,
		cooldownHours: RESTART_COOLDOWN_MS / (60 * 60 * 1000)
	});
}

/**
 * Get restart policy status for debugging
 */
export function getRestartPolicyStatus() {
	const now = Date.now();
	const eligibility = canAttemptRestart();
	
	return {
		lastRestartAttempt,
		restartAttemptsSinceStartup,
		maxAttempts: MAX_RESTART_ATTEMPTS,
		cooldownMs: RESTART_COOLDOWN_MS,
		timeSinceLastRestartMs: lastRestartAttempt > 0 ? now - lastRestartAttempt : null,
		canRestart: eligibility.allowed,
		blockReason: eligibility.reason
	};
}


const bytesToMB = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);

// Heap-based leak detection (more accurate than RSS)
const HEAP_GROWTH_RATE_MB_PER_MIN = 1.0; // Base threshold: 1 MB/min
const HEAP_GROWTH_RATE_RECOVERY_MB_PER_MIN = 0.75; // Recovery threshold (hysteresis prevents flapping)
const HEAP_STABILIZATION_TIME_MS = 5 * 60 * 1000; // 5 minutes stable = healthy

// External memory leak detection (Buffers, crypto, native)
const EXTERNAL_GROWTH_RATE_MB_PER_MIN = 0.5; // Base threshold: 0.5 MB/min
const EXTERNAL_GROWTH_RATE_RECOVERY_MB_PER_MIN = 0.3; // Recovery threshold

// Adaptive threshold scaling
const ADAPTIVE_THRESHOLD_PERCENTAGE = 0.005; // 0.5% of baseline heap per minute

/**
 * Calculate adaptive heap growth threshold
 * Scales with baseline heap size: small agents leak slower than large ones
 * Formula: max(1 MB/min, baselineHeap * 0.5% per min)
 */
function getAdaptiveHeapThreshold(recovering: boolean = false): number {
	const baseThreshold = recovering ? HEAP_GROWTH_RATE_RECOVERY_MB_PER_MIN : HEAP_GROWTH_RATE_MB_PER_MIN;
	const baselineHeapMB = baselineHeap / (1024 * 1024);
	const adaptiveThreshold = baselineHeapMB * ADAPTIVE_THRESHOLD_PERCENTAGE;
	return Math.max(baseThreshold, adaptiveThreshold);
}

/**
 * Calculate adaptive external memory growth threshold
 * Scales with baseline external memory
 */
function getAdaptiveExternalThreshold(recovering: boolean = false): number {
	const baseThreshold = recovering ? EXTERNAL_GROWTH_RATE_RECOVERY_MB_PER_MIN : EXTERNAL_GROWTH_RATE_MB_PER_MIN;
	const baselineExternalMB = baselineExternal / (1024 * 1024);
	const adaptiveThreshold = baselineExternalMB * ADAPTIVE_THRESHOLD_PERCENTAGE;
	return Math.max(baseThreshold, adaptiveThreshold);
}

/**
 * Calculate adaptive survivor growth threshold
 * Uses heap baseline since survivors are V8 heap objects
 */
function getAdaptiveSurvivorThreshold(): number {
	const baseThreshold = 0.3; // MB/min base threshold
	const baselineHeapMB = baselineHeap / (1024 * 1024);
	const adaptiveThreshold = baselineHeapMB * ADAPTIVE_THRESHOLD_PERCENTAGE;
	return Math.max(baseThreshold, adaptiveThreshold);
}

/**
 * Calculate adaptive survivor monotonic tolerance
 * Small heaps: 3% (stricter - less noise)
 * Large heaps: 7% (more lenient - more measurement variance)
 */
function getSurvivorMonotonicTolerance(): number {
	const baselineHeapMB = baselineHeap / (1024 * 1024);
	
	// Small heaps (< 100 MB): 3% tolerance
	if (baselineHeapMB < 100) {
		return 0.97; // 3% dip allowed
	}
	
	// Large heaps (> 200 MB): 7% tolerance
	if (baselineHeapMB > 200) {
		return 0.93; // 7% dip allowed
	}
	
	// Medium heaps: 5% tolerance (default)
	return 0.95;
}

/**
 * Calculate heap growth trend (MB per minute) using linear regression
 * Returns slope of best-fit line through all samples
 * 
 * Why regression instead of first-last comparison:
 * - Spike + plateau: first=50, last=100 → looks like leak ❌
 * - Steady growth: first=50, last=75 → actual leak ✅
 * - Regression: fits line through ALL points, ignores outliers
 */
function calculateHeapGrowthRate(): number | null {
	// Require minimum 10 samples (5 minutes at 30s intervals) to avoid false positives
	// - 5 samples (2.5 min) = too noisy, startup variance triggers false alerts
	// - 10 samples (5 min) = stable baseline, reliable trend detection
	if (heapSamples.length < 10) return null;
	
	// Also require minimum time window (5 minutes)
	const timeWindowMs = Date.now() - heapSamples[0].timestamp;
	if (timeWindowMs < 5 * 60 * 1000) return null;
	
	// Linear regression: y = mx + b
	// where y = heapUsed (MB), x = time (minutes)
	const n = heapSamples.length;
	let sumX = 0;
	let sumY = 0;
	let sumXY = 0;
	let sumX2 = 0;
	
	// Use first sample as time origin
	const t0 = heapSamples[0].timestamp;
	
	for (const sample of heapSamples) {
		const x = (sample.timestamp - t0) / (60 * 1000); // minutes from start
		const y = sample.heapUsed / (1024 * 1024); // MB
		
		sumX += x;
		sumY += y;
		sumXY += x * y;
		sumX2 += x * x;
	}
	
	// Calculate slope m = (n*sumXY - sumX*sumY) / (n*sumX2 - sumX^2)
	const denominator = n * sumX2 - sumX * sumX;
	if (Math.abs(denominator) < 1e-10) return null; // Avoid division by zero
	
	const slope = (n * sumXY - sumX * sumY) / denominator;
	
	// Slope is in MB per minute
	return slope;
}

/**
 * Calculate external memory growth trend (Buffers, crypto, native)
 * Same regression algorithm as heap, but for external allocations
 */
function calculateExternalGrowthRate(): number | null {
	// Same minimum requirements as heap growth rate
	if (heapSamples.length < 10) return null;
	
	const timeWindowMs = Date.now() - heapSamples[0].timestamp;
	if (timeWindowMs < 5 * 60 * 1000) return null;
	
	const n = heapSamples.length;
	let sumX = 0;
	let sumY = 0;
	let sumXY = 0;
	let sumX2 = 0;
	
	const t0 = heapSamples[0].timestamp;
	
	for (const sample of heapSamples) {
		const x = (sample.timestamp - t0) / (60 * 1000);
		const y = sample.external / (1024 * 1024); // MB
		
		sumX += x;
		sumY += y;
		sumXY += x * y;
		sumX2 += x * x;
	}
	
	const denominator = n * sumX2 - sumX * sumX;
	if (Math.abs(denominator) < 1e-10) return null;
	
	const slope = (n * sumXY - sumX * sumY) / denominator;
	return slope;
}

/**
 * Calculate malloced memory growth rate using linear regression
 * Returns MB per minute growth rate (GC allocation pressure signal)
 * Same regression algorithm as heap, but for malloced memory
 * 
 * ⚠️ DIAGNOSTIC USE ONLY - DO NOT use as hard threshold!
 * - malloced_memory is V8-internal, can jump due to allocator behavior
 * - Useful for context/investigation, NOT for leak detection triggers
 * - Use heap/external/survivor metrics for actual leak detection
 */
function calculateMallocedGrowthRate(): number | null {
	// Same minimum requirements as heap growth rate
	if (heapSamples.length < 10) return null;
	
	const timeWindowMs = Date.now() - heapSamples[0].timestamp;
	if (timeWindowMs < 5 * 60 * 1000) return null;
	
	const n = heapSamples.length;
	let sumX = 0;
	let sumY = 0;
	let sumXY = 0;
	let sumX2 = 0;
	
	const t0 = heapSamples[0].timestamp;
	
	for (const sample of heapSamples) {
		const x = (sample.timestamp - t0) / (60 * 1000);
		const y = sample.mallocedMemory / (1024 * 1024); // MB
		
		sumX += x;
		sumY += y;
		sumXY += x * y;
		sumX2 += x * x;
	}
	
	const denominator = n * sumX2 - sumX * sumX;
	if (Math.abs(denominator) < 1e-10) return null;
	
	const slope = (n * sumXY - sumX * sumY) / denominator;
	return slope;
}

/**
 * Calculate heap total growth rate using linear regression
 * Returns MB per minute growth rate
 * Indicates V8 expanding heap size (retention signal)
 */
function calculateHeapTotalGrowthRate(): number | null {
	// Same minimum requirements as heap growth rate
	if (heapSamples.length < 10) return null;
	
	const timeWindowMs = Date.now() - heapSamples[0].timestamp;
	if (timeWindowMs < 5 * 60 * 1000) return null;
	
	const n = heapSamples.length;
	let sumX = 0;
	let sumY = 0;
	let sumXY = 0;
	let sumX2 = 0;
	
	const t0 = heapSamples[0].timestamp;
	
	for (const sample of heapSamples) {
		const x = (sample.timestamp - t0) / (60 * 1000); // minutes
		const y = sample.totalHeapSize / (1024 * 1024); // MB
		
		sumX += x;
		sumY += y;
		sumXY += x * y;
		sumX2 += x * x;
	}
	
	const denominator = n * sumX2 - sumX * sumX;
	if (Math.abs(denominator) < 1e-10) return null;
	
	const slope = (n * sumXY - sumX * sumY) / denominator;
	return slope; // MB/min heapTotal growth
}

/**
 * Calculate survivor growth rate (long-lived objects that survive GC)
 * Tracks growth of minimum heap usage over time - the post-GC baseline
 * This is the key leak indicator: survivors should stay stable or shrink
 * 
 * Enhanced with retained growth heuristic:
 * - Tracks if heap floor is rising monotonically
 * - Avoids false positives under bursty workloads
 * - True leak: floor keeps rising even if GC runs
 */
function calculateSurvivorGrowthRate(): { rate: number; isMonotonic: boolean; retainedGrowth: number } | null {
	if (heapSamples.length < 5) return null;
	
	// Find minimum heap usage in each time window (approximates post-GC state)
	// Group samples into 2-minute windows and find min of each window
	const windowSize = 2 * 60 * 1000; // 2 minutes
	const windows: Array<{ timestamp: number; minHeap: number }> = [];
	
	const startTime = heapSamples[0].timestamp;
	const endTime = heapSamples[heapSamples.length - 1].timestamp;
	
	for (let t = startTime; t <= endTime; t += windowSize) {
		const windowSamples = heapSamples.filter(s => 
			s.timestamp >= t && s.timestamp < t + windowSize
		);
		
		if (windowSamples.length > 0) {
			const minHeap = Math.min(...windowSamples.map(s => s.heapUsed));
			windows.push({ timestamp: t + windowSize / 2, minHeap });
		}
	}
	
	if (windows.length < 2) return null;
	
	// Check if floor is rising monotonically (true leak signal)
	// Adaptive tolerance: 3% (small heaps), 5% (medium), 7% (large)
	const tolerance = getSurvivorMonotonicTolerance();
	let isMonotonic = true;
	for (let i = 1; i < windows.length; i++) {
		if (windows[i].minHeap < windows[i - 1].minHeap * tolerance) {
			isMonotonic = false;
			break;
		}
	}
	
	// Calculate retained growth: current heap - minimum in entire window
	const currentHeap = heapSamples[heapSamples.length - 1].heapUsed;
	const minHeapInWindow = Math.min(...windows.map(w => w.minHeap));
	const retainedGrowth = (currentHeap - minHeapInWindow) / (1024 * 1024); // MB
	
	// Linear regression on minimum heap values (survivor baseline)
	const n = windows.length;
	let sumX = 0;
	let sumY = 0;
	let sumXY = 0;
	let sumX2 = 0;
	
	const t0 = windows[0].timestamp;
	
	for (const window of windows) {
		const x = (window.timestamp - t0) / (60 * 1000); // minutes
		const y = window.minHeap / (1024 * 1024); // MB
		
		sumX += x;
		sumY += y;
		sumXY += x * y;
		sumX2 += x * x;
	}
	
	const denominator = n * sumX2 - sumX * sumX;
	if (Math.abs(denominator) < 1e-10) return null;
	
	const slope = (n * sumXY - sumX * sumY) / denominator;
	
	return {
		rate: slope, // MB/min survivor growth
		isMonotonic, // true if floor rising consistently
		retainedGrowth // MB retained above minimum
	};
}

/**
 * Update survivor baseline (minimum heap usage)
 * Should be called periodically to track post-GC baseline
 * 
 * NOTE: This is for DIAGNOSTICS/LOGGING only (provides simple minimum tracking).
 * Actual leak detection uses calculateSurvivorGrowthRate() which is stronger:
 * - Windowed regression (2-min buckets)
 * - Monotonic floor check (5% tolerance)
 * - Retained growth calculation
 * 
 * This simple tracker remains for visibility in logs and debugging.
 */
function updateSurvivorBaseline(currentHeap: number): void {
	const now = Date.now();
	
	// Initialize on first call
	if (survivorBaseline === 0) {
		survivorBaseline = currentHeap;
		lastSurvivorUpdate = now;
		return;
	}
	
	// Update if current heap is lower (likely post-GC)
	if (currentHeap < survivorBaseline) {
		survivorBaseline = currentHeap;
		lastSurvivorUpdate = now;
	}
	
	// Periodic update: if heap has been consistently lower, update baseline
	if (now - lastSurvivorUpdate > SURVIVOR_UPDATE_INTERVAL_MS) {
		// Find minimum heap in recent samples
		const recentMin = Math.min(...heapSamples.slice(-10).map(s => s.heapUsed));
		if (recentMin < survivorBaseline * 1.05) { // Within 5% tolerance
			survivorBaseline = recentMin;
		}
		lastSurvivorUpdate = now;
	}
}

/**
 * Check if heap has been stable (no significant growth) recently
 * Netflix pattern: Requires BOTH low variance AND near-zero slope
 */
function isHeapStable(): boolean {
	if (heapSamples.length < 5) return false;
	
	// Check last 5 minutes of samples
	const recentSamples = heapSamples.filter(s => 
		Date.now() - s.timestamp < HEAP_STABILIZATION_TIME_MS
	);
	
	if (recentSamples.length < 2) return false;
	
	// Calculate variance
	const heapValues = recentSamples.map(s => s.heapUsed);
	const avg = heapValues.reduce((a, b) => a + b, 0) / heapValues.length;
	const variance = heapValues.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / heapValues.length;
	const stdDev = Math.sqrt(variance);
	
	// Stable if std deviation < 2MB
	const stableMB = 2 * 1024 * 1024;
	if (stdDev >= stableMB) return false;
	
	// CRITICAL: Also require near-zero slope (Netflix pattern)
	// Low variance alone can mask slow linear leaks (0.3 MB/min = consistent = low variance ❌)
	const growthRate = calculateHeapGrowthRate();
	if (growthRate !== null && growthRate > 0.1) return false;
	
	return true;
}

/**
 * Detect memory leak pattern using correlation matrix analysis
 * Classifies leaks based on which metrics are growing together
 * 
 * Correlation Matrix:
 * Heap  External  RSS   Likely Cause
 * ↑     ↑         ↑     Buffer / crypto / native leak
 * →     ↑         →     External cache leak (Buffers not freed)
 * ↑     →         →     JS object retention (heap objects)
 * ↑     →         ↑     GC pressure (heap growing, allocator struggling)
 * ↑     ↑         →     Mixed leak (heap + external, RSS stable via jemalloc)
 * →     ↑         ↑     External leak (native allocations)
 * →     →         ↑     RSS leak (OS page retention)
 * 
 * Heap Utilization Patterns:
 * heapUsed ↑, heapTotal → (high utilization) → GC pressure (can't reclaim)
 * heapTotal ↑ steadily → V8 expanding heap (retention detected)
 * 
 * Patterns:
 * - Survivor leak: Long-lived objects surviving GC (most accurate)
 * - Buffer/crypto/native leak: All metrics growing
 * - External cache leak: Only external growing
 * - JS object retention: Heap growing, external stable
 * - GC pressure: Heap + RSS growing, external stable
 */
function detectLeakPattern(
    currentHeap: number,
    currentRSS: number,
    currentExternal: number
): {
    pattern:
        | 'survivor-leak'
        | 'buffer-crypto-native-leak'
        | 'external-cache-leak'
        | 'js-object-retention'
        | 'gc-pressure'
        | 'mixed-leak-jemalloc'
        | 'external-leak'
        | 'rss-leak'
        | 'stable'
        | 'unknown';
    description: string;
} {
    // --- Calculate growth trends ---
    const heapGrowthRate = calculateHeapGrowthRate(); // MB/min
    const externalGrowthRate = calculateExternalGrowthRate(); // MB/min
    const survivorGrowth = calculateSurvivorGrowthRate(); // { rate, retainedGrowth, isMonotonic }

    // --- Define adaptive thresholds ---
    const HEAP_THRESHOLD = getAdaptiveHeapThreshold(false);
    const EXTERNAL_THRESHOLD = getAdaptiveExternalThreshold(false);
    const SURVIVOR_THRESHOLD = getAdaptiveSurvivorThreshold();
    const RSS_GROWTH_THRESHOLD = 5 * 1024 * 1024; // 5MB absolute growth

    // --- Determine metric states ---
    const heapGrowing = heapGrowthRate !== null && heapGrowthRate > HEAP_THRESHOLD;
    const externalGrowing = externalGrowthRate !== null && externalGrowthRate > EXTERNAL_THRESHOLD;
    const survivorGrowing =
        survivorGrowth !== null &&
        survivorGrowth.rate > SURVIVOR_THRESHOLD &&
        survivorGrowth.isMonotonic;
    const rssGrowing = (currentRSS - baselineRSS) > RSS_GROWTH_THRESHOLD;

    // --- Priority 1: Survivor leak ---
    if (survivorGrowing) {
        return {
            pattern: 'survivor-leak',
            description: `Long-lived objects growing at ${survivorGrowth.rate.toFixed(
                2
            )} MB/min - floor rising monotonically, retained: ${survivorGrowth.retainedGrowth.toFixed(
                1
            )} MB (real leak)`
        };
    }

    // --- Priority 2: Other correlation-based patterns ---
    if (heapGrowing && externalGrowing && rssGrowing) {
        return {
            pattern: 'buffer-crypto-native-leak',
            description: `Buffer/crypto/native leak - heap: ${heapGrowthRate?.toFixed(
                2
            )} MB/min, external: ${externalGrowthRate?.toFixed(2)} MB/min, RSS growing`
        };
    }

    if (!heapGrowing && externalGrowing && !rssGrowing) {
        return {
            pattern: 'external-cache-leak',
            description: `External cache leak - external: ${externalGrowthRate?.toFixed(
                2
            )} MB/min, heap stable`
        };
    }

    if (heapGrowing && !externalGrowing && !rssGrowing) {
        return {
            pattern: 'js-object-retention',
            description: `JS object retention - heap: ${heapGrowthRate?.toFixed(2)} MB/min, external stable`
        };
    }

    if (heapGrowing && !externalGrowing && rssGrowing) {
        return {
            pattern: 'gc-pressure',
            description: `GC pressure - heap: ${heapGrowthRate?.toFixed(
                2
            )} MB/min, RSS growing, external stable`
        };
    }

    if (heapGrowing && externalGrowing && !rssGrowing) {
        return {
            pattern: 'mixed-leak-jemalloc',
            description: `Mixed leak - heap: ${heapGrowthRate?.toFixed(
                2
            )} MB/min, external: ${externalGrowthRate?.toFixed(
                2
            )} MB/min, RSS stable (jemalloc reusing arenas)`
        };
    }

    if (!heapGrowing && externalGrowing && rssGrowing) {
        return {
            pattern: 'external-leak',
            description: `External leak - external: ${externalGrowthRate?.toFixed(
                2
            )} MB/min, heap stable`
        };
    }

    if (!heapGrowing && !externalGrowing && rssGrowing) {
        return {
            pattern: 'rss-leak',
            description: `RSS leak - heap/external stable but RSS growing`
        };
    }

    // --- Priority 3: Heap stable ---
    const heapStable = isHeapStable(); // Make sure this considers survivor space too
    if (heapStable) {
        return {
            pattern: 'stable',
            description: 'Memory stable - no leak detected'
        };
    }

    // --- Fallback ---
    return {
        pattern: 'unknown',
        description: 'Memory pattern unclear - insufficient data or transient spike'
    };
}


/**
 * Update sliding baseline when heap is stable for extended period
 * Allows natural heap growth (allocator caching) without triggering alerts
 * Also updates RSS baseline for consistency
 */
function updateBaselineIfStable(currentHeap: number, currentRSS: number): void {
	const now = Date.now();
	
	// Don't update baseline too frequently (30 min minimum)
	if (now - lastBaselineUpdate < BASELINE_UPDATE_INTERVAL_MS) {
		return;
	}
	
	// Only update if heap is stable
	if (!isHeapStable()) {
		return;
	}
	
	// Calculate average heap over stability window
	const recentSamples = heapSamples.filter(s => 
		now - s.timestamp < HEAP_STABILIZATION_TIME_MS
	);
	
	if (recentSamples.length < 5) return;
	
	const avgHeap = recentSamples.reduce((sum, s) => sum + s.heapUsed, 0) / recentSamples.length;
	
	// ============================================================================
	// CRITICAL: Prevent baseline creep (Netflix pattern)
	// ============================================================================
	// A slow leak (0.3 MB/min) can appear "stable" (consistent growth, low variance)
	// but still be growing. Without these safeguards, baseline ratchets upward forever.
	//
	// Requirements for baseline update:
	// 1. Max drift cap: <5% growth from current baseline (prevents large jumps)
	// 2. Zero/negative slope: heap not actively growing (prevents masking leaks)
	// 3. Very low growth rate: <0.1 MB/min (prevents slow leak masking)
	// ============================================================================
	
	// Only update baseline upward (prevent masking sudden drops that recover)
	if (avgHeap > baselineHeap) {
		// 1. Check max drift cap (5% growth limit)
		const driftPercentage = ((avgHeap - baselineHeap) / baselineHeap) * 100;
		if (driftPercentage > 5) {
			logger?.warnSync('Baseline update rejected - drift exceeds 5% cap', {
				component: LogComponents.metrics,
				currentBaselineMB: bytesToMB(baselineHeap),
				proposedBaselineMB: bytesToMB(avgHeap),
				driftPercentage: driftPercentage.toFixed(2),
				reason: 'Possible slow leak - baseline would mask growth'
			});
			return;
		}
		
		// 2. Check heap growth rate (must be near-zero or negative)
		const heapGrowthRate = calculateHeapGrowthRate();
		const MAX_GROWTH_FOR_BASELINE_UPDATE = 0.1; // MB/min
		
		if (heapGrowthRate !== null && heapGrowthRate > MAX_GROWTH_FOR_BASELINE_UPDATE) {
			logger?.warnSync('Baseline update rejected - heap still growing', {
				component: LogComponents.metrics,
				currentBaselineMB: bytesToMB(baselineHeap),
				proposedBaselineMB: bytesToMB(avgHeap),
				heapGrowthRateMBperMin: heapGrowthRate.toFixed(2),
				maxAllowedGrowthRate: MAX_GROWTH_FOR_BASELINE_UPDATE,
				reason: 'Non-zero slope detected - not truly stable'
			});
			return;
		}
		
		// All safeguards passed - safe to update baseline
		const oldBaselineHeap = baselineHeap;
		const oldBaselineRSS = baselineRSS;
		const oldBaselineExternal = baselineExternal;
		
		baselineHeap = avgHeap;
		baselineRSS = currentRSS; // Update RSS baseline alongside heap
		
		// ============================================================================
		// CRITICAL: Update external baseline independently (Netflix pattern)
		// ============================================================================
		// External memory (Buffers, crypto, native) can stabilize at different times
		// than heap. If never updated, external growth accumulates forever, causing
		// false positives on long-running agents with Buffer/external workloads.
		//
		// Update external baseline if:
		// - External growth rate is very low (<0.05 MB/min = nearly flat)
		// - Prevents false positives on stable external memory usage
		// ============================================================================
		const mem = memoryUsage();
		const externalGrowthRate = calculateExternalGrowthRate();
		let externalBaselineUpdated = false;
		
		if (externalGrowthRate !== null && externalGrowthRate < 0.05) {
			baselineExternal = mem.external;
			externalBaselineUpdated = true;
		}
		
		lastBaselineUpdate = now;
		
		logger?.infoSync('Baseline updated - heap stabilized at new level', {
			component: LogComponents.metrics,
			oldBaselineHeapMB: bytesToMB(oldBaselineHeap),
			newBaselineHeapMB: bytesToMB(baselineHeap),
			oldBaselineRSSMB: bytesToMB(oldBaselineRSS),
			newBaselineRSSMB: bytesToMB(baselineRSS),
			oldBaselineExternalMB: bytesToMB(oldBaselineExternal),
			newBaselineExternalMB: bytesToMB(baselineExternal),
			externalBaselineUpdated,
			driftPercentage: driftPercentage.toFixed(2),
			heapGrowthRateMBperMin: heapGrowthRate?.toFixed(2) || 'null',
			externalGrowthRateMBperMin: externalGrowthRate?.toFixed(2) || 'null',
			uptimeHours: (processUptime() / 3600).toFixed(1)
		});
	}
}

/**
 * Returns false if agent process has sustained heap growth (actual leak),
 * otherwise returns true. Ignores RSS fluctuations from allocator behavior.
 * Uses sliding baseline to avoid false positives on long-running processes.
 */
export async function healthcheck(
	thresholdBytes: number = 15 * 1024 * 1024, // Legacy RSS threshold (kept for compatibility)
): Promise<boolean> {
	const mem = memoryUsage();
	const currentRSS = mem.rss;
	const currentHeap = mem.heapUsed;
	
	// Wait for process stabilization (increased from 20s to 60s)
	if (processUptime() < 60) {
		return true;
	}

	// Initialize baseline heap and external
	if (initialHeap === 0) {
		const heapStats = getHeapStatistics();
		initialHeap = currentHeap;
		baselineHeap = currentHeap;
		initialExternal = mem.external;
		baselineExternal = mem.external;
		initialMalloced = heapStats.malloced_memory;
		baselineMalloced = heapStats.malloced_memory;
		initialMemory = currentRSS; // Legacy
		baselineRSS = currentRSS; // Sliding RSS baseline
		lastBaselineUpdate = Date.now();
		lastMemoryCheck = currentRSS; // Legacy
		
		heapSamples.push({ 
			timestamp: Date.now(), 
			heapUsed: currentHeap, 
			external: mem.external,
			totalHeapSize: heapStats.total_heap_size,
			heapSizeLimit: heapStats.heap_size_limit,
			mallocedMemory: heapStats.malloced_memory
		});
		
		logger?.infoSync('Memory baseline established (heap-based, sliding)', {
			component: LogComponents.metrics,
			heapMB: bytesToMB(currentHeap),
			rssMB: bytesToMB(currentRSS),
			uptimeSeconds: processUptime()
		});
		return true;
	}

	// Add current heap and external sample with GC signals
	const heapStats = getHeapStatistics();
	heapSamples.push({ 
		timestamp: Date.now(), 
		heapUsed: currentHeap, 
		external: mem.external,
		totalHeapSize: heapStats.total_heap_size,
		heapSizeLimit: heapStats.heap_size_limit,
		mallocedMemory: heapStats.malloced_memory
	});
	
	// Update survivor baseline (minimum heap - approximates post-GC state)
	updateSurvivorBaseline(currentHeap);
	
	// Keep only recent samples (10-minute window)
	const cutoffTime = Date.now() - SAMPLE_WINDOW_MS;
	heapSamples = heapSamples.filter(s => s.timestamp > cutoffTime);
	
	// Limit to MAX_SAMPLES
	if (heapSamples.length > MAX_SAMPLES) {
		heapSamples = heapSamples.slice(-MAX_SAMPLES);
	}
	
	// Update sliding baseline if heap is stable
	updateBaselineIfStable(currentHeap, currentRSS);
	
	// Calculate heap and external growth rates
	const heapGrowthRate = calculateHeapGrowthRate();
	const externalGrowthRate = calculateExternalGrowthRate();
	const heapStable = isHeapStable();
	
	// Apply adaptive thresholds with hysteresis
	// Small agents: use base threshold (1 MB/min)
	// Large agents: scale to baseline (0.5% of heap per minute)
	const heapThreshold = getAdaptiveHeapThreshold(memoryThresholdBreached);
	const externalThreshold = getAdaptiveExternalThreshold(memoryThresholdBreached);
	
	// Pass if heap is stable (normal allocator behavior)
	if (heapStable) {
		logger?.debugSync('Heap stable - healthy', {
			component: LogComponents.metrics,
			heapMB: bytesToMB(currentHeap),
			baselineMB: bytesToMB(baselineHeap),
			rssMB: bytesToMB(currentRSS),
			externalMB: bytesToMB(mem.external),
			samples: heapSamples.length
		});
		return true;
	}
	
	// ============================================================================
	// CRITICAL: Check survivor leak FIRST (strongest signal)
	// ============================================================================
	// Survivor leak = long-lived objects surviving GC, monotonic floor rising
	// This is the most accurate leak indicator - catches leaks even with shallow slope
	// 
	// Scenario without this check:
	// - Survivor floor rising at 0.4 MB/min (real leak!)
	// - Overall heap slope only 0.3 MB/min (below threshold)
	// - Healthcheck passes ❌ but leak exists
	// 
	// With this check:
	// - Survivor monotonic + rate > threshold → FAIL ✅
	// ============================================================================
	const survivorGrowth = calculateSurvivorGrowthRate();
	const survivorThreshold = getAdaptiveSurvivorThreshold();
	
	if (
		survivorGrowth &&
		survivorGrowth.isMonotonic &&
		survivorGrowth.rate > survivorThreshold
	) {
		// Survivor leak detected - most reliable signal
		// Don't log here - caller decides whether to alert
		return false;
	}
	
	// Fail if sustained heap growth detected (compared to sliding baseline)
	if (heapGrowthRate !== null && heapGrowthRate > heapThreshold) {
		// Don't log here - caller decides whether to alert
		// (prevents log spam from repeated healthcheck calls)
		return false;
	}
	
	// Fail if sustained external memory growth detected (Buffers, crypto, native)
	if (externalGrowthRate !== null && externalGrowthRate > externalThreshold) {
		// Don't log here - caller decides whether to alert
		return false;
	}
	
	// Pass - no sustained growth detected
	return true;
}

/**
 * Get detailed memory diagnostics for leak investigation
 * Use when healthcheck fails to get context for logging/alerting
 */
export function getMemoryDiagnostics() {
	const mem = memoryUsage();
	const heapStats = getHeapStatistics();
	const currentHeap = mem.heapUsed;
	const currentRSS = mem.rss;
	const growthRate = calculateHeapGrowthRate();
	const mallocedGrowthRate = calculateMallocedGrowthRate();
	const heapTotalGrowthRate = calculateHeapTotalGrowthRate();
	const survivorGrowth = calculateSurvivorGrowthRate();
	const heapGrowthFromBaseline = currentHeap - baselineHeap;
	const heapGrowthFromInitial = currentHeap - initialHeap;
	const rssGrowthFromBaseline = currentRSS - baselineRSS;
	const rssGrowthFromInitial = currentRSS - initialMemory;
	const currentExternal = mem.external;
	const externalGrowthFromBaseline = currentExternal - baselineExternal;
	const externalGrowthFromInitial = currentExternal - initialExternal;
	const leakPattern = detectLeakPattern(currentHeap, currentRSS, currentExternal);
	const externalGrowthRate = calculateExternalGrowthRate();
	
	return {
		currentHeapMB: bytesToMB(currentHeap),
		baselineHeapMB: bytesToMB(baselineHeap),
		initialHeapMB: bytesToMB(initialHeap),
		growthFromBaselineMB: (heapGrowthFromBaseline / (1024 * 1024)).toFixed(2),
		growthFromInitialMB: (heapGrowthFromInitial / (1024 * 1024)).toFixed(2),
		// RSS metrics (sliding baseline for consistency)
		currentRSSMB: bytesToMB(currentRSS),
		baselineRSSMB: bytesToMB(baselineRSS),
		initialRSSMB: bytesToMB(initialMemory),
		rssGrowthFromBaselineMB: (rssGrowthFromBaseline / (1024 * 1024)).toFixed(2),
		rssGrowthFromInitialMB: (rssGrowthFromInitial / (1024 * 1024)).toFixed(2),
		// External memory metrics (Buffers, crypto, native)
		currentExternalMB: bytesToMB(currentExternal),
		baselineExternalMB: bytesToMB(baselineExternal),
		initialExternalMB: bytesToMB(initialExternal),
		externalGrowthFromBaselineMB: (externalGrowthFromBaseline / (1024 * 1024)).toFixed(2),
		externalGrowthFromInitialMB: (externalGrowthFromInitial / (1024 * 1024)).toFixed(2),
		// Growth rates
		heapGrowthRateMBperMin: growthRate?.toFixed(2) || null,
		externalGrowthRateMBperMin: externalGrowthRate?.toFixed(2) || null,
		// Heap utilization (heapUsed vs heapTotal)
		heapUtilization: ((heapStats.used_heap_size / heapStats.total_heap_size) * 100).toFixed(1) + '%',
		heapTotalMB: bytesToMB(heapStats.total_heap_size),
		heapTotalGrowthRateMBperMin: heapTotalGrowthRate?.toFixed(2) || 'null',
		// Thresholds (adaptive - scale with baseline heap)
		heapThresholdMBperMin: getAdaptiveHeapThreshold(false).toFixed(2),
		heapThresholdBase: HEAP_GROWTH_RATE_MB_PER_MIN,
		heapThresholdAdaptive: (baselineHeap / (1024 * 1024) * ADAPTIVE_THRESHOLD_PERCENTAGE).toFixed(2),
		heapRecoveryThresholdMBperMin: getAdaptiveHeapThreshold(true).toFixed(2),
		externalThresholdMBperMin: getAdaptiveExternalThreshold(false).toFixed(2),
		externalRecoveryThresholdMBperMin: getAdaptiveExternalThreshold(true).toFixed(2),
		survivorThresholdMBperMin: getAdaptiveSurvivorThreshold().toFixed(2),
		// GC signals (allocation pressure)
		totalHeapSizeMB: bytesToMB(heapStats.total_heap_size),
		heapSizeLimitMB: bytesToMB(heapStats.heap_size_limit),
		heapFragmentationMB: bytesToMB(heapStats.total_heap_size - heapStats.used_heap_size),
		heapLimitPressure: ((heapStats.used_heap_size / heapStats.heap_size_limit) * 100).toFixed(1) + '%',
		mallocedMemoryMB: bytesToMB(heapStats.malloced_memory),
		mallocedGrowthRateMBperMin: mallocedGrowthRate?.toFixed(2) || 'null',
		// Survivor tracking (long-lived objects that survive GC)
		survivorBaselineMB: bytesToMB(survivorBaseline),
		survivorGrowthRateMBperMin: survivorGrowth?.rate.toFixed(2) || 'null',
		survivorFloorMonotonic: survivorGrowth?.isMonotonic ?? false,
		survivorRetainedMB: survivorGrowth?.retainedGrowth.toFixed(1) || 'null',
		currentlyBreached: memoryThresholdBreached,
		// Leak pattern analysis
		leakPattern: leakPattern.pattern,
		leakDescription: leakPattern.description,
		uptimeSeconds: processUptime(),
		samples: heapSamples.length,
		heapStable: isHeapStable()
	};
}

/**
 * Get current memory statistics (both heap and RSS)
 */
export function getMemoryStats() {
	const mem = memoryUsage();
	const current = mem.rss;
	const heap = mem.heapUsed;
	const heapTotal = mem.heapTotal;
	const external = mem.external;
	
	const growth = initialMemory > 0 ? current - initialMemory : 0;
	const heapGrowth = initialHeap > 0 ? heap - initialHeap : 0;
	const growthRate = calculateHeapGrowthRate();
	const stable = isHeapStable();
	
	return {
		// Legacy RSS (less reliable)
		initial: initialMemory,
		current,
		growth,
		initialMB: bytesToMB(initialMemory),
		currentMB: bytesToMB(current),
		growthMB: bytesToMB(growth),
		
		// Heap stats (more reliable for leak detection)
		heapUsed: heap,
		heapTotal: heapTotal,
		heapExternal: external,
		heapUsedMB: bytesToMB(heap),
		heapTotalMB: bytesToMB(heapTotal),
		heapExternalMB: bytesToMB(external),
		heapGrowthMB: bytesToMB(heapGrowth),
		heapGrowthRateMBperMin: growthRate?.toFixed(2) || null,
		heapStable: stable,
		
		// Metadata
		uptime: processUptime(),
		samples: heapSamples.length,
	};
}

/**
 * MEMORY LEAK SIMULATION
 * =======================
 * Simulates various memory leak patterns for testing monitoring and alerting.
 * 
 * IMPORTANT: Buffer.alloc() creates NATIVE memory leaks (RSS ↑), not V8 heap leaks.
 * - Buffer memory allocated outside V8 heap (external/native)
 * - RSS increases, but heap_used may not
 * - Does NOT model typical JS object leaks (closures, event listeners, caches)
 * - Useful for testing RSS-based monitoring, less so for heap-based
 * 
 * For heap-based leak testing, use LEAK_ALLOCATION=heap to create true JS object leaks.
 * 
 * Controlled via environment variables:
 * 
 * SIMULATE_MEMORY_LEAK=true - Enable simulation
 * LEAK_TYPE=gradual|sudden|cyclic - Leak pattern (default: gradual)
 * LEAK_ALLOCATION=buffer|heap - Memory type (default: buffer for legacy compatibility)
 * LEAK_RATE_MB=1 - MB to leak per interval (default: 1)
 * LEAK_INTERVAL_MS=5000 - Interval between leaks (default: 5000)
 * LEAK_MAX_MB=50 - Maximum MB to leak before stopping (default: 50)
 */

interface LeakSimulationConfig {
	enabled: boolean;
	type: 'gradual' | 'sudden' | 'cyclic';
	allocation: 'buffer' | 'heap';
	rateMB: number;
	intervalMs: number;
	maxMB: number;
}

function getLeakConfig(): LeakSimulationConfig {
	return {
		enabled: process.env.SIMULATE_MEMORY_LEAK === 'true',
		type: (process.env.LEAK_TYPE as any) || 'gradual',
		allocation: (process.env.LEAK_ALLOCATION as any) || 'buffer', // buffer for legacy, heap for V8 testing
		rateMB: parseInt(process.env.LEAK_RATE_MB || '1', 10),
		intervalMs: parseInt(process.env.LEAK_INTERVAL_MS || '5000', 10),
		maxMB: parseInt(process.env.LEAK_MAX_MB || '50', 10),
	};
}

/**
 * Start memory leak simulation
 */
export function startMemoryLeakSimulation(): void {
	const config = getLeakConfig();
	
	if (!config.enabled) {
		return;
	}

	// Don't start if already running
	if (simulationInterval) {
		logger?.warnSync('Memory leak simulation already running', {
			component: LogComponents.metrics
		});
		return;
	}

	logger?.warnSync('STARTING MEMORY LEAK SIMULATION - FOR TESTING ONLY', {
		component: LogComponents.metrics,
		type: config.type,
		allocation: config.allocation,
		rateMB: config.rateMB,
		intervalMs: config.intervalMs,
		maxMB: config.maxMB,
		warning: config.allocation === 'buffer' ? 'Native memory (RSS), not V8 heap' : 'V8 heap objects'
	});

	let totalLeakedMB = 0;
	let cycleDirection = 1; // 1 for leak, -1 for release

	simulationInterval = setInterval(() => {
		const stats = getMemoryStats();
		
		// Stop if max leak reached (except for cyclic)
		if (config.type !== 'cyclic' && totalLeakedMB >= config.maxMB) {
			logger?.warnSync('Memory leak simulation reached max - stopping', {
				component: LogComponents.metrics,
				totalLeakedMB,
				currentMemoryMB: stats.currentMB
			});
			stopMemoryLeakSimulation();
			return;
		}

		switch (config.type) {
			case 'gradual':
				// Slowly leak memory at constant rate
				leakMemory(config.rateMB, config.allocation);
				totalLeakedMB += config.rateMB;
				logger?.debugSync('Gradual leak simulation', {
					component: LogComponents.metrics,
					leakedThisCycleMB: config.rateMB,
					totalLeakedMB,
					currentMemoryMB: stats.currentMB
				});
				break;

			case 'sudden':
				// Leak large amount immediately
				const suddenAmount = config.maxMB;
				leakMemory(suddenAmount, config.allocation);
				totalLeakedMB += suddenAmount;
				logger?.warnSync('Sudden leak simulation', {
					component: LogComponents.metrics,
					leakedMB: suddenAmount,
					currentMemoryMB: stats.currentMB
				});
				stopMemoryLeakSimulation();
				break;

			case 'cyclic':
				// Leak then release in cycles
				if (cycleDirection === 1) {
					leakMemory(config.rateMB, config.allocation);
					totalLeakedMB += config.rateMB;
					if (totalLeakedMB >= config.maxMB / 2) {
						cycleDirection = -1; // Start releasing
					}
				} else {
					releaseMemory(config.rateMB, config.allocation);
					totalLeakedMB -= config.rateMB;
					if (totalLeakedMB <= 0) {
						totalLeakedMB = 0;
						cycleDirection = 1; // Start leaking again
					}
				}
				logger?.debugSync('Cyclic leak simulation', {
					component: LogComponents.metrics,
					direction: cycleDirection === 1 ? 'leaking' : 'releasing',
					totalLeakedMB,
					currentMemoryMB: stats.currentMB
				});
				break;
		}
	}, config.intervalMs);
}

/**
 * Stop memory leak simulation
 */
export function stopMemoryLeakSimulation(): void {
	if (simulationInterval) {
		clearInterval(simulationInterval);
		simulationInterval = undefined;
		
		// Clear leaked objects to free memory
		const leakedCount = leakedObjects.length;
		leakedObjects = [];
		
		logger?.infoSync('Stopped memory leak simulation', {
			component: LogComponents.metrics,
			clearedObjects: leakedCount
		});
	}
}

/**
 * Leak memory by creating objects that won't be garbage collected
 * 
 * @param megabytes - Amount of memory to leak
 * @param allocation - 'buffer' (native/RSS) or 'heap' (V8 heap)
 */
function leakMemory(megabytes: number, allocation: 'buffer' | 'heap' = 'buffer'): void {
	const bytesToLeak = megabytes * 1024 * 1024;
	const objectSize = 1024; // 1KB per object
	const objectCount = Math.floor(bytesToLeak / objectSize);

	for (let i = 0; i < objectCount; i++) {
		if (allocation === 'buffer') {
			// Native memory leak (RSS ↑, heap unchanged)
			// Buffer.alloc() allocates outside V8 heap
			leakedObjects.push({
				data: Buffer.alloc(objectSize),
				timestamp: Date.now(),
				index: leakedObjects.length,
				self: null as any,
			});
		} else {
			// V8 heap leak (heap ↑, RSS follows)
			// Plain JS objects/arrays allocated in V8 heap
			leakedObjects.push({
				data: new Array(objectSize / 8).fill({ leaked: true }), // ~1KB of heap objects
				timestamp: Date.now(),
				index: leakedObjects.length,
				self: null as any,
			});
		}
		// Create circular reference to prevent GC
		leakedObjects[leakedObjects.length - 1].self = leakedObjects[leakedObjects.length - 1];
	}
}

/**
 * Release memory by removing leaked objects
 * (allocation type doesn't matter for release, both stored in same array)
 */
function releaseMemory(megabytes: number, allocation: 'buffer' | 'heap' = 'buffer'): void {
	const bytesToRelease = megabytes * 1024 * 1024;
	const objectSize = 1024;
	const objectCount = Math.floor(bytesToRelease / objectSize);

	// Remove from end of array
	const toRemove = Math.min(objectCount, leakedObjects.length);
	leakedObjects.splice(-toRemove, toRemove);
	
	// Suggest garbage collection (not guaranteed)
	if (global.gc) {
		global.gc();
	}
}

/**
 * Get simulation status
 */
export function getSimulationStatus() {
	const config = getLeakConfig();
	return {
		enabled: config.enabled,
		running: simulationInterval !== undefined,
		config,
		leakedObjectsCount: leakedObjects.length,
		estimatedLeakedMB: (leakedObjects.length * 1024) / (1024 * 1024),
	};
}
