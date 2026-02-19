/**
 * SYSTEM METRICS MODULE
 * ======================
 * 
 * Simplified version of balena-supervisor system-info module
 * Collects hardware metrics from the device running container-manager
 * 
 * Adapted from: src/lib/system-info.ts
 */

import systeminformation from 'systeminformation';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import type { AnomalyDetectionService } from '../ai/anomaly';

const exec = promisify(execCallback);

// ============================================================================
// GRACEFUL DEGRADATION HELPER
// ============================================================================
// Never throw exceptions - always return fallback values
// Partial data is better than no data on edge devices

const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
	try {
		return await fn();
	} catch {
		return fallback;
	}
};

// ============================================================================
// STATIC VALUE CACHING (for values that never/rarely change)
// ============================================================================
// Cache truly static values (hostname and CPU cores never change during runtime)
let cachedHostname: string | null = null;
let cachedCpuCores: number | null = null;

// Cache network interfaces with 30-second TTL (NICs can change: WiFi SSID, VPN, docker0, etc.)
let cachedNetworkInterfaces: { ts: number; data: NetworkInterfaceInfo[] } | null = null;


let cachedCpuLoad = 0;

// Background CPU sampler (updates every second)
async function startCpuSampler() {
	try {
		const load = await systeminformation.currentLoad();
		cachedCpuLoad = load.currentLoad; // Already averaged internally
	} catch {
		// ignore errors, keep old value
	}
	setTimeout(startCpuSampler, 1000);
}

// Start sampling once
startCpuSampler();

// ============================================================================
// EDGE AI ANOMALY DETECTION CONFIGURATION
// ============================================================================

let anomalyService: AnomalyDetectionService | undefined;

/**
 * Configure edge AI anomaly detection for system metrics
 * @param service - AnomalyDetectionService instance or undefined to disable
 */
export function configureAnomalyFeed(service: AnomalyDetectionService | undefined): void {
	anomalyService = service;
}

// ============================================================================
// TYPES
// ============================================================================

export interface ProcessInfo {
	pid: number;
	name: string;
	cpu: number;
	mem: number;
	command?: string; // Optional - excluded to reduce data size
}

export interface NetworkInterfaceInfo {
	name: string;
	ip4: string | null;
	ip6: string | null;
	mac: string | null;
	type: string | null;
	default: boolean;
	virtual: boolean;
	operstate: string | null;
	ssid?: string;
	signalLevel?: number;
}

export interface ExtendedMetrics {
	// Linux-specific
	load_average?: number[]; // 1, 5, 15 minute load averages
	disk_io?: { read: number; write: number }; // Bytes/sec
	cpu_throttling?: { current_freq: number; max_freq: number }; // MHz
	
	// Windows-specific
	gpu_temp?: number; // °C
	disk_metrics?: { read_ops: number; write_ops: number }; // Operations/sec
}

export interface SystemMetrics {
	// CPU metrics
	cpu_usage: number;
	cpu_temp: number | null;
	cpu_cores: number;

	// Memory metrics
	memory_usage: number;
	memory_total: number;
	memory_percent: number;

	// Storage metrics
	storage_usage: number | null;
	storage_total: number | null;
	storage_percent: number | null;

	// System info
	uptime: number;
	hostname: string;

	// Health checks
	is_undervolted: boolean;

	// Process info
	top_processes: ProcessInfo[];

	// Networking
	network_interfaces: NetworkInterfaceInfo[];

	// OS-specific extended metrics
	extended?: ExtendedMetrics;

	// Timestamp
	timestamp: Date;
}
// ============================================================================
// OS-SPECIFIC EXTENDED METRICS
// ============================================================================

/**
 * Get Linux load average (1, 5, 15 minutes)
 */
async function getLinuxLoadAverage(): Promise<number[] | undefined> {
	if (process.platform !== 'linux') return undefined;
	try {
		return os.loadavg();
	} catch {
		return undefined;
	}
}

/**
 * Get Linux disk I/O statistics
 */
async function getLinuxDiskIO(): Promise<{ read: number; write: number } | undefined> {
	if (process.platform !== 'linux') return undefined;
	try {
		const io = await systeminformation.disksIO();
		return {
			read: io.rIO_sec || 0, // Reads per second
			write: io.wIO_sec || 0, // Writes per second
		};
	} catch {
		return undefined;
	}
}

/**
 * Get Linux CPU throttling info (current vs max frequency)
 */
