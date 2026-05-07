import type { VolumeInspectInfo } from 'dockerode';

import { difference, uniq } from '../lib/collection-utils';
import { isNotFoundError, InternalInconsistencyError } from '../lib/errors';
import { docker } from '../lib/docker-utils';
import * as logger from '../logging';
import { ResourceRecreationAttemptError } from './errors';
import { Volume } from './volume';

/**
 * Volume health verification options
 * Edge devices: SD card corruption, power loss, fsck events
 */
export interface VolumeVerifyOpts {
	/** Enable health check (adds ~1s overhead) */
	verify?: boolean;
	/** Timeout in ms for verification (default: 5000) */
	timeout?: number;
}

/**
 * Volume cleanup options
 */
export interface VolumeCleanupOpts {
	/** Dry-run mode: Log what would be deleted without actually deleting */
	dryRun?: boolean;
}

export interface VolumeNameOpts {
	
	name: string;
	appId: number;
}

/**
 * Verify volume health by attempting a test mount
 * CRITICAL for edge devices: Detects corruption from power loss, SD card wear, fsck events
 * Fail fast > silent corruption leading to mysterious container failures
 * 
 * @param volumeName - Docker volume name
 * @param timeout - Max wait time in ms (default: 5000)
 * @returns true if healthy, false if corrupted/inaccessible
 */
export async function verifyVolumeHealth(
	volumeName: string,
	timeout: number = 5000,
): Promise<boolean> {
	try {
		// Lightweight verification: mount volume and test read/write
		// Uses busybox (tiny image, likely cached) to avoid pulling large images
		const container = await docker.createContainer({
			Image: 'busybox:latest',
			Cmd: ['sh', '-c', 'ls /data >/dev/null && touch /data/.healthcheck && rm /data/.healthcheck'],
			HostConfig: {
				Binds: [`${volumeName}:/data`],
				AutoRemove: true, // Clean up automatically
			},
			AttachStdout: false,
			AttachStderr: false,
		});

		await container.start();
		
		// Wait for completion with timeout
		const waitPromise = container.wait();
		const timeoutPromise = new Promise((_, reject) => 
			setTimeout(() => reject(new Error('Verification timeout')), timeout)
		);
		
		const result = await Promise.race([waitPromise, timeoutPromise]) as { StatusCode: number };
		
		if (result.StatusCode !== 0) {
			logger.logSystemEvent('volumeHealthCheckFailed', {
				volume: { name: volumeName },
				exitCode: result.StatusCode,
				message: 'Volume mounted but read/write test failed - possible corruption',
			});
			return false;
		}
		
		return true;
	} catch (err: any) {
		// Common edge failures:
		// - "no such file or directory" (SD card corruption)
		// - "permission denied" (fsck changed permissions)
		// - "input/output error" (hardware failure)
		logger.logSystemEvent('volumeHealthCheckError', {
			volume: { name: volumeName },
			error: err.message,
			message: 'Volume verification failed - may be corrupted or inaccessible',
		});
		return false;
	}
}

export async function get({ name, appId }: VolumeNameOpts): Promise<Volume> {
	return Volume.fromDockerVolume(
		await docker.getVolume(Volume.generateDockerName(appId, name)).inspect(),
	);
}

