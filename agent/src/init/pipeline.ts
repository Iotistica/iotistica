import path from 'path';
import fs from 'fs';
import { LogComponents } from '../logging/types.js';
import type { AgentInitContext } from './context.js';

/**
 * Initialize the Node-RED payload transform pipeline.
 *
 * Controlled entirely by environment variables - no DB/config-system changes needed:
 *   ENABLE_EMBEDDED_NODE_RED - must be set to 'true' to allow the in-process runtime
 *   PIPELINE_FLOWS_FILE  - absolute or cwd-relative path to a flows JSON file (required to enable)
 *   PIPELINE_TIMEOUT_MS  - per-transform timeout in ms (default: 5000)
 *
 * If PIPELINE_FLOWS_FILE is not set, or embedded Node-RED is not explicitly enabled,
 * the pipeline is skipped (fail-open).
 */
export async function initPipeline(ctx: AgentInitContext): Promise<void> {
	const logger = ctx.agentLogger;
	const flowsFile = process.env['PIPELINE_FLOWS_FILE'];
	const embeddedNodeRedEnabled = process.env['ENABLE_EMBEDDED_NODE_RED'] === 'true';

	if (!flowsFile) {
		logger?.debugSync('Pipeline not configured (PIPELINE_FLOWS_FILE not set)', {
			component: LogComponents.agent,
		});
		return;
	}

	if (!embeddedNodeRedEnabled) {
		logger?.warnSync('Pipeline configured but embedded Node-RED is disabled', {
			component: LogComponents.agent,
			message: 'Set ENABLE_EMBEDDED_NODE_RED=true to allow the in-process pipeline runtime',
			flowsFile,
		});
		return;
	}

	// Stop any existing pipeline instance before reinitializing
	if (ctx.pipelineService) {
		logger?.infoSync('Stopping existing pipeline before reinitializing', {
			component: LogComponents.agent,
		});
		await ctx.pipelineService.stop();
		ctx.pipelineService = undefined;
	}

	const resolvedFlows = (() => {
		const candidate = path.isAbsolute(flowsFile)
			? flowsFile
			: path.resolve(process.cwd(), flowsFile);

		if (fs.existsSync(candidate)) return candidate;

		// Fall back to the built-in flows bundled with the dist (same basename)
		const builtIn = path.resolve(__dirname, '../features/pipeline/flows', path.basename(flowsFile));
		if (fs.existsSync(builtIn)) {
			logger?.warnSync(`Flows file not found at '${candidate}', falling back to built-in: ${builtIn}`, {
				component: LogComponents.agent,
			});
			return builtIn;
		}

		return candidate; // Let PipelineService produce the descriptive ENOENT
	})();

	const timeoutMs = parseInt(process.env['PIPELINE_TIMEOUT_MS'] ?? '5000', 10);


	try {
		const { PipelineService } = await import('../features/pipeline/index.js');

		const pipelineLogger = {
			debug: (msg: string, ...a: unknown[]) => logger?.debugSync(msg, { component: LogComponents.agent, ...a[0] as object }),
			info:  (msg: string, ...a: unknown[]) => logger?.infoSync(msg,  { component: LogComponents.agent, ...a[0] as object }),
			warn:  (msg: string, ...a: unknown[]) => logger?.warnSync(msg,  { component: LogComponents.agent, ...a[0] as object }),
			error: (msg: string, ...a: unknown[]) => logger?.errorSync(msg, undefined, { component: LogComponents.agent, ...a[0] as object }),
		};

		const pipeline = new PipelineService({
			flows: resolvedFlows,
			agentUuid: ctx.agentInfo?.uuid ?? '',
			timeoutMs,
			logger: pipelineLogger,
		});

		await pipeline.start();

		ctx.pipelineService = pipeline;

		logger?.infoSync('Pipeline initialized', {
			component: LogComponents.agent,
			flowsFile: resolvedFlows,
		});
	} catch (error: any) {
		if (error?.code === 'MODULE_NOT_FOUND' || String(error?.message || '').includes("Cannot find module 'node-red'")) {
			logger?.warnSync('Embedded Node-RED runtime not installed', {
				component: LogComponents.agent,
				flowsFile: resolvedFlows,
				message: 'Install node-red separately if you need the optional pipeline runtime',
			});
			ctx.pipelineService = undefined;
			return;
		}

		logger?.errorSync(
			'Failed to initialize pipeline — continuing without transform',
			error as Error,
			{ component: LogComponents.agent, flowsFile: resolvedFlows },
		);
		ctx.pipelineService = undefined;
	}
}