async function getLinuxCpuThrottling(): Promise<{ current_freq: number; max_freq: number } | undefined> {
	if (process.platform !== 'linux') return undefined;
	try {
		// Read current frequency from sysfs
		const currentCmd = 'cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null';
		const maxCmd = 'cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq 2>/dev/null';
		
		const [currentResult, maxResult] = await Promise.all([
			exec(currentCmd).catch(() => ({ stdout: '' })),
			exec(maxCmd).catch(() => ({ stdout: '' })),
		]);
		
		const currentFreq = parseInt(currentResult.stdout.trim());
		const maxFreq = parseInt(maxResult.stdout.trim());
		
		if (isNaN(currentFreq) || isNaN(maxFreq)) return undefined;
		
		return {
			current_freq: Math.round(currentFreq / 1000), // Convert kHz to MHz
			max_freq: Math.round(maxFreq / 1000),
		};
	} catch {
		return undefined;
	}
}

/**
 * Get Windows GPU temperature via WMI
 */
async function getWindowsGpuTemp(): Promise<number | undefined> {
	if (process.platform !== 'win32') return undefined;
	try {
		// Query GPU temperature via WMI (requires admin privileges on some systems)
		const cmd = 'powershell "Get-WmiObject MSAcpi_ThermalZoneTemperature -Namespace root/wmi | Select-Object -First 1 -ExpandProperty CurrentTemperature"';
		const { stdout } = await exec(cmd);
		const tempKelvin = parseInt(stdout.trim());
		
		if (isNaN(tempKelvin)) return undefined;
		
		// Convert from decikelvin to Celsius
		return Math.round((tempKelvin / 10) - 273.15);
	} catch {
		return undefined;
	}
}

/**
 * Get Windows disk metrics from performance counters
 */
async function getWindowsDiskMetrics(): Promise<{ read_ops: number; write_ops: number } | undefined> {
	if (process.platform !== 'win32') return undefined;
	try {
		// Use systeminformation for cross-platform consistency
		const io = await systeminformation.disksIO();
		return {
			read_ops: io.rIO_sec || 0,
			write_ops: io.wIO_sec || 0,
		};
	} catch {
		return undefined;
	}
}

/**
 * Collect OS-specific extended metrics
 */
async function getExtendedMetrics(): Promise<ExtendedMetrics | undefined> {
	const isLinux = process.platform === 'linux';
	const isWindows = process.platform === 'win32';
	
	// Skip if neither Linux nor Windows
	if (!isLinux && !isWindows) return undefined;
	
	const extended: ExtendedMetrics = {};
	
	if (isLinux) {
		// Linux-specific metrics
		const [loadAvg, diskIO, cpuThrottle] = await Promise.all([
			getLinuxLoadAverage(),
			getLinuxDiskIO(),
			getLinuxCpuThrottling(),
		]);
		
		if (loadAvg) extended.load_average = loadAvg;
		if (diskIO) extended.disk_io = diskIO;
		if (cpuThrottle) extended.cpu_throttling = cpuThrottle;
	}
	
	if (isWindows) {
		// Windows-specific metrics
		const [gpuTemp, diskMetrics] = await Promise.all([
			getWindowsGpuTemp(),
			getWindowsDiskMetrics(),
		]);
		
		if (gpuTemp !== undefined) extended.gpu_temp = gpuTemp;
		if (diskMetrics) extended.disk_metrics = diskMetrics;
	}
	
	// Only return extended if we got at least one metric
	return Object.keys(extended).length > 0 ? extended : undefined;
}

// ============================================================================
// NETWORK METRICS
// ============================================================================

/**
 * Get network interfaces and their details (cached with 30s TTL - interfaces can change)
 */
export async function getNetworkInterfaces(): Promise<NetworkInterfaceInfo[]> {
	const now = Date.now();
	if (cachedNetworkInterfaces && now - cachedNetworkInterfaces.ts < 30_000) {
		return cachedNetworkInterfaces.data;
	}
	
	try {
		const interfaces = await systeminformation.networkInterfaces();
		const defaultIface = await systeminformation.networkInterfaceDefault();

		const formatted = interfaces.map((iface) => {
			const base: NetworkInterfaceInfo = {
				name: iface.iface,
				ip4: iface.ip4 || null,
				ip6: iface.ip6 || null,
				mac: iface.mac || null,
				type: iface.type || null,
				default: iface.iface === defaultIface,
				virtual: iface.virtual || false,
				operstate: iface.operstate || null,
			};

			// Only add ssid/signalLevel if present (for wifi)
			if ('ssid' in iface && typeof iface.ssid === 'string') {
				(base as any).ssid = iface.ssid;
			}
			if ('signalLevel' in iface && typeof iface.signalLevel === 'number') {
				(base as any).signalLevel = iface.signalLevel;
			}

	return base;
	});

	// Cache with timestamp for 30-second TTL
	cachedNetworkInterfaces = { ts: now, data: formatted };
	return formatted;
	} catch (error) {
		// Don't cache errors - allow retry on next call
		return [];
	}
}
// ============================================================================
// CPU METRICS
// ============================================================================

