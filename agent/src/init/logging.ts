import type { AgentInitContext } from './context.js';
import { LocalLogBackend } from '../logging/local-backend.js';
import { AgentLogger } from '../logging/agent-logger.js';
import type { LogLevel } from '../logging/types.js';
import { setLocalLogBackend } from '../api/actions.js';

export async function initLogging(ctx: AgentInitContext): Promise<void> {
	const loggingConfig = ctx.configManager!.getLoggingConfig();
	const logLevel = (loggingConfig.logLevel as LogLevel) || 'info';

	const localBackend = new LocalLogBackend({
		maxLogs: loggingConfig.maxLogs!,
		maxAge: loggingConfig.logMaxAge!,
		enableFilePersistence: loggingConfig.enableFilePersistence!,
		logDir: loggingConfig.logDir!,
		maxFileSize: loggingConfig.maxLogFileSize!,
	});

	await localBackend.initialize();
	setLocalLogBackend(localBackend);
	const agentLogger = new AgentLogger(localBackend, logLevel);
	ctx.agentLogger = agentLogger;
	ctx.stateReconciler!.setLogger(agentLogger);
}