export async function getAll(): Promise<Volume[]> {
	const volumes = await list();
	
	// Telemetry for field diagnostics (no SSH needed)
	let unmanagedCount = 0;
	let malformedCount = 0;
	const errors: Array<{ name: string; error: string }> = [];
	
	// Normalize inspect information to Volume types and filter any that fail
	const result = volumes.reduce((volumesList, volumeInfo) => {
		try {
			const volume = Volume.fromDockerVolume(volumeInfo);
			volumesList.push(volume);
		} catch (err) {
			if (err instanceof InternalInconsistencyError) {
				// Expected: unmanaged volumes (user-created, third-party, etc.)
				unmanagedCount++;
				logger.logSystemEvent('unmanagedVolumeSkipped', {
					volume: { name: volumeInfo.Name },
					labels: volumeInfo.Labels,
					driver: volumeInfo.Driver,
				});
			} else {
				// Unexpected: malformed volume data (Docker daemon corruption, label parsing error)
				malformedCount++;
				errors.push({ 
					name: volumeInfo.Name, 
					error: err instanceof Error ? err.message : String(err) 
				});
				logger.logSystemEvent('malformedVolumeSkipped', {
					volume: { name: volumeInfo.Name },
					error: err instanceof Error ? err.message : String(err),
					labels: volumeInfo.Labels,
					message: 'Volume data corrupted or incompatible - may need manual cleanup',
				});
			}
		}
		return volumesList;
	}, [] as Volume[]);
	
	// Emit summary metrics for monitoring/alerting
	if (unmanagedCount > 0 || malformedCount > 0) {
		logger.logSystemEvent('volumeInventorySummary', {
			managed: result.length,
			unmanaged: unmanagedCount,
			malformed: malformedCount,
			...(malformedCount > 0 && { errors }), // Include error details if any
		});
	}
	
	return result;
}

export async function getAllByAppId(appId: number): Promise<Volume[]> {
	const all = await getAll();
	return all.filter(v => v.appId === appId);
}

export async function create(volume: Volume, opts?: VolumeVerifyOpts): Promise<void> {
	// First we check that we're not trying to recreate a
	// volume
	try {
		const existing = await get({
			name: volume.name,
			appId: volume.appId,
		});

		// Check for version mismatch (future migration trigger point)
		const existingVersion = parseInt(existing.config.labels['iotistic.volume-version'] || '1', 10);
		const targetVersion = parseInt(volume.config.labels['iotistic.volume-version'] || '1', 10);
		
		if (existingVersion < targetVersion) {
			// TODO: Implement volume migration when needed
			// Future scenarios:
			// - Schema changes (PostgreSQL upgrade, Redis data format)
			// - Data layout changes (directory structure reorganization)
			// - Compression/encryption additions
			logger.logSystemEvent('volumeMigrationNeeded', {
				volume: { name: volume.name },
				fromVersion: existingVersion,
				toVersion: targetVersion,
				message: 'Volume migration not yet implemented - manual intervention required',
			});
			// For now, treat as recreation attempt to prevent data loss
			throw new ResourceRecreationAttemptError('volume', volume.name);
		}

		if (!volume.isEqualConfig(existing)) {
			throw new ResourceRecreationAttemptError('volume', volume.name);
		}
		
		// Optional: Verify existing volume health (edge device safety)
		if (opts?.verify) {
			const dockerName = Volume.generateDockerName(volume.appId, volume.name);
			const healthy = await verifyVolumeHealth(dockerName, opts.timeout);
			if (!healthy) {
				logger.logSystemEvent('existingVolumeCorrupted', {
					volume: { name: volume.name },
					message: 'Existing volume failed health check - consider manual intervention',
				});
				// Don't throw - log and continue (ops team can investigate)
				// Alternative: throw new Error('Volume corrupted') to force recreation
			}
		}
	} catch (e: unknown) {
		if (!isNotFoundError(e)) {
			logger.logSystemEvent('createVolumeError', {
				volume: { name: volume.name },
				error: e,
			});
			throw e;
		}

		await volume.create();
		
		// Optional: Verify newly created volume (edge device safety)
		if (opts?.verify) {
			const dockerName = Volume.generateDockerName(volume.appId, volume.name);
			const healthy = await verifyVolumeHealth(dockerName, opts.timeout);
			if (!healthy) {
				logger.logSystemEvent('newVolumeCorrupted', {
					volume: { name: volume.name },
					message: 'Newly created volume failed health check - filesystem may be damaged',
				});
				// Consider throwing here since it's a new volume
				throw new Error(`Volume ${volume.name} created but failed health check - possible SD card corruption`);
			}
		}
	}
}

// We simply forward this to the volume object, but we
// add this method to provide a consistent interface
export async function remove(volume: Volume) {
	await volume.remove();
}

// Note: createFromPath removed - not needed for basic volume management
// (was used for migrating old data paths in Balena Supervisor)

