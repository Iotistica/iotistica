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

import { memoryUsage } from 'process';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

// Heap tracking (more accurate than RSS)
let initialHeap: number = 0;
let baselineHeap: number = 0; // Sliding baseline (updates when stable)
let lastBaselineUpdate: number = 0;
let heapSamples: Array<{ timestamp: number; heapUsed: number }> = [];
const MAX_SAMPLES = 20; // 10 minutes of history at 30s intervals
const SAMPLE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const BASELINE_UPDATE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes minimum between baseline updates

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

	logger?.infoSync('Starting active memory monitoring', {
		component: LogComponents.metrics,
		intervalMs,
		thresholdMB: bytesToMB(thresholdBytes)
	});

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
				const growthRate = calculateHeapGrowthRate();
				const heapGrowthFromBaseline = currentHeap - baselineHeap;
				const heapGrowthFromInitial = currentHeap - initialHeap;
				const rssGrowthFromBaseline = currentRSS - baselineRSS;
				const rssGrowthFromInitial = currentRSS - initialMemory;
				const leakPattern = detectLeakPattern(currentHeap, currentRSS);
				
				logger?.errorSync('Sustained heap growth detected - likely memory leak', undefined, {
					component: LogComponents.metrics,
					currentHeapMB: bytesToMB(currentHeap),
					baselineHeapMB: bytesToMB(baselineHeap),
					initialHeapMB: bytesToMB(initialHeap),
					growthFromBaselineMB: (heapGrowthFromBaseline / (1024 * 1024)).toFixed(2),
					growthFromInitialMB: (heapGrowthFromInitial / (1024 * 1024)).toFixed(2),
					// RSS metrics (sliding baseline)
					currentRSSMB: bytesToMB(currentRSS),
					baselineRSSMB: bytesToMB(baselineRSS),
					rssGrowthFromBaselineMB: (rssGrowthFromBaseline / (1024 * 1024)).toFixed(2),
					rssGrowthFromInitialMB: (rssGrowthFromInitial / (1024 * 1024)).toFixed(2),
					growthRateMBperMin: growthRate?.toFixed(2) || 'null',
					thresholdMBperMin: HEAP_GROWTH_RATE_MB_PER_MIN,
					recoveryThresholdMBperMin: HEAP_GROWTH_RATE_RECOVERY_MB_PER_MIN,
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
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.metrics
				}
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
		memoryThresholdBreached = false;
		logger?.infoSync('Stopped active memory monitoring', {
			component: LogComponents.metrics
		});
	}
}

/**
 * Check if memory monitoring is running
 */
export function isMemoryMonitoringActive(): boolean {
	return monitoringInterval !== undefined;
}

/**
 * Check if restart is allowed based on cooldown and attempt limits
 * Prevents restart loops by enforcing cooldown period and max attempts
 */
export function canAttemptRestart(): { allowed: boolean; reason?: string } {
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
const HEAP_GROWTH_RATE_MB_PER_MIN = 1; // 1MB/min sustained growth = leak
const HEAP_GROWTH_RATE_RECOVERY_MB_PER_MIN = 0.7; // Recovery threshold (hysteresis prevents flapping)
const HEAP_STABILIZATION_TIME_MS = 5 * 60 * 1000; // 5 minutes stable = healthy

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
	if (heapSamples.length < 5) return null; // Need enough samples for trend
	
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
 * Check if heap has been stable (no significant growth) recently
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
	return stdDev < stableMB;
}

/**
 * Detect memory leak pattern based on RSS and heap correlation
 * 
 * Patterns:
 * - JS leak: Both RSS and heap growing (typical object/closure leaks)
 * - Native leak: RSS growing, heap stable (Buffer, addon, external memory)
 * - GC pressure: Heap growing, RSS stable (GC can't keep up)
 */
