import type { DeviceState } from './container-manager';

/**
 * Sanitize state to ensure all data is in correct format.
 */
export function sanitizeState(state: DeviceState): void {
	for (const app of Object.values(state.apps)) {
		if (typeof app.appId === 'string') {
			app.appId = parseInt(app.appId, 10);
		}

		for (const service of app.services) {
			if (typeof service.serviceId === 'string') {
				service.serviceId = parseInt(service.serviceId, 10);
			}

			const flatService = service as any;
			if (!service.config) {
				service.config = {
					image: flatService.image || 'unknown',
				};
			}

			if (flatService.image && !service.imageName) {
				service.imageName = flatService.image;
				service.config.image = flatService.image;
			}

			if (flatService.environment && !service.config.environment) {
				service.config.environment = flatService.environment;
			}
			if (flatService.ports && !service.config.ports) {
				service.config.ports = flatService.ports;
			}
			if (flatService.volumes && !service.config.volumes) {
				service.config.volumes = flatService.volumes;
			}
			if (flatService.networks && !service.config.networks) {
				service.config.networks = flatService.networks;
			}
			if (flatService.restart && !service.config.restart) {
				service.config.restart = flatService.restart;
			}
			if (flatService.labels && !service.config.labels) {
				service.config.labels = flatService.labels;
			}

			if (!service.appId) {
				service.appId = app.appId;
			}
			if (!service.appName) {
				service.appName = app.appName;
			}

			if (service.config.ports) {
				service.config.ports = service.config.ports.map((port) =>
					typeof port === 'string' ? port : String(port),
				);
			}

			if (service.config.environment) {
				const sanitizedEnv: Record<string, string> = {};
				for (const [key, value] of Object.entries(service.config.environment)) {
					sanitizedEnv[key] = typeof value === 'string' ? value : String(value);
				}
				service.config.environment = sanitizedEnv;
			}

			if (service.config.volumes) {
				service.config.volumes = service.config.volumes.map((vol) =>
					typeof vol === 'string' ? vol : String(vol),
				);
			}
		}
	}
}
