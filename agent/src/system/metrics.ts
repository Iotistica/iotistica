/**
 * System metrics collection for the agent.
 */

import systeminformation from 'systeminformation';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const exec = promisify(execCallback);

// Return fallback values instead of throwing.

const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
	try {
		return await fn();
	} catch {
		return fallback;
	}
};

// Cache static or infrequently changing values.
let cachedHostname: string | null = null;
let cachedCpuCores: number | null = null;

// Cache network interfaces with a short TTL because NIC state can change.
let cachedNetworkInterfaces: { ts: number; data: NetworkInterfaceInfo[] } | null = null;


let cachedCpuLoad = 0;

// Background CPU sampler.
async function startCpuSampler() {
	try {
		const load = await systeminformation.currentLoad();
		cachedCpuLoad = load.currentLoad;
	} catch {
		// ignore errors, keep old value
	}
	setTimeout(startCpuSampler, 1000);
}

// Start sampling once.
startCpuSampler();

let anomalyService: any | undefined;

/** Configure anomaly feed integration for system metrics. */
export function configureAnomalyFeed(service: any | undefined): void {
	anomalyService = service;
}

export interface ProcessInfo {
	pid: number;
	name: string;
	cpu: number;
	mem: number;
	command?: string;
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
	load_average?: number[];
	disk_io?: { read: number; write: number };
	cpu_throttling?: { current_freq: number; max_freq: number };
	gpu_temp?: number;
	disk_metrics?: { read_ops: number; write_ops: number };
}

export interface SystemMetrics {
	cpu_usage: number;
	cpu_temp: number | null;
	cpu_cores: number;

	memory_usage: number;
	memory_total: number;
	memory_percent: number;

	storage_usage: number | null;
	storage_total: number | null;
	storage_percent: number | null;

	uptime: number;
	hostname: string;

	is_undervolted: boolean;

	network_interfaces: NetworkInterfaceInfo[];

	extended?: ExtendedMetrics;

	timestamp: Date;
}

/** Get Linux load average. */
async function getLinuxLoadAverage(): Promise<number[] | undefined> {
	if (process.platform !== 'linux') return undefined;
	try {
		return os.loadavg();
	} catch {
		return undefined;
	}
}

/** Get Linux disk I/O statistics. */
async function getLinuxDiskIO(): Promise<{ read: number; write: number } | undefined> {
	if (process.platform !== 'linux') return undefined;
	try {
		const io = await systeminformation.disksIO();
		return {
			read: io.rIO_sec || 0,
			write: io.wIO_sec || 0,
		};
	} catch {
		return undefined;
	}
}

/** Get Linux CPU frequency information. */
async function getLinuxCpuThrottling(): Promise<{ current_freq: number; max_freq: number } | undefined> {
	if (process.platform !== 'linux') return undefined;
	try {
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

/** Collect OS-specific extended metrics. */
async function getExtendedMetrics(): Promise<ExtendedMetrics | undefined> {
	const isLinux = process.platform === 'linux';
	const isWindows = process.platform === 'win32';
	
	if (!isLinux && !isWindows) return undefined;
	
	const extended: ExtendedMetrics = {};
	
	if (isLinux) {
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
		const [gpuTemp, diskMetrics] = await Promise.all([
			getWindowsGpuTemp(),
			getWindowsDiskMetrics(),
		]);
		
		if (gpuTemp !== undefined) extended.gpu_temp = gpuTemp;
		if (diskMetrics) extended.disk_metrics = diskMetrics;
	}
	
	return Object.keys(extended).length > 0 ? extended : undefined;
}

/** Get network interfaces and details. */
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

			// Add Wi-Fi details when present.
			if ('ssid' in iface && typeof iface.ssid === 'string') {
				(base as any).ssid = iface.ssid;
			}
			if ('signalLevel' in iface && typeof iface.signalLevel === 'number') {
				(base as any).signalLevel = iface.signalLevel;
			}

			return base;
		});

		// Cache with timestamp for TTL.
		cachedNetworkInterfaces = { ts: now, data: formatted };
		return formatted;
	} catch (_error) {
		// Do not cache failures.
		return [];
	}
}

export async function getCpuUsage(): Promise<number> {
	// Fast path: return sampled value.
	return Math.round(cachedCpuLoad);
}

/** Get CPU temperature in Celsius. */
export async function getCpuTemp(): Promise<number | null> {
	try {
		const tempInfo = await systeminformation.cpuTemperature();
		return tempInfo.main > 0 ? Math.round(tempInfo.main) : null;
	} catch (_error) {
		return null;
	}
}

/** Get number of CPU cores. */
export async function getCpuCores(): Promise<number> {
	if (cachedCpuCores !== null) {
		return cachedCpuCores;
	}
	
	try {
		const cpuInfo = await systeminformation.cpu();
		cachedCpuCores = cpuInfo.cores;
		return cachedCpuCores;
	} catch (_error) {
		cachedCpuCores = 1;
		return 1;
	}
}


