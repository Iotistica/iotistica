export function isStandaloneMode(): boolean {
	return process.env.STANDALONE === 'true';
}
