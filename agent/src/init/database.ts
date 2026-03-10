import type { AgentInitContext } from './core.js';

export async function initDatabase(ctx: AgentInitContext): Promise<void> {
	await initializeDatabase(ctx.self);
}

export async function initializeDatabase(agent: any): Promise<void> {
	const { initialized } = await import('../db/connection.js');
	await initialized(agent.agentLogger);
}
