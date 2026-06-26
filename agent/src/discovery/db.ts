/** Discovery persistence store for endpoints and staleness checks. */
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import { EndpointModel, type Endpoint } from '../db/models/endpoint.model.js';
import { ProtocolDevicesModel } from '../db/models/index.js';
import type { DiscoveredDevice } from '../plugins/types.js';
import type { ConfigManager } from '../core/config.js';

export class DiscoveryStore {
	constructor(
    private logger?: AgentLogger,
    private configManager?: ConfigManager,
    private emit: (event: string, ...args: any[]) => void = () => {}
	) {}

	async save(
		discovered: DiscoveredDevice[],
		traceId: string,
		updateOnly: boolean = false
	): Promise<{ saved: number; skipped: number }> {
		if (discovered.length === 0) {
			this.logger?.debugSync('No discovered endpoints to save', {
				component: LogComponents.discovery,
				traceId
			});
			return { saved: 0, skipped: 0 };
		}

		if (updateOnly) {
			this.logger?.debugSync('Discovery running in update-only mode', {
				component: LogComponents.discovery,
				traceId,
				discoveredCount: discovered.length,
				mode: 'update-existing-only'
			});
		}

		const existingEndpoints = await EndpointModel.getAll();

		const targetEndpoints = this.configManager?.getTargetConfig().endpoints || [];
		const targetEndpointByName = new Map(
			targetEndpoints.map((endpoint: any) => [endpoint.name, endpoint])
		);

		this.logger?.infoSync('Checking for existing endpoints in database', {
			component: LogComponents.discovery,
			existingCount: existingEndpoints.length,
			discoveredCount: discovered.length,
			existingNames: existingEndpoints.map(s => s.name)
		});

		let saved = 0;
		let skipped = 0;
		const savedDevices: Array<{ name: string; protocol: string; confidence: string }> = [];
		const skippedDevices: Array<{ name: string; protocol: string; reason: string }> = [];

		for (const device of discovered) {
			try {

				const existingByFingerprint = existingEndpoints.find(s =>
					s.metadata?.fingerprint === device.fingerprint
				);
				const existingByName = existingEndpoints.find(s =>
					s.name === device.name
				);
				const existingByEndpointUrl = device.protocol === 'opcua'
					? existingEndpoints.find(s =>
						s.protocol === 'opcua' &&
              s.connection?.endpointUrl === device.connection?.endpointUrl
					)
					: undefined;

				const existing = existingByFingerprint || existingByName || existingByEndpointUrl;

				if (existing) {
					const matchType = existingByFingerprint ? 'fingerprint' :
						existingByName ? 'name' :
							existingByEndpointUrl ? 'endpointUrl' : 'unknown';
					if (matchType === 'endpointUrl') {
						this.logger?.infoSync('Matched discovered device to existing by endpointUrl', {
							component: LogComponents.discovery,
							traceId,
							existingName: existing.name,
							discoveredName: device.name,
							endpointUrl: device.connection?.endpointUrl,
							willUpdate: true
						});
					}

					const deviceConnectionKeys = Object.keys(device.connection || {});
					const existingConnectionSubset = Object.fromEntries(
						deviceConnectionKeys.map((k) => [k, (existing.connection as any)?.[k]])
					);
					const configChanged = JSON.stringify(existingConnectionSubset) !== JSON.stringify(device.connection);
					const fingerprintChanged = existing.metadata?.fingerprint !== device.fingerprint;
					const existingProfile = existing.metadata?.profile || 'Generic';
					const newProfile = device.metadata?.profile || 'Generic';
					const profileChanged = existingProfile !== newProfile;
					// Don't overwrite existing populated data_points with an empty validation result
					const wouldClearDataPoints = (existing.data_points?.length ?? 0) > 0 && (device.dataPoints?.length ?? 0) === 0;
					const dataPointsChanged = !wouldClearDataPoints && JSON.stringify(existing.data_points) !== JSON.stringify(device.dataPoints);
					const validationChanged = device.validated && !existing.metadata?.validated;

					this.logger?.debugSync(`Configuration comparison for "${device.name}"`, {
						component: LogComponents.discovery,
						traceId,
						configChanged: profileChanged || dataPointsChanged || validationChanged,
						dataPointsCount: device.dataPoints?.length || 0,
						dataPointsChanged,
						validationChanged
					});

					if (profileChanged || dataPointsChanged || validationChanged) {
						const reason = profileChanged ? 'Profile changed' : 'Data points changed (same profile)';
						this.logger?.warnSync(`${reason} for "${existing.name}" - updating configuration`, {
							component: LogComponents.discovery,
							traceId,
							existingName: existing.name,
							discoveredName: device.name,
							oldProfile: existingProfile,
							newProfile,
							oldDataPoints: existing.data_points?.length || 0,
							newDataPoints: device.dataPoints?.length || 0,
							profileChanged,
							dataPointsChanged
						});

						this.logger?.infoSync('Updating device with discovered nodes', {
							component: LogComponents.discovery,
							traceId,
							deviceName: existing.name,
							protocol: device.protocol,
							dataPointsCount: device.dataPoints?.length || 0,
							sampleNodes: device.dataPoints?.slice(0, 3).map(dp => ({
								nodeId: dp.nodeId,
								name: dp.name || dp.address
							}))
						});

						await EndpointModel.update(existing.name, {
							data_points: device.dataPoints || [],
							metadata: {
								...existing.metadata,
								...device.metadata,
								confidence: device.confidence,
								validated: device.validated,
								dataPointValidation: undefined
							},
							lastSeenAt: new Date()
						});

						this.logger?.infoSync('Database update complete', {
							component: LogComponents.discovery,
							traceId,
							deviceName: existing.name,
							updatedDataPoints: device.dataPoints?.length || 0,
							operation: 'DeviceEndpointModel.update'
						});

						const updatedDevice = await EndpointModel.getByName(existing.name);
						if (updatedDevice) {
							await ProtocolDevicesModel.syncFromEndpoint(updatedDevice);
							this.logger?.infoSync('Verified data persisted to database', {
								component: LogComponents.discovery,
								traceId,
								deviceName: existing.name,
								persistedDataPoints: updatedDevice.data_points?.length || 0,
								samplePersistedNodes: updatedDevice.data_points?.slice(0, 3).map(dp => ({
									nodeId: dp.nodeId,
									name: dp.name || dp.address
								}))
							});
						} else {
							this.logger?.errorSync(
								'Failed to verify database update - device not found',
								new Error('Device not found after update'),
								{ component: LogComponents.discovery, traceId, deviceName: existing.name }
							);
						}

						if (existing.enabled) {
							this.emit('endpoint-enabled', {
								protocol: device.protocol,
								endpoint: {
									...existing,
									data_points: device.dataPoints || [],
									metadata: { ...existing.metadata, profile: device.metadata?.profile }
								},
								isBatchDiscovery: !!traceId,
								profileChanged: true
							});
						}

						saved++;
						savedDevices.push({
							name: existing.name,
							protocol: device.protocol,
							confidence: device.confidence || 'updated'
						});
						continue;

					} else {
						await EndpointModel.updateLastSeen(device.fingerprint);

						if (configChanged) {
							this.logger?.debugSync(`Device "${device.name}" moved/reconfigured`, {
								component: LogComponents.discovery,
								traceId,
								oldConnection: existing.connection,
								newConnection: device.connection
							});
						} else if (fingerprintChanged) {
							this.logger?.debugSync(`Device "${device.name}" fingerprint changed (dynamic data)`, {
								component: LogComponents.discovery,
								traceId,
								oldFingerprint: existing.metadata?.fingerprint,
								newFingerprint: device.fingerprint
							});
						} else {
							this.logger?.debugSync(`Device "${device.name}" already known - skipping`, {
								component: LogComponents.discovery,
								traceId,
								protocol: device.protocol,
								lastSeen: existing.lastSeenAt
							});
						}
						skipped++;
						skippedDevices.push({
							name: device.name,
							protocol: device.protocol,
							reason: configChanged ? 'moved' : (fingerprintChanged ? 'fingerprint_changed' : 'already_exists')
						});
						continue;
					}
				}

				if (updateOnly) {
					this.logger?.debugSync('Skipping new device creation (update-only mode)', {
						component: LogComponents.discovery,
						traceId,
						deviceName: device.name,
						protocol: device.protocol,
						endpointUrl: device.connection?.endpointUrl,
						reason: 'reconcile-creates-records'
					});
					skipped++;
					skippedDevices.push({ name: device.name, protocol: device.protocol, reason: 'update_only_mode' });
					continue;
				}

				let endpointEnabled = false;
				const targetEndpoint = device.metadata?.connectionName
					? targetEndpointByName.get(device.metadata.connectionName)
					: targetEndpointByName.get(device.name);

				if (targetEndpoint?.enabled !== undefined) {
					endpointEnabled = Boolean(targetEndpoint.enabled);
				} else if (device.metadata?.connectionName && this.configManager) {
					const modbusConfig = this.configManager.getModbusConfig();
					const parentConn = modbusConfig.connections?.find(
						(c: any) => c.name === device.metadata?.connectionName
					);
					endpointEnabled = parentConn?.enabled ?? false;
				}

				const endpoint: Endpoint = {
					name: device.name,
					protocol: device.protocol as 'modbus' | 'can' | 'opcua' | 'mqtt',
					enabled: endpointEnabled,
					poll_interval: 5000,
					connection: device.connection,
					data_points: device.dataPoints || [],
					lastSeenAt: new Date(),
					metadata: {
						...device.metadata,
						fingerprint: device.fingerprint,
						confidence: device.confidence,
						validated: device.validated,
						discoveredAt: device.discoveredAt,
						...(targetEndpoint?.id && { discoveryParentId: targetEndpoint.id }),
						...(device.validationData && {
							manufacturer: device.validationData.manufacturer,
							modelNumber: device.validationData.modelNumber,
							firmwareVersion: device.validationData.firmwareVersion,
							capabilities: device.validationData.capabilities,
							deviceInfo: device.validationData.deviceInfo,
							dataPointValidation: device.validationData.dataPointValidation
						})
					}
				};

				if (targetEndpoint?.id) {
					this.logger?.infoSync('Discovered device linked to parent', {
						component: LogComponents.discovery,
						traceId,
						deviceName: device.name,
						parentId: targetEndpoint.id,
						parentName: targetEndpoint.name,
						connectionName: device.metadata?.connectionName
					});
				} else {
					this.logger?.warnSync('Discovered device has no parent tracking - parent endpoint not found', {
						component: LogComponents.discovery,
						traceId,
						deviceName: device.name,
						protocol: device.protocol,
						connectionName: device.metadata?.connectionName,
						availableTargetEndpoints: Array.from(targetEndpointByName.entries()).map(([name, ep]: [string, any]) => ({
							name,
							id: ep?.id,
							protocol: ep?.protocol
						}))
					});
				}

				const createdEndpoint = await EndpointModel.create(endpoint);
				await ProtocolDevicesModel.syncFromEndpoint(createdEndpoint);
				saved++;
				savedDevices.push({
					name: device.name,
					protocol: device.protocol,
					confidence: device.confidence || 'unknown'
				});

				if (endpoint.enabled) {
					this.emit('endpoint-enabled', {
						protocol: device.protocol,
						endpoint: endpoint,
						isBatchDiscovery: !!traceId
					});
				}
			} catch (error) {
				this.logger?.errorSync(
					`Failed to save device "${device.name}"`,
          error as Error,
          { component: LogComponents.discovery, traceId }
				);
			}
		}

		this.logger?.debugSync(
			`Discovery complete: ${saved} new, ${skipped} existing`,
			{
				component: LogComponents.discovery,
				traceId,
				saved: savedDevices.length > 0 ? savedDevices : undefined,
				skipped: skippedDevices.length > 0 ? skippedDevices : undefined,
			}
		);

		await this.checkStale(traceId);

		return { saved, skipped };
	}

	async checkStale(traceId: string, daysThreshold = 7): Promise<void> {
		try {
			const staleDevices = await EndpointModel.getStaleDevices(daysThreshold);
			if (staleDevices.length > 0) {
				this.logger?.warnSync(
					`Found ${staleDevices.length} stale devices (not seen in ${daysThreshold}+ days)`,
					{
						component: LogComponents.discovery,
						traceId,
						staleCount: staleDevices.length,
						devices: staleDevices.map(d => ({
							name: d.name,
							protocol: d.protocol,
							lastSeenAt: d.lastSeenAt,
							fingerprint: d.metadata?.fingerprint
						}))
					}
				);
			}
		} catch (error) {
			this.logger?.debugSync('Failed to check stale devices', {
				component: LogComponents.discovery,
				traceId,
				error: (error as Error).message
			});
		}
	}
}
