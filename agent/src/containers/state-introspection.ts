import { uniq } from '../lib/collection-utils';
import type { DeviceState } from './container-manager';

export interface ManagerStatus {
	isApplying: boolean;
	currentApps: number;
	targetApps: number;
	currentServices: number;
	targetServices: number;
}

export interface ReconciliationServiceStatus {
	serviceName: string;
	status: 'in-sync' | 'needs-update' | 'missing' | 'extra';
	reason?: string;
}

export interface ReconciliationAppStatus {
	appName: string;
	services: {
		[serviceId: number]: ReconciliationServiceStatus;
	};
}

export interface ReconciliationStatus {
	[appId: number]: ReconciliationAppStatus;
}

export function getManagerStatus(
	currentState: DeviceState,
	targetState: DeviceState,
	isApplying: boolean,
): ManagerStatus {
	return {
		isApplying,
		currentApps: Object.keys(currentState.apps).length,
		targetApps: Object.keys(targetState.apps).length,
		currentServices: Object.values(currentState.apps).reduce(
			(sum, app) => sum + app.services.length,
			0,
		),
		targetServices: Object.values(targetState.apps).reduce(
			(sum, app) => sum + app.services.length,
			0,
		),
	};
}

export function getReconciliationStatus(
	currentState: DeviceState,
	targetState: DeviceState,
): ReconciliationStatus {
	const status: ReconciliationStatus = {};

	const allAppIds = uniq([
		...Object.keys(currentState.apps).map(Number),
		...Object.keys(targetState.apps).map(Number),
	]);

	for (const appId of allAppIds) {
		const currentApp = currentState.apps[appId];
		const targetApp = targetState.apps[appId];

		if (!targetApp && currentApp) {
			status[appId] = {
				appName: currentApp.appName,
				services: {},
			};
			for (const svc of currentApp.services) {
				status[appId].services[svc.serviceId] = {
					serviceName: svc.serviceName,
					status: 'extra',
					reason: 'Service exists but not in target state',
				};
			}
			continue;
		}

		if (!targetApp) {
			continue;
		}

		status[appId] = {
			appName: targetApp.appName,
			services: {},
		};

		const currentServices = new Map(
			currentApp ? currentApp.services.map((s) => [s.serviceId, s]) : [],
		);
		const targetServices = new Map(targetApp.services.map((s) => [s.serviceId, s]));

		const allServiceIds = uniq([
			...currentServices.keys(),
			...targetServices.keys(),
		]);

		for (const serviceId of allServiceIds) {
			const currentSvc = currentServices.get(serviceId);
			const targetSvc = targetServices.get(serviceId);

			if (!targetSvc && currentSvc) {
				status[appId].services[serviceId] = {
					serviceName: currentSvc.serviceName,
					status: 'extra',
					reason: 'Service exists but not in target state',
				};
			} else if (!currentSvc && targetSvc) {
				status[appId].services[serviceId] = {
					serviceName: targetSvc.serviceName,
					status: 'missing',
					reason: 'Service not yet deployed',
				};
			} else if (currentSvc && targetSvc) {
				const imageChanged = currentSvc.imageName !== targetSvc.imageName;
				const portsChanged =
					JSON.stringify(currentSvc.config.ports || []) !==
					JSON.stringify(targetSvc.config.ports || []);
				const envChanged =
					JSON.stringify(currentSvc.config.environment || {}) !==
					JSON.stringify(targetSvc.config.environment || {});
				const volumesChanged =
					JSON.stringify(currentSvc.config.volumes || []) !==
					JSON.stringify(targetSvc.config.volumes || []);

				const currentStatus = currentSvc.status?.toLowerCase();
				const containerStopped =
					currentStatus === 'exited' ||
					currentStatus === 'stopped' ||
					currentStatus === 'dead';

				const needsUpdate =
					imageChanged ||
					portsChanged ||
					envChanged ||
					volumesChanged ||
					containerStopped;

				if (needsUpdate) {
					const reasons: string[] = [];
					if (imageChanged) {
						reasons.push('Image changed');
					}
					if (portsChanged) {
						reasons.push('Ports changed');
					}
					if (envChanged) {
						reasons.push('Environment changed');
					}
					if (volumesChanged) {
						reasons.push('Volumes changed');
					}
					if (containerStopped) {
						reasons.push('Container stopped');
					}

					status[appId].services[serviceId] = {
						serviceName: currentSvc.serviceName,
						status: 'needs-update',
						reason: reasons.join(', '),
					};
				} else {
					status[appId].services[serviceId] = {
						serviceName: currentSvc.serviceName,
						status: 'in-sync',
					};
				}
			}
		}
	}

	return status;
}

export function printStateDetails(state: DeviceState): void {
	const apps = Object.values(state.apps);
	if (apps.length === 0) {
		console.log('  (empty)');
		return;
	}

	apps.forEach((app) => {
		console.log(`  App ${app.appId}: ${app.appName}`);
		app.services.forEach((svc) => {
			console.log(`    - ${svc.serviceName} (${svc.imageName})`);
			if (svc.containerId) {
				console.log(`      Container: ${svc.containerId}`);
			}
		});
	});
}
