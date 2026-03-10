/**
 * Compose-specific errors
 */

export class InvalidNetworkNameError extends Error {
	constructor(name: string) {
		super(`Invalid network name: ${name}`);
		this.name = 'InvalidNetworkNameError';
	}
}

export class ResourceRecreationAttemptError extends Error {
	constructor(resourceType: string, resourceName: string) {
		super(
			`Attempting to recreate ${resourceType} '${resourceName}', but it already exists with different configuration. ` +
			`Resource recreation requires manual intervention.`
		);
		this.name = 'ResourceRecreationAttemptError';
	}
}