function detectLeakPattern(currentHeap: number, currentRSS: number): {
	pattern: 'js-leak' | 'native-leak' | 'gc-pressure' | 'unknown';
	description: string;
} {
	const heapGrowthMB = (currentHeap - baselineHeap) / (1024 * 1024);
	const rssGrowthMB = (currentRSS - baselineRSS) / (1024 * 1024);
	
	const heapGrowing = heapGrowthMB > 5; // 5MB threshold
	const rssGrowing = rssGrowthMB > 10; // 10MB threshold
	
	if (heapGrowing && rssGrowing) {
		return {
			pattern: 'js-leak',
			description: 'JavaScript object leak (closures, event listeners, caches)'
		};
	} else if (!heapGrowing && rssGrowing) {
		return {
			pattern: 'native-leak',
			description: 'Native memory leak (Buffers, addons, external memory)'
		};
	} else if (heapGrowing && !rssGrowing) {
		return {
			pattern: 'gc-pressure',
			description: 'GC pressure (heap growing faster than RSS, possible fragmentation)'
		};
	} else {
		return {
			pattern: 'unknown',
			description: 'Unusual pattern - investigate manually'
		};
	}
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
	
	// Only update baseline upward (prevent masking sudden drops that recover)
	if (avgHeap > baselineHeap) {
		const oldBaselineHeap = baselineHeap;
		const oldBaselineRSS = baselineRSS;
		
		baselineHeap = avgHeap;
		baselineRSS = currentRSS; // Update RSS baseline alongside heap
		lastBaselineUpdate = now;
		
		logger?.infoSync('Baseline updated - heap stabilized at new level', {
			component: LogComponents.metrics,
			oldBaselineHeapMB: bytesToMB(oldBaselineHeap),
			newBaselineHeapMB: bytesToMB(baselineHeap),
			oldBaselineRSSMB: bytesToMB(oldBaselineRSS),
			newBaselineRSSMB: bytesToMB(baselineRSS),
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

	// Initialize baseline heap
	if (initialHeap === 0) {
		initialHeap = currentHeap;
		baselineHeap = currentHeap;
		initialMemory = currentRSS; // Legacy
		baselineRSS = currentRSS; // Sliding RSS baseline
		lastBaselineUpdate = Date.now();
		lastMemoryCheck = currentRSS; // Legacy
		
		heapSamples.push({ timestamp: Date.now(), heapUsed: currentHeap });
		
		logger?.infoSync('Memory baseline established (heap-based, sliding)', {
			component: LogComponents.metrics,
			heapMB: bytesToMB(currentHeap),
			rssMB: bytesToMB(currentRSS),
			uptimeSeconds: processUptime()
		});
		return true;
	}

	// Add current heap sample
	heapSamples.push({ timestamp: Date.now(), heapUsed: currentHeap });
	
	// Keep only recent samples (10-minute window)
	const cutoffTime = Date.now() - SAMPLE_WINDOW_MS;
	heapSamples = heapSamples.filter(s => s.timestamp > cutoffTime);
	
	// Limit to MAX_SAMPLES
	if (heapSamples.length > MAX_SAMPLES) {
		heapSamples = heapSamples.slice(-MAX_SAMPLES);
	}
	
	// Update sliding baseline if heap is stable
	updateBaselineIfStable(currentHeap, currentRSS);
	
	// Calculate heap growth rate
	const growthRate = calculateHeapGrowthRate();
	const heapStable = isHeapStable();
	
	// Apply hysteresis to prevent flapping
	// Use lower threshold for recovery than for initial breach
	const threshold = memoryThresholdBreached 
		? HEAP_GROWTH_RATE_RECOVERY_MB_PER_MIN  // Recovering: use lower threshold
		: HEAP_GROWTH_RATE_MB_PER_MIN;           // Normal: use standard threshold
	
	// Pass if heap is stable (normal allocator behavior)
	if (heapStable) {
		logger?.debugSync('Heap stable - healthy', {
			component: LogComponents.metrics,
			heapMB: bytesToMB(currentHeap),
			baselineMB: bytesToMB(baselineHeap),
			rssMB: bytesToMB(currentRSS),
			samples: heapSamples.length
		});
		return true;
	}
	
	// Fail if sustained growth detected (compared to sliding baseline)
	if (growthRate !== null && growthRate > threshold) {
		// Don't log here - caller decides whether to alert
		// (prevents log spam from repeated healthcheck calls)
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
	const currentHeap = mem.heapUsed;
	const currentRSS = mem.rss;
	const growthRate = calculateHeapGrowthRate();
	const heapGrowthFromBaseline = currentHeap - baselineHeap;
	const heapGrowthFromInitial = currentHeap - initialHeap;
	const rssGrowthFromBaseline = currentRSS - baselineRSS;
	const rssGrowthFromInitial = currentRSS - initialMemory;
	const leakPattern = detectLeakPattern(currentHeap, currentRSS);
	
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
		growthRateMBperMin: growthRate?.toFixed(2) || null,
		thresholdMBperMin: HEAP_GROWTH_RATE_MB_PER_MIN,
		recoveryThresholdMBperMin: HEAP_GROWTH_RATE_RECOVERY_MB_PER_MIN,
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