/** Get memory usage information. */
export async function getMemoryInfo(): Promise<{
	used: number;
	total: number;
	percent: number;
}> {
	try {
		const isContainer = await isRunningInContainer();
		
		if (isContainer) {
			const containerMem = await getContainerMemory();
			if (containerMem) {
				return containerMem;
			}
		}
		
		const mem = await systeminformation.mem();
		// Exclude cache and buffers.
		const calcUsed = Math.max(0, mem.used - mem.cached - mem.buffers);
		const usedMb = bytesToMb(calcUsed);
		const totalMb = bytesToMb(mem.total);
		const percent = Math.round((usedMb / totalMb) * 100);
	
		return {
			used: usedMb,
			total: totalMb,
			percent,
		};
	} catch (_error) {
		// Return fallback values.
		return { used: 0, total: 0, percent: 0 };
	}
}

/** Check if running inside a container. */
async function isRunningInContainer(): Promise<boolean> {
	try {
		const fs = await import('fs/promises');
		try {
			await fs.access('/.dockerenv');
			return true;
		} catch {
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

/** Read container memory usage from cgroup. */
async function getContainerMemory(): Promise<{ used: number; total: number; percent: number } | null> {
	try {
		const fs = await import('fs/promises');
		
		// Try cgroup v2 first.
		try {
			const memCurrent = await fs.readFile('/sys/fs/cgroup/memory.current', 'utf-8');
			const memMax = await fs.readFile('/sys/fs/cgroup/memory.max', 'utf-8');
			
			const used = parseInt(memCurrent.trim());
			const total = parseInt(memMax.trim());
			
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
			// Try cgroup v1.
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


/** Get storage usage information. */
export async function getStorageInfo(): Promise<{
	used: number | null;
	total: number | null;
	percent: number | null;
}> {
	try {
		const fsInfo = await systeminformation.fsSize();
		
		// Prefer /data (or C: on Windows), else first partition.
		const targetPartition = fsInfo.find(fs => 
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
			// `use` is already 0-100.
			percent: Math.round(targetPartition.use),
		};
	} catch (_error) {
		// Return fallback values.
		return { used: null, total: null, percent: null };
	}
}

/** Get system uptime in seconds. */
export async function getUptime(): Promise<number> {
	try {
		const isContainer = await isRunningInContainer();
		if (isContainer) {
			return Math.floor(process.uptime());
		}
		const timeInfo = await systeminformation.time();
		return timeInfo.uptime;
	} catch (_error) {
		return 0;
	}
}

/** Get system hostname. */
export async function getHostname(): Promise<string> {
	if (cachedHostname !== null) {
		return cachedHostname;
	}
	
	try {
		const osInfo = await systeminformation.osInfo();
		cachedHostname = osInfo.hostname;
		return cachedHostname;
	} catch (_error) {
		cachedHostname = 'unknown';
		return 'unknown';
	}
}

/** Get primary MAC address from the default interface. */
export async function getMacAddress(): Promise<string | undefined> {
	try {
		const defaultIface = await systeminformation.networkInterfaceDefault();
		const interfaces = await systeminformation.networkInterfaces();
		const primaryInterface = interfaces.find(i => i.iface === defaultIface);
		return primaryInterface?.mac || undefined;
	} catch (_error) {
		// Return fallback value.
		return undefined;
	}
}

/**
 * Get OS version string
 */
export async function getOsVersion(): Promise<string | undefined> {
	try {
		const osInfo = await systeminformation.osInfo();
		return `${osInfo.distro} ${osInfo.release}${osInfo.codename ? ` (${osInfo.codename})` : ''}`;
	} catch (_error) {
		// Return fallback value.
		return undefined;
	}
}

/** Check for undervoltage warnings on Linux systems. */
export async function isUndervolted(): Promise<boolean> {
	if (process.platform !== 'linux') return false;
	try {
		const { stdout } = await exec('dmesg');
		return /under.*voltage/i.test(stdout);
	} catch {
		return false;
	}
}

/** Get top 10 processes by resource usage. */
export async function getTopProcesses(): Promise<ProcessInfo[]> {
	try {

		if (process.platform === 'win32') {
			return getTopProcessesWindows();
		}

		// Single collection call for performance.
		const processes = await systeminformation.processes();
		
		// Fall back when process list is empty.
		if (processes.list.length === 0) {
			// Use fallback command parser.
			return await getTopProcessesFallback();
		}
	
		// Normalize per-core CPU values to a per-system percentage.
		const cpuCoreCount = await getCpuCores();
	
		// Build top results with minimal allocations.
		const result: ProcessInfo[] = new Array(10);
		let resultCount = 0;
	
		// Score and collect candidates.
		const scored: Array<{ proc: any; score: number }> = [];
	
		for (let i = 0; i < processes.list.length; i++) {
			const proc = processes.list[i];
		
			// Skip kernel threads and empty process names.
			if (proc.name.startsWith('[') || proc.name === '') continue;
		
			// Normalize CPU percentage.
			const normalizedCpu = proc.cpu / cpuCoreCount;
		
			// Weighted score: CPU 60%, memory 40%.
			const score = (normalizedCpu * 0.6) + (proc.mem * 0.4);
			scored.push({ proc, score });
		}
	
		// Sort candidates by score.
		scored.sort((a, b) => b.score - a.score);
	
		// Take top 10.
		const limit = Math.min(10, scored.length);
		for (let i = 0; i < limit; i++) {
			const proc = scored[i].proc;
		
			// Store normalized CPU.
			const normalizedCpu = proc.cpu / cpuCoreCount;
		
			result[resultCount++] = {
				pid: proc.pid,
				name: proc.name,
				cpu: Math.round(normalizedCpu * 10) / 10,
				mem: Math.round(proc.mem * 10) / 10,
			};
		}
	
		// Trim to actual count.
		result.length = resultCount;
	
		return result;
	} catch (_error) {
		// Use fallback command parser.
		return await getTopProcessesFallback();
	}
}

/**
 * Fallback process list using `ps`.
 */
async function getTopProcessesFallback(): Promise<ProcessInfo[]> {
	try {
		// Format: PID %CPU %MEM COMMAND.
		const { stdout } = await exec('ps aux --sort=-%cpu | head -n 11 | tail -n +2');
		
		const lines = stdout.trim().split('\n');
		const processes: ProcessInfo[] = [];
		
		for (const line of lines) {
			// Parse: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND.
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
	
		return processes;
	} catch (_error) {
		// Return fallback value.
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
				cpu: 0,
				mem: Math.round((Number(parts[2]) / 1024 / 1024) * 10) / 10,
			}));
	} catch {
		return [];
	}
}
/**
 * Get all system metrics.
 */

export async function getSystemMetrics(): Promise<SystemMetrics> {
	// Gather all metrics in parallel.
	const _startTime = Date.now();
	const timings: Record<string, number> = {};
	
	const wrapWithTiming = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
		const start = Date.now();
		const result = await fn();
		timings[name] = Date.now() - start;
		return result;
	};
	
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
		safe(() => wrapWithTiming('extendedMetrics', () => getExtendedMetrics()), undefined),
	]);
	
	void _startTime;
	void timings;

	const metrics: SystemMetrics = {
		cpu_usage: cpuUsage,
		cpu_temp: cpuTemp,
		cpu_cores: cpuCores,

		memory_usage: memoryInfo.used,
		memory_total: memoryInfo.total,
		memory_percent: memoryInfo.percent,

		storage_usage: storageInfo.used,
		storage_total: storageInfo.total,
		storage_percent: storageInfo.percent,

		uptime,
		hostname,

		is_undervolted: undervolted,

		network_interfaces: networkInterfaces,

		...(extendedMetrics && { extended: extendedMetrics }),

		timestamp: new Date(),
	};

	// Feed anomaly detection when configured.
	if (anomalyService) {
		const timestamp = Date.now();
		const deviceUuid = anomalyService.getDeviceUuid?.();

		if (!deviceUuid) {
			return metrics;
		}

		// Feed numeric metrics.
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

		// Always push through processDataPoint so the metric catalog is populated.
		// The service itself skips anomaly processing for unconfigured or disabled metrics.
		for (const item of metricsToFeed) {
			if (item.value === null || item.value === undefined) continue;
			const canonicalMetricName = `${deviceUuid}_system_${item.metric}`;
			anomalyService.processDataPoint({
				source: 'system',
				protocol: 'system',
				deviceState: 'running',
				deviceId: 'system-endpoint',
				metric: canonicalMetricName,
				value: item.value,
				unit: item.unit,
				timestamp,
				quality: 'GOOD',
			});
		}
	}

	return metrics;
}
export interface NetworkBandwidth {
	iface: string;
	rx_sec: number;
	tx_sec: number;
	rx_bytes: number;
	tx_bytes: number;
}

/** Get per-interface bandwidth stats (bytes/sec in and out). */
export async function getNetworkBandwidth(): Promise<NetworkBandwidth[]> {
	try {
		const stats = await systeminformation.networkStats();
		return stats.map((s) => ({
			iface: s.iface,
			rx_sec: Math.max(0, s.rx_sec ?? 0),
			tx_sec: Math.max(0, s.tx_sec ?? 0),
			rx_bytes: s.rx_bytes ?? 0,
			tx_bytes: s.tx_bytes ?? 0,
		}));
	} catch {
		return [];
	}
}

/** Convert bytes to megabytes. */
function bytesToMb(bytes: number): number {
	return Math.floor(bytes / 1024 / 1024);
}

/** Format uptime to a short human-readable string. */
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