export async function getCpuUsage(): Promise<number> {
	// Fast path: just return the latest sampled value
	// No await needed, no systeminformation call here
	return Math.round(cachedCpuLoad);
}

/**
 * Get CPU temperature in Celsius
 * Returns null if temperature sensor not available
 */
export async function getCpuTemp(): Promise<number | null> {
	try {
		const tempInfo = await systeminformation.cpuTemperature();
		return tempInfo.main > 0 ? Math.round(tempInfo.main) : null;
	} catch (error) {
		return null;
	}
}

/**
 * Get number of CPU cores (cached after first call - cores don't change)
 */
export async function getCpuCores(): Promise<number> {
	if (cachedCpuCores !== null) {
		return cachedCpuCores;
	}
	
	try {
		const cpuInfo = await systeminformation.cpu();
		cachedCpuCores = cpuInfo.cores;
		return cachedCpuCores;
	} catch (error) {
		cachedCpuCores = 1;
		return 1;
	}
}

// ============================================================================
// MEMORY METRICS
// ============================================================================

/**
 * Get memory usage information
 */
export async function getMemoryInfo(): Promise<{
	used: number;
	total: number;
	percent: number;
}> {
	try {
		// Detect if running in a Docker container
		const isContainer = await isRunningInContainer();
		
		if (isContainer) {
			// Read container memory stats from cgroup
			const containerMem = await getContainerMemory();
			if (containerMem) {
				return containerMem;
			}
			// Fall through to systeminformation if cgroup read fails
		}
		
		const mem = await systeminformation.mem();
		// Exclude cached and buffers from used memory (like balena does)
		// Ensure non-negative result (some systems report used differently)
		const calcUsed = Math.max(0, mem.used - mem.cached - mem.buffers);
		const usedMb = bytesToMb(calcUsed);
		const totalMb = bytesToMb(mem.total);
		const percent = Math.round((usedMb / totalMb) * 100);
	
	return {
		used: usedMb,
		total: totalMb,
		percent,
	};
} catch (error) {
	// Silently return zero values - caller will handle
	return { used: 0, total: 0, percent: 0 };
}
}

/**
 * Check if running inside a Docker container
 */
async function isRunningInContainer(): Promise<boolean> {
	try {
		const fs = await import('fs/promises');
		// Check for .dockerenv file
		try {
			await fs.access('/.dockerenv');
			return true;
		} catch {
			// Check cgroup
			try {
				const cgroup = await fs.readFile('/proc/1/cgroup', 'utf-8');
				return cgroup.includes('docker') || cgroup.includes('kubepods');
			} catch {
				return false;
			}
		}
	} catch {
		return false;
	}
}

/**
 * Read container memory usage from cgroup
 */
async function getContainerMemory(): Promise<{ used: number; total: number; percent: number } | null> {
	try {
		const fs = await import('fs/promises');
		
		// Try cgroup v2 first (newer Docker versions)
		try {
			const memCurrent = await fs.readFile('/sys/fs/cgroup/memory.current', 'utf-8');
			const memMax = await fs.readFile('/sys/fs/cgroup/memory.max', 'utf-8');
			
			const used = parseInt(memCurrent.trim());
			const total = parseInt(memMax.trim());
			
			if (!isNaN(used) && !isNaN(total) && total !== 9223372036854771712) { // max value means no limit
				const usedMb = bytesToMb(used);
				const totalMb = bytesToMb(total);
				return {
					used: usedMb,
					total: totalMb,
					percent: Math.round((usedMb / totalMb) * 100)
				};
			}
		} catch {
			// Try cgroup v1 (older Docker versions)
			try {
				const memUsage = await fs.readFile('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf-8');
				const memLimit = await fs.readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf-8');
				
				const used = parseInt(memUsage.trim());
				const total = parseInt(memLimit.trim());
				
				if (!isNaN(used) && !isNaN(total) && total !== 9223372036854771712) {
					const usedMb = bytesToMb(used);
					const totalMb = bytesToMb(total);
					return {
						used: usedMb,
						total: totalMb,
						percent: Math.round((usedMb / totalMb) * 100)
					};
				}
			} catch {
				return null;
			}
		}
		
		return null;
	} catch {
		return null;
	}
}

