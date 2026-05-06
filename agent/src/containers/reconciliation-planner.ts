import type { AppStep, ContainerService, DeviceApp } from './container-manager';

export interface PlannerService {
	config?: {
		networks?: string[];
		volumes?: string[];
	};
	networks?: string[];
	volumes?: string[];
}

export interface PlannerApp {
	services: PlannerService[];
}

export type PlannerContainerService = ContainerService;
export type PlannerContainerApp = DeviceApp;

export type PlannerStep = AppStep;

export interface AddAppPlanningCallbacks {
	onServiceSkippedNotRunning?: (service: PlannerContainerService) => void;
}

export interface UpdateAppPlanningCallbacks {
	shouldRetryImage?: (imageName: string) => boolean;
	onNewServiceSkippedNotRunning?: (service: PlannerContainerService) => void;
	onServiceNeedsAdd?: (service: PlannerContainerService) => void;
	onSkipImageRetryExceeded?: (service: PlannerContainerService) => void;
	onStateTransition?: (
		message: string,
		service: PlannerContainerService,
		from: string,
		to: string,
	) => void;
	onCannotPauseStopped?: (service: PlannerContainerService) => void;
	onServiceNeedsUpdate?: (
		service: PlannerContainerService,
		changes: string[],
	) => void;
}

/**
 * Reconcile network requirements for an app based on current and target services.
 */
export function reconcileNetworksForApp(
	appId: number,
	currentApp: PlannerApp | undefined,
	targetApp: PlannerApp | undefined,
): PlannerStep[] {
	const steps: PlannerStep[] = [];
	const currentNetworks = new Set<string>();
	const targetNetworks = new Set<string>();

	if (currentApp) {
		for (const service of currentApp.services) {
			const networks = service.config?.networks || service.networks;
			if (networks) {
				networks.forEach((net) => currentNetworks.add(net));
			}
		}
	}

	if (targetApp) {
		for (const service of targetApp.services) {
			const networks = service.config?.networks || service.networks;
			if (networks) {
				networks.forEach((net) => targetNetworks.add(net));
			}
		}
	}

	for (const networkName of targetNetworks) {
		if (!currentNetworks.has(networkName)) {
			steps.push({ action: 'createNetwork', appId, networkName });
		}
	}

	for (const networkName of currentNetworks) {
		if (!targetNetworks.has(networkName)) {
			steps.push({ action: 'removeNetwork', appId, networkName });
		}
	}

	return steps;
}

/**
 * Reconcile named volume requirements for an app based on current and target services.
 */
export function reconcileVolumesForApp(
	appId: number,
	currentApp: PlannerApp | undefined,
	targetApp: PlannerApp | undefined,
): PlannerStep[] {
	const steps: PlannerStep[] = [];
	const currentVolumes = new Set<string>();
	const targetVolumes = new Set<string>();

	if (currentApp) {
		for (const service of currentApp.services) {
			const volumes = service.config?.volumes || service.volumes;
			if (volumes) {
				for (const volume of volumes) {
					if (!volume.startsWith('/')) {
						const volumeName = volume.split(':')[0];
						currentVolumes.add(volumeName);
					}
				}
			}
		}
	}

	if (targetApp) {
		for (const service of targetApp.services) {
			const volumes = service.config?.volumes || service.volumes;
			if (volumes) {
				for (const volume of volumes) {
					if (!volume.startsWith('/')) {
						const volumeName = volume.split(':')[0];
						targetVolumes.add(volumeName);
					}
				}
			}
		}
	}

	for (const volumeName of targetVolumes) {
		if (!currentVolumes.has(volumeName)) {
			steps.push({ action: 'createVolume', appId, volumeName });
		}
	}

	for (const volumeName of currentVolumes) {
		if (!targetVolumes.has(volumeName)) {
			steps.push({ action: 'removeVolume', appId, volumeName });
		}
	}

	return steps;
}

/**
 * Plan steps for removing all containers for an app.
 */
export function planStepsToRemoveApp(app: PlannerContainerApp): PlannerStep[] {
	const steps: PlannerStep[] = [];

	for (const service of app.services) {
		if (service.containerId) {
			steps.push({
				action: 'stopContainer',
				appId: app.appId,
				serviceId: service.serviceId,
				containerId: service.containerId,
			});
			steps.push({
				action: 'removeContainer',
				appId: app.appId,
				serviceId: service.serviceId,
				containerId: service.containerId,
			});
		}
	}

	return steps;
}

/**
 * Plan steps for adding all runnable services for an app.
 */