/**
 * Migrate volume data from old version to new version
 * FUTURE IMPLEMENTATION: Called when version mismatch detected
 * 
 * Example migration scenarios:
 * - PostgreSQL 12 → 14: Run pg_upgrade in migration container
 * - Redis 6 → 7: Run redis-check-rdb + BGREWRITEAOF
 * - Directory restructure: Copy data with new layout
 * 
 * @param volume - Target volume configuration
 * @param fromVersion - Current volume version
 * @param toVersion - Target volume version
 */
async function _migrateVolume(
	volume: Volume,
	fromVersion: number,
	toVersion: number,
): Promise<void> {
	logger.logSystemEvent('volumeMigrationStarted', {
		volume: { name: volume.name },
		fromVersion,
		toVersion,
	});
	
	// Future implementation strategy:
	// 1. Create backup volume: `${volumeName}-backup-v${fromVersion}`
	// 2. Copy data: docker run --volumes-from backup busybox cp -a
	// 3. Run migration container:
	//    - Mount original volume
	//    - Run version-specific migration script
	//    - Update version label
	// 4. Verify migration success
	// 5. Remove backup (or keep for rollback)
	
	throw new Error(
		`Volume migration from v${fromVersion} to v${toVersion} not yet implemented. ` +
		`Manual migration required - see docs/VOLUME-MIGRATION.md`
	);
}

/**
 * Acquire a lock for volume operations using Docker container
 * CRITICAL for multi-agent scenarios:
 * - Two agents running briefly (systemd restart during update)
 * - Debugging session + production agent
 * - Upgrade/rollback overlap
 * 
 * Uses Docker's atomic container creation as lock mechanism:
 * - Create succeeds = lock acquired
 * - Create fails (409 Conflict) = lock held by another agent
 * 
 * @param lockName - Lock identifier (e.g., 'volume-cleanup')
 * @param timeout - Max wait time in ms (default: 30000)
 * @returns Lock container ID if acquired, null if timeout
 */
async function acquireVolumeLock(
	lockName: string,
	timeout: number = 30000,
): Promise<string | null> {
	const containerName = `iotistic-lock-${lockName}`;
	const startTime = Date.now();
	
	while (Date.now() - startTime < timeout) {
		try {
			// Atomic operation: create container with specific name
			// Succeeds only if name not already taken
			const container = await docker.createContainer({
				name: containerName,
				Image: 'busybox:latest',
				Cmd: ['sleep', '300'], // 5min max lock hold time
				Labels: {
					'iotistic.lock': 'true',
					'iotistic.lock-name': lockName,
					'iotistic.acquired-at': new Date().toISOString(),
				},
				HostConfig: {
					AutoRemove: false, // Manual cleanup for observability
				},
			});
			
			await container.start();
			logger.logSystemEvent('volumeLockAcquired', {
				lockName,
				containerId: container.id,
			});
			return container.id;
		} catch (err: any) {
			// 409 Conflict = lock already held
			if (err.statusCode === 409) {
				// Wait and retry (exponential backoff)
				const elapsed = Date.now() - startTime;
				const backoff = Math.min(1000, 100 * Math.pow(2, Math.floor(elapsed / 1000)));
				await new Promise(resolve => setTimeout(resolve, backoff));
				continue;
			}
			
			// Other errors (image pull, Docker daemon down, etc.)
			logger.logSystemEvent('volumeLockAcquireError', {
				lockName,
				error: err.message,
			});
			throw err;
		}
	}
	
	// Timeout - another agent still holding lock
	logger.logSystemEvent('volumeLockTimeout', {
		lockName,
		timeout,
		message: 'Another agent may be stuck - check for zombie lock containers',
	});
	return null;
}

/**
 * Release volume operation lock
 * 
 * @param containerId - Lock container ID from acquireVolumeLock()
 */