// ============================================================================
// STORAGE METRICS
// ============================================================================

/**
 * Get storage usage information
 * Looks for /data partition or falls back to root
 */
export async function getStorageInfo(): Promise<{
	used: number | null;
	total: number | null;
	percent: number | null;
}> {
	try {
		const fsInfo = await systeminformation.fsSize();
		
		// Look for /data partition first
		let targetPartition = fsInfo.find(fs => 
			process.platform === 'win32'
				? fs.mount.toUpperCase() === 'C:'
				: fs.mount === '/data'
		) || fsInfo[0];
		
		
		if (!targetPartition) {
			return { used: null, total: null, percent: null };
	}
	
	return {
		used: bytesToMb(targetPartition.used),
		total: bytesToMb(targetPartition.size),
		// use is already 0-100 from systeminformation, round to integer for display
		percent: Math.round(targetPartition.use),
	};
} catch (error) {
	// Silently return null values - caller will handle
	return { used: null, total: null, percent: null };
}
}// ============================================================================
// SYSTEM INFO
// ============================================================================

/**
 * Get system uptime in seconds
 */
export async function getUptime(): Promise<number> {
	try {
		const isContainer = await isRunningInContainer();
		if (isContainer) {
			return Math.floor(process.uptime());
		}
		const timeInfo = await systeminformation.time();
		return timeInfo.uptime;
	} catch (error) {
		return 0;
	}
}

/**
 * Get system hostname (cached after first call - hostname rarely changes)
 */
export async function getHostname(): Promise<string> {
	if (cachedHostname !== null) {
		return cachedHostname;
	}
	
	try {
		const osInfo = await systeminformation.osInfo();
		cachedHostname = osInfo.hostname;
		return cachedHostname;
	} catch (error) {
		cachedHostname = 'unknown';
		return 'unknown';
	}
}

/**
 * Get primary MAC address (from default network interface)
 */
export async function getMacAddress(): Promise<string | undefined> {
	try {
		const defaultIface = await systeminformation.networkInterfaceDefault();
		const interfaces = await systeminformation.networkInterfaces();
		const primaryInterface = interfaces.find(i => i.iface === defaultIface);
		return primaryInterface?.mac || undefined;
	} catch (error) {
		// Silently return undefined - caller will handle
		return undefined;
	}
}

/**
 * Get OS version string
 */
export async function getOsVersion(): Promise<string | undefined> {
	try {
		const osInfo = await systeminformation.osInfo();
		// Format: "Debian GNU/Linux 12 (bookworm)" or similar
		return `${osInfo.distro} ${osInfo.release}${osInfo.codename ? ` (${osInfo.codename})` : ''}`;
	} catch (error) {
		// Silently return undefined - caller will handle
		return undefined;
	}
}

// ============================================================================
// HEALTH CHECKS
// ============================================================================

/**
 * Check if system has detected undervoltage (Raspberry Pi)
 * Scans dmesg for undervoltage warnings
 */
export async function isUndervolted(): Promise<boolean> {
	if (process.platform !== 'linux') return false;
	try {
		const { stdout } = await exec('dmesg');
		return /under.*voltage/i.test(stdout);
	} catch {
		return false;
	}
}


// ============================================================================
// PROCESS METRICS
// ============================================================================

/**
 * Get top 10 processes by CPU and memory usage
 * Returns combined list sorted by resource usage
 * Note: CPU readings may be less accurate on Windows (accepts 0 on first call)
 */
