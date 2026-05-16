import type { AgentLogger } from '../logging/agent-logger.js';
import type { FeatureInitializer } from './features.js';
import type { DiscoveryService } from '../adapters/discovery/service.js';
import type { AgentUpdater } from '../updater.js';
import type { AgentFirewall } from '../network/firewall.js';
import type { ConfigManager } from '../runtime/config.js';
import type { PipelineService } from '../features/pipeline/index.js';
import type { AnomalyDetectionService } from '../anomaly/index.js';
import type { MqttConnection } from '../features/publish/types.js';
import type { StateManager } from '../runtime/state.js';
import type { AgentManager } from '../runtime/index.js';
import type { AgentInfo } from '../runtime/types.js';
import type { ContainerManager } from '../containers/container-manager.js';
import type { CloudSync } from '../sync/index.js';
import type { DeviceAPI } from '../api/index.js';
import type { ContainerLogMonitor } from '../logging/container-monitor.js';
import type { SimulationOrchestrator } from '../anomaly/simulator.js';
import type { DictionaryManager } from '../mqtt/dictionary.js';
import type { HttpClient } from '../lib/http-client.js';

export interface AgentInitContext {
	agent: {
		stop: () => Promise<void>;
	};
	stateReconciler?: StateManager;
	configManager?: ConfigManager;
	agentLogger?: AgentLogger;
	sharedHttpClient?: HttpClient;
	agentManager?: AgentManager;
	agentInfo?: AgentInfo;
	containerManager?: ContainerManager;
	logMonitor?: ContainerLogMonitor;
	agentAPI?: DeviceAPI;
	cloudSync?: CloudSync;
	firewall?: AgentFirewall;
	updater?: AgentUpdater;
	featureInitializer?: FeatureInitializer;
	anomalyService?: AnomalyDetectionService;
	pipelineService?: PipelineService;
	simulationOrchestrator?: SimulationOrchestrator;
	discoveryService?: DiscoveryService;
	dictionaryManager?: DictionaryManager;
	deviceConnection?: MqttConnection;
}
