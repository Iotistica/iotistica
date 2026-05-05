import type { AgentLogger } from '../logging/agent-logger.js';
import type { FeatureInitializer } from './features.js';
import type { DiscoveryService } from '../adapters/discovery/service.js';
import type { AgentUpdater } from '../updater.js';
import type { AgentFirewall } from '../network/firewall.js';
import type { ConfigManager } from '../managers/config.js';
import type { PipelineService } from '../features/pipeline/index.js';

export interface AgentInitContext {
	agent: {
		stop: () => Promise<void>;
	};
	stateReconciler?: any;
	configManager?: ConfigManager;
	agentLogger?: AgentLogger;
	sharedHttpClient?: ReturnType<typeof import('../lib/http-client.js').createHttpClient>;
	deviceManager?: any;
	deviceInfo?: any;
	containerManager?: any;
	logMonitor?: any;
	deviceAPI?: any;
	cloudSync?: any;
	firewall?: AgentFirewall;
	updater?: AgentUpdater;
	featureInitializer?: FeatureInitializer;
	anomalyService?: any;
	pipelineService?: PipelineService;
	simulationOrchestrator?: any;
	discoveryService?: DiscoveryService;
	dictionaryManager?: any;
	scheduledRestartTimer?: NodeJS.Timeout;
}