export async function getTopProcesses(): Promise<ProcessInfo[]> {
	try {

		if (process.platform === 'win32') {
			return getTopProcessesWindows();
		}

		// Single call for performance - CPU values may be 0 on Windows first collection
		// This is acceptable trade-off for 1+ second performance gain
		const processes = await systeminformation.processes();
		
	// If systeminformation returns empty, try fallback method
	if (processes.list.length === 0) {
		// Silently fallback - debug logging removed
		return await getTopProcessesFallback();
	}
	
	// CRITICAL: CPU percentages on Linux are per-core (e.g., 400% on 4-core system)
	// We normalize to per-system percentage for consistent comparison
	// Note: We're already on Linux here (Windows takes early return above)
	const cpuCoreCount = await getCpuCores();
	
	// GARBAGE-OPTIMIZED: Single pass filter+score+sort without intermediate arrays
	// Pre-allocate result array to avoid resizing
	const result: ProcessInfo[] = new Array(10);
	let resultCount = 0;
	
	// Score and collect top 10 in single pass (no intermediate arrays)
	const scored: Array<{ proc: any; score: number }> = [];
	
	for (let i = 0; i < processes.list.length; i++) {
		const proc = processes.list[i];
		
		// Filter kernel threads and empty names inline
		if (proc.name.startsWith('[') || proc.name === '') continue;
		
		// Normalize CPU percentage from per-core to per-system
		const normalizedCpu = proc.cpu / cpuCoreCount;
		
		// Calculate score (CPU 60%, memory 40%) using normalized CPU
		const score = (normalizedCpu * 0.6) + (proc.mem * 0.4);
		scored.push({ proc, score });
	}
	
	// Sort scored array in-place (mutates, no new array)
	scored.sort((a, b) => b.score - a.score);
	
	// Take top 10 and format directly into result array
	const limit = Math.min(10, scored.length);
	for (let i = 0; i < limit; i++) {
		const proc = scored[i].proc;
		
		// Store normalized CPU (per-system, not per-core)
		const normalizedCpu = proc.cpu / cpuCoreCount;
		
		result[resultCount++] = {
			pid: proc.pid,
			name: proc.name,
			cpu: Math.round(normalizedCpu * 10) / 10,
			mem: Math.round(proc.mem * 10) / 10,
		};
	}
	
	// Trim array to actual count (no extra null entries)
	result.length = resultCount;
	
	return result;
} catch (error) {
	// Silently try fallback method - debug logging removed
	return await getTopProcessesFallback();
}
}/**
 * Fallback method using ps command directly
 * Used when systeminformation fails to get process list
 */
async function getTopProcessesFallback(): Promise<ProcessInfo[]> {
	try {
		// Use ps command to get process info
		// Format: PID %CPU %MEM COMMAND
		const { stdout } = await exec('ps aux --sort=-%cpu | head -n 11 | tail -n +2');
		
		const lines = stdout.trim().split('\n');
		const processes: ProcessInfo[] = [];
		
		for (const line of lines) {
			// Parse ps output: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
			const parts = line.trim().split(/\s+/);
			
			if (parts.length >= 11) {
				const pid = parseInt(parts[1]);
				const cpu = parseFloat(parts[2]);
				const mem = parseFloat(parts[3]);
				const command = parts.slice(10).join(' ');
				const name = parts[10].split('/').pop() || parts[10];
				
				processes.push({
					pid,
				name,
				cpu: Math.round(cpu * 10) / 10,
				mem: Math.round(mem * 10) / 10,
				command,
			});
		}
	}
	
	// Debug logging removed - processes collected successfully
	return processes;
} catch (error) {
	// Silently return empty array - caller will handle
	return [];
}
}

async function getTopProcessesWindows(): Promise<ProcessInfo[]> {
	try {
		const { stdout } = await exec(`wmic path win32_process get ProcessId,Name,WorkingSetSize`);
		const lines = stdout.trim().split(/\r?\n/).slice(1);

		return lines
			.map(line => line.trim().split(/\s+/))
			.slice(0, 10)
			.map(parts => ({
				pid: Number(parts[1]),
				name: parts[0],
				cpu: 0, // Windows wmic doesn't provide CPU here (systeminformation will)
				mem: Math.round((Number(parts[2]) / 1024 / 1024) * 10) / 10,
			}));
	} catch {
		return [];
	}
}


// ============================================================================
// MAIN METRICS FUNCTION
// ============================================================================

/**
 * Get all system metrics in one call
 * This is the main function to use
 */

