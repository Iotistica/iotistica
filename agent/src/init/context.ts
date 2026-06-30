import type { AgentLogger } from '../logging/agent-logger.js';
import type { FeatureInitializer } from './features.js';
import type { DiscoveryService } from '../discovery/service.js';
import type { DiscoveryRulesScheduler } from '../discovery/rules-scheduler.js';
import type { BackupScheduler } from '../db/backup-scheduler.js';
import type { AgentUpdater } from '../updater.js';
import type { AgentFirewall } from '../network/firewall.js';
import type { ConfigManager } from '../core/config.js';
import type { PipelineService } from '../features/pipeline/index.js';
import type { StateManager } from '../core/state.js';
import type { AgentManager } from '../core/index.js';
import type { AgentInfo } from '../core/types.js';
import type { ContainerManager } from '../containers/container-manager.js';
import type { CloudSync } from '../sync/index.js';
import type { DeviceAPI } from '../api/index.js';
import type { ContainerLogMonitor } from '../logging/container-monitor.js';
import type { DictionaryManager } from '../mqtt/dictionary.js';
import type { HttpClient } from '../lib/http-client.js';
import type { IncidentCorrelator } from '../anomaly/incident-correlator.js';

export interface AgentInitContext {
	agent: {
		stop: () => Promise<void>;
		getLifecycleState: () => string;
		isFullyOperational: () => boolean;
		restartServices: () => Promise<void>;
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
	anomalyService?: any;
	correlator?: IncidentCorrelator;
	pipelineService?: PipelineService;
	simulationOrchestrator?: any;
	discoveryService?: DiscoveryService;
	discoveryRulesScheduler?: DiscoveryRulesScheduler;
	backupScheduler?: BackupScheduler;
	dictionaryManager?: DictionaryManager;
}
