import type { AgentInitContext } from './context.js';

export async function initDatabase(ctx: AgentInitContext): Promise<void> {
	await initializeDatabase(ctx);
}

export async function initializeDatabase(ctx: AgentInitContext): Promise<void> {
	const { initialized } = await import('../db/connection.js');
	await initialized(ctx.agentLogger);
}