export async function getSystemMetrics(): Promise<SystemMetrics> {
	// Gather all metrics in parallel for speed - with timing
	const startTime = Date.now();
	const timings: Record<string, number> = {};
	
	const wrapWithTiming = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
		const start = Date.now();
		const result = await fn();
		timings[name] = Date.now() - start;
		return result;
	};
	
	// Collect top processes only if needed (can add 1-5 seconds on slow platforms)
	// On Windows, default to disabled unless explicitly enabled (it's extremely slow)
	// On Linux/production, default to enabled (it's fast)
	const isWindows = process.platform === 'win32';
	const includeProcesses = process.env.COLLECT_TOP_PROCESSES === 'true' || 
		(process.env.COLLECT_TOP_PROCESSES !== 'false' && !isWindows);
	
	const [
		cpuUsage,
		cpuTemp,
		cpuCores,
		memoryInfo,
		storageInfo,
		uptime,
		hostname,
		undervolted,
		networkInterfaces,
		topProcesses,
		extendedMetrics,
	] = await Promise.all([
		safe(() => wrapWithTiming('cpuUsage', () => getCpuUsage()), 0),
		safe(() => wrapWithTiming('cpuTemp', () => getCpuTemp()), null),
		safe(() => wrapWithTiming('cpuCores', () => getCpuCores()), 1),
		safe(() => wrapWithTiming('memoryInfo', () => getMemoryInfo()), { used: 0, total: 0, percent: 0 }),
		safe(() => wrapWithTiming('storageInfo', () => getStorageInfo()), { used: null, total: null, percent: null }),
		safe(() => wrapWithTiming('uptime', () => getUptime()), 0),
		safe(() => wrapWithTiming('hostname', () => getHostname()), 'unknown'),
		safe(() => wrapWithTiming('undervolted', () => isUndervolted()), false),
		safe(() => wrapWithTiming('networkInterfaces', () => getNetworkInterfaces()), []),
		includeProcesses ? safe(() => wrapWithTiming('topProcesses', () => getTopProcesses()), []) : Promise.resolve([]),
		safe(() => wrapWithTiming('extendedMetrics', () => getExtendedMetrics()), undefined),
	]);
	
	// const totalMs = Date.now() - startTime;
	
	// // Log timing breakdown if collection was slow (> 500ms total)
	// if (totalMs > 500) {
	// 	const sortedTimings = Object.entries(timings)
	// 		.sort((a, b) => b[1] - a[1])
	// 		.slice(0, 10); // Top 10 to see all operations
	// 	console.log('[METRICS TIMING]', {
	// 		totalMs,
	// 		allTimings: Object.fromEntries(sortedTimings)
	// 	});
	// }

	const metrics: SystemMetrics = {
		// CPU
		cpu_usage: cpuUsage,
		cpu_temp: cpuTemp,
		cpu_cores: cpuCores,

		// Memory
		memory_usage: memoryInfo.used,
		memory_total: memoryInfo.total,
		memory_percent: memoryInfo.percent,

		// Storage
		storage_usage: storageInfo.used,
		storage_total: storageInfo.total,
		storage_percent: storageInfo.percent,

		// System
		uptime,
		hostname,

		// Health
		is_undervolted: undervolted,

		// Processes
		top_processes: topProcesses,

		// Networking
		network_interfaces: networkInterfaces,

		// OS-specific extended metrics
		...(extendedMetrics && { extended: extendedMetrics }),

		// Metadata
		timestamp: new Date(),
	};

	// Feed edge AI anomaly detection if configured
	if (anomalyService) {
		const timestamp = Date.now();

			// Feed all numeric metrics to edge AI for local ML processing
			const metricsToFeed = [
				{ metric: 'cpu_usage', value: cpuUsage, unit: '%' },
				{ metric: 'cpu_temp', value: cpuTemp, unit: '°C' },
				{ metric: 'cpu_cores', value: cpuCores, unit: 'count' },
				{ metric: 'memory_usage', value: memoryInfo.used, unit: 'MB' },
				{ metric: 'memory_total', value: memoryInfo.total, unit: 'MB' },
				{ metric: 'memory_percent', value: memoryInfo.percent, unit: '%' },
				{ metric: 'storage_usage', value: storageInfo.used, unit: 'MB' },
				{ metric: 'storage_total', value: storageInfo.total, unit: 'MB' },
				{ metric: 'storage_percent', value: storageInfo.percent, unit: '%' },
				{ metric: 'uptime', value: uptime, unit: 'seconds' },
			];

			// Process all metrics that have non-null values
			for (const item of metricsToFeed) {
				if (item.value !== null && item.value !== undefined) {
					anomalyService.processDataPoint({
						source: 'system',
						metric: item.metric,
						value: item.value,
						unit: item.unit,
						timestamp,
						quality: 'GOOD', // System metrics are always high quality
					});
				}
			}
		}

	return metrics;
}


// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Convert bytes to megabytes
 */
function bytesToMb(bytes: number): number {
	return Math.floor(bytes / 1024 / 1024);
}

/**
 * Format uptime to human readable string
 */
export function formatUptime(seconds: number): string {
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	
	return parts.length > 0 ? parts.join(' ') : '0m';
}
