/**
 * Pro module loader.
 *
 * The Community edition calls these helpers whenever it needs a Pro feature.
 * If @iotistica/pro is not installed (Community build), every helper returns null
 * and the calling code skips the feature gracefully — no errors, no stubs.
 *
 * The Pro package is a private npm package distributed only to Pro customers.
 * Installing it alongside the Community base activates all Pro features.
 */

const PRO_PKG = '@iotistica/agent-pro'

async function tryLoad<T>(subpath: string): Promise<T | null> {
	try {
		return (await import(`${PRO_PKG}/${subpath}`)) as T
	} catch {
		return null
	}
}

export async function loadShellHandler(): Promise<{ ShellHandler: any } | null> {
	return tryLoad('shell')
}

export async function loadJobsFeature(): Promise<{ JobsFeature: any } | null> {
	return tryLoad('jobs')
}

export async function loadAnomalyDetection(): Promise<{ AnomalyDetectionService: any; loadConfigFromTargetState: any } | null> {
	return tryLoad('anomaly')
}

export async function loadSimulationModule(): Promise<{ SimulationOrchestrator: any; loadSimulationConfig: any } | null> {
	return tryLoad('anomaly')
}

export async function loadAzureDestination(): Promise<{ AzurePublishPlugin: any } | null> {
	return tryLoad('destinations/azure')
}

export async function loadAwsDestination(): Promise<{ AwsPublishPlugin: any } | null> {
	return tryLoad('destinations/aws')
}

export async function loadGcpDestination(): Promise<{ GcpPublishPlugin: any } | null> {
	return tryLoad('destinations/gcp')
}

export async function loadInfluxDbDestination(): Promise<{ InfluxDbPublishPlugin: any } | null> {
	return tryLoad('destinations/influxdb')
}

/** Returns true when the Pro package is resolvable in the current node_modules.
 *  Set PRO_FORCE=true to bypass the check (dev/testing only). */
export function isProInstalled(): boolean {
	if (process.env.PRO_FORCE === 'true') return true
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		require.resolve(PRO_PKG)
		return true
	} catch {
		return false
	}
}