export function planStepsToAddApp(
	app: PlannerContainerApp,
	callbacks?: AddAppPlanningCallbacks,
): PlannerStep[] {
	const steps: PlannerStep[] = [];

	for (const service of app.services) {
		const desiredState = service.state || 'running';
		if (desiredState !== 'running') {
			callbacks?.onServiceSkippedNotRunning?.(service);
			continue;
		}

		steps.push({
			action: 'downloadImage',
			appId: app.appId,
			imageName: service.imageName,
		});
		steps.push({
			action: 'startContainer',
			appId: app.appId,
			service,
		});
	}

	return steps;
}

/**
 * Plan steps for updating services in an app based on diff between current and target.
 */
export function planStepsToUpdateApp(
	current: PlannerContainerApp,
	target: PlannerContainerApp,
	callbacks?: UpdateAppPlanningCallbacks,
): PlannerStep[] {
	const steps: PlannerStep[] = [];

	const currentServices = new Map(current.services.map((s) => [s.serviceId, s]));
	const targetServices = new Map(target.services.map((s) => [s.serviceId, s]));

	const allServiceIds = new Set<number>([
		...currentServices.keys(),
		...targetServices.keys(),
	]);

	for (const serviceId of allServiceIds) {
		const currentSvc = currentServices.get(serviceId);
		const targetSvc = targetServices.get(serviceId);

		if (currentSvc && !targetSvc && currentSvc.containerId) {
			steps.push({
				action: 'stopContainer',
				appId: current.appId,
				serviceId,
				containerId: currentSvc.containerId,
			});
			steps.push({
				action: 'removeContainer',
				appId: current.appId,
				serviceId,
				containerId: currentSvc.containerId,
			});
		}

		if (!currentSvc && targetSvc) {
			const desiredState = targetSvc.state || 'running';
			if (desiredState !== 'running') {
				callbacks?.onNewServiceSkippedNotRunning?.(targetSvc);
				continue;
			}

			callbacks?.onServiceNeedsAdd?.(targetSvc);

			const canRetryImage = callbacks?.shouldRetryImage
				? callbacks.shouldRetryImage(targetSvc.imageName)
				: true;
			if (!canRetryImage) {
				callbacks?.onSkipImageRetryExceeded?.(targetSvc);
				continue;
			}

			steps.push({
				action: 'downloadImage',
				appId: target.appId,
				imageName: targetSvc.imageName,
			});
			steps.push({
				action: 'startContainer',
				appId: target.appId,
				service: targetSvc,
			});
		}

		if (currentSvc && targetSvc) {
			const currentState = currentSvc.state || 'running';
			const targetState = targetSvc.state || 'running';
			const stateChanged = currentState !== targetState;

			if (stateChanged && currentSvc.containerId) {
				if (currentState === 'running' && targetState === 'stopped') {
					callbacks?.onStateTransition?.(
						'Service state changed to stopped',
						currentSvc,
						currentState,
						targetState,
					);
					steps.push({
						action: 'stopContainer',
						appId: current.appId,
						serviceId,
						containerId: currentSvc.containerId,
					});
					continue;
				}

				if (currentState === 'running' && targetState === 'paused') {
					callbacks?.onStateTransition?.(
						'Service state changed to paused',
						currentSvc,
						currentState,
						targetState,
					);
					steps.push({
						action: 'pauseContainer',
						appId: current.appId,
						serviceId,
						containerId: currentSvc.containerId,
					});
					continue;
				}

				if (currentState === 'stopped' && targetState === 'running') {
					callbacks?.onStateTransition?.(
						'Service state changed to running (restarting stopped container)',
						currentSvc,
						currentState,
						targetState,
					);
					steps.push({
						action: 'startStoppedContainer',
						appId: current.appId,
						serviceId,
						containerId: currentSvc.containerId,
					});
					continue;
				}

				if (currentState === 'paused' && targetState === 'running') {
					callbacks?.onStateTransition?.(
						'Service state changed from paused to running',
						currentSvc,
						currentState,
						targetState,
					);
					steps.push({
						action: 'unpauseContainer',
						appId: current.appId,
						serviceId,
						containerId: currentSvc.containerId,
					});
					continue;
				}

				if (currentState === 'paused' && targetState === 'stopped') {
					callbacks?.onStateTransition?.(
						'Service state changed from paused to stopped',
						currentSvc,
						currentState,
						targetState,
					);
					steps.push({
						action: 'unpauseContainer',
						appId: current.appId,
						serviceId,
						containerId: currentSvc.containerId,
					});
					steps.push({
						action: 'stopContainer',
						appId: current.appId,
						serviceId,
						containerId: currentSvc.containerId,
					});
					continue;
				}

				if (currentState === 'stopped' && targetState === 'paused') {
					callbacks?.onCannotPauseStopped?.(currentSvc);
					steps.push({
						action: 'startStoppedContainer',
						appId: current.appId,
						serviceId,
						containerId: currentSvc.containerId,
					});
					steps.push({
						action: 'pauseContainer',
						appId: current.appId,
						serviceId,
						containerId: currentSvc.containerId,
					});
					continue;
				}
			}

			const imageChanged = currentSvc.imageName !== targetSvc.imageName;

			const currentPorts = JSON.stringify((currentSvc.config.ports || []).sort());
			const targetPorts = JSON.stringify((targetSvc.config.ports || []).sort());
			const portsChanged = currentPorts !== targetPorts;

			const targetEnvKeys = Object.keys(targetSvc.config.environment || {});
			const filteredCurrentEnv: Record<string, string> = {};
			for (const key of targetEnvKeys) {
				if (currentSvc.config.environment && key in currentSvc.config.environment) {
					filteredCurrentEnv[key] = currentSvc.config.environment[key];
				}
			}
			const currentEnv = JSON.stringify(filteredCurrentEnv);
			const targetEnv = JSON.stringify(targetSvc.config.environment || {});
			const envChanged = currentEnv !== targetEnv;

			const currentVolumes = JSON.stringify((currentSvc.config.volumes || []).sort());
			const targetVolumes = JSON.stringify((targetSvc.config.volumes || []).sort());
			const volumesChanged = currentVolumes !== targetVolumes;

			const currentNetworks = JSON.stringify((currentSvc.config.networks || []).sort());
			const targetNetworks = JSON.stringify((targetSvc.config.networks || []).sort());
			const networksChanged = currentNetworks !== targetNetworks;

			const currentRestart = currentSvc.config.restart || 'no';
			const targetRestart = targetSvc.config.restart || 'no';
			const restartChanged =
				targetSvc.config.restart !== undefined && currentRestart !== targetRestart;

			const currentNetworkMode = currentSvc.config.networkMode || 'bridge';
			const targetNetworkMode = targetSvc.config.networkMode || 'bridge';
			const networkModeChanged =
				targetSvc.config.networkMode !== undefined &&
				currentNetworkMode !== targetNetworkMode;

			const configChanged =
				portsChanged ||
				envChanged ||
				volumesChanged ||
				networksChanged ||
				restartChanged ||
				networkModeChanged;

			const status = currentSvc.status?.toLowerCase();
			const containerStopped =
				status === 'exited' || status === 'stopped' || status === 'dead';

			const needsUpdate = imageChanged || configChanged || containerStopped;
			if (needsUpdate) {
				const changes: string[] = [];
				if (imageChanged) {
					changes.push(`image: ${currentSvc.imageName} -> ${targetSvc.imageName}`);
				}
				if (portsChanged) {
					changes.push(`ports: ${currentPorts} -> ${targetPorts}`);
				}
				if (envChanged) {
					changes.push('environment changed');
				}
				if (volumesChanged) {
					changes.push(`volumes: ${currentVolumes} -> ${targetVolumes}`);
				}
				if (networksChanged) {
					changes.push(`networks: ${currentNetworks} -> ${targetNetworks}`);
				}
				if (restartChanged) {
					changes.push(`restart: ${currentRestart} -> ${targetRestart}`);
				}
				if (networkModeChanged) {
					changes.push(
						`networkMode: ${currentNetworkMode} -> ${targetNetworkMode}`,
					);
				}
				if (containerStopped) {
					changes.push(`container stopped: ${currentSvc.status}`);
				}

				callbacks?.onServiceNeedsUpdate?.(currentSvc, changes);
			}

			if (needsUpdate && currentSvc.containerId) {
				if (currentSvc.imageName !== targetSvc.imageName) {
					steps.push({
						action: 'downloadImage',
						appId: target.appId,
						imageName: targetSvc.imageName,
					});
				}

				steps.push({
					action: 'stopContainer',
					appId: current.appId,
					serviceId,
					containerId: currentSvc.containerId,
				});
				steps.push({
					action: 'removeContainer',
					appId: current.appId,
					serviceId,
					containerId: currentSvc.containerId,
				});
				steps.push({
					action: 'startContainer',
					appId: target.appId,
					service: targetSvc,
				});
			}
		}
	}

	return steps;
}