async function releaseVolumeLock(containerId: string): Promise<void> {
	try {
		const container = docker.getContainer(containerId);
		await container.stop({ t: 1 }); // 1 second grace period
		await container.remove();
		logger.logSystemEvent('volumeLockReleased', {
			containerId,
		});
	} catch (err: any) {
		// Container already gone (crashed, manual removal) - that's fine
		if (err.statusCode !== 404) {
			logger.logSystemEvent('volumeLockReleaseError', {
				containerId,
				error: err.message,
			});
		}
	}
}

/**
 * Check if a volume is currently in use by any container
 * CRITICAL: Used to prevent race conditions during orphan cleanup
 * Re-checking right before removal prevents deleting volumes that
 * become in-use between listVolumes and remove operations
 */
async function isVolumeInUse(volumeName: string): Promise<boolean> {
	const containers = await docker.listContainers({ all: true });
	return containers.some(c =>
		c.Mounts?.some(m => m.Type === 'volume' && m.Name === volumeName)
	);
}

export async function removeOrphanedVolumes(
	referencedVolumes: string[],
	opts?: VolumeCleanupOpts,
): Promise<void> {
	// CRITICAL: Acquire lock to prevent concurrent cleanup from multiple agents
	// Edge scenarios: systemd restart during update, debugging + production agent
	const lockId = await acquireVolumeLock('volume-cleanup', 30000);
	if (!lockId) {
		logger.logSystemEvent('volumeCleanupSkipped', {
			message: 'Could not acquire lock - another agent likely cleaning up volumes',
		});
		return; // Skip cleanup, other agent will handle it
	}
	
	try {
		// Iterate through every container, and track the
		// references to a volume
		// Note that we're not just interested in containers
		// which are part of the private state, and instead
		// *all* containers. This means we don't remove
		// something that's part of a sideloaded container
		const [dockerContainers, dockerVolumes] = await Promise.all([
			docker.listContainers({ all: true }),
			docker.listVolumes(),
		]);

		const containerVolumes = uniq(
			dockerContainers
				.flatMap((c) => c.Mounts)
				.filter((m) => m.Type === 'volume')
				.map((m) => m.Name as string),
		);
		
		// CRITICAL: Only consider volumes we own (edge rule: never delete what you didn't create)
		// Filter for volumes with our ownership label to avoid deleting:
		// - Third-party volumes (docker-compose stacks, other apps)
		// - User-created volumes (manual docker volume create)
		// - Debugging leftovers from other tools
		// - System volumes from other orchestrators
		const volumeNames = dockerVolumes.Volumes
			.filter((v) => v.Labels?.['iotistic.managed'] === 'true')
			.map((v) => v.Name);

		const volumesToRemove = difference(
			volumeNames,
			containerVolumes,
			// Don't remove any volume which is still referenced
			// in the target state
			referencedVolumes,
		);
		
		// Dry-run mode: Log what would be deleted
		if (opts?.dryRun) {
			logger.logSystemEvent('volumeCleanupDryRun', {
				wouldRemove: volumesToRemove,
				count: volumesToRemove.length,
				message: 'Dry-run mode: No volumes actually deleted',
			});
			return;
		}
		
		// CRITICAL: Re-check usage right before removal to prevent race conditions
		// Between listContainers/listVolumes and actual removal:
		// - Another container may have started
		// - Another agent instance may be running
		// - Docker daemon may have restarted
		// This turns a destructive race into a safe no-op
		await Promise.all(
			volumesToRemove.map(async (v) => {
				const stillUsed = await isVolumeInUse(v);
				if (!stillUsed) {
					logger.logSystemEvent('removeOrphanedVolume', {
						volume: { name: v },
					});
					await docker.getVolume(v).remove();
				} else {
					logger.logSystemEvent('volumeRaceConditionPrevented', {
						volume: { name: v },
						message: 'Volume became in-use between check and removal - skipping',
					});
				}
			}),
		);
	} finally {
		// CRITICAL: Always release lock, even on error
		await releaseVolumeLock(lockId);
	}
}

async function list(): Promise<VolumeInspectInfo[]> {
	const dockerResponse = await docker.listVolumes();
	return Array.isArray(dockerResponse.Volumes) ? dockerResponse.Volumes : [];
}
