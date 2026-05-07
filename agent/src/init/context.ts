import type { AgentLogger } from '../logging/agent-logger.js';
import type { FeatureInitializer } from './features.js';
import type { DiscoveryService } from '../adapters/discovery/service.js';
import type { AgentUpdater } from '../updater.js';
import type { AgentFirewall } from '../network/firewall.js';
import type { ConfigManager } from '../agent/config.js';
import type { PipelineService } from '../features/pipeline/index.js';
import type { AnomalyDetectionService } from '../anomaly/index.js';
import type { MqttConnection } from '../features/publish/types.js';

export interface AgentInitContext {
	agent: {
		stop: () => Promise<void>;
	};
	stateReconciler?: any;
	configManager?: ConfigManager;
	agentLogger?: AgentLogger;
	// eslint-disable-next-line @typescript-eslint/consistent-type-imports
	sharedHttpClient?: ReturnType<typeof import('../lib/http-client.js').createHttpClient>;
	agentManager?: any;
	agentInfo?: any;
	containerManager?: any;
	logMonitor?: any;
	agentAPI?: any;
	cloudSync?: any;
	firewall?: AgentFirewall;
	updater?: AgentUpdater;
	featureInitializer?: FeatureInitializer;
	anomalyService?: AnomalyDetectionService;
	pipelineService?: PipelineService;
	simulationOrchestrator?: any;
	discoveryService?: DiscoveryService;
	dictionaryManager?: any;
	scheduledRestartTimer?: NodeJS.Timeout;
	sensorConnection?: MqttConnection;
}
