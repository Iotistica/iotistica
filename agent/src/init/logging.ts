import type { AgentInitContext } from './core.js';
import { LocalLogBackend } from '../logging/local-backend.js';
import { AgentLogger } from '../logging/agent-logger.js';
import type { LogLevel } from '../logging/types.js';

export async function initLogging(ctx: AgentInitContext): Promise<void> {
	const loggingConfig = ctx.logging.getLoggingConfig();
	const logLevel = (loggingConfig.logLevel as LogLevel) || 'info';

	const localBackend = new LocalLogBackend({
		maxLogs: loggingConfig.maxLogs!,
		maxAge: loggingConfig.logMaxAge!,
		enableFilePersistence: loggingConfig.enableFilePersistence!,
		logDir: loggingConfig.logDir!,
		maxFileSize: loggingConfig.maxLogFileSize!,
	});

	await localBackend.initialize();
	const agentLogger = new AgentLogger(localBackend, logLevel);
	ctx.logging.setAgentLogger(agentLogger);
	ctx.logging.setStateReconcilerLogger(agentLogger);
}
