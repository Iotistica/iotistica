import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { getDetector } from './detectors';
import type {
	AnomalyAlert,
	DetectionMethod,
	DetectorBaseline,
	MetricConfig,
	StatisticalBuffer,
} from './types';

export interface RunDetectionMethodsInput {
	metric: string;
	value: number;
	buffer: StatisticalBuffer;
	metricConfig: MetricConfig;
	detectorBaseline?: DetectorBaseline;
	minConfidence: number;
	logger?: AgentLogger;
	createAlert: (method: DetectionMethod, baselineSource: 'buffer' | 'database' | undefined, confidence: number, deviation: number, expectedRange: [number, number], message: string) => AnomalyAlert;
}

export interface RunDetectionMethodsResult {
	methodsToRun: DetectionMethod[];
	alerts: AnomalyAlert[];
	maxConfidence: number;
}

export function getMethodsToRun(metricConfig: MetricConfig): DetectionMethod[] {
	const methodsToRun = [...metricConfig.methods];
	if (metricConfig.expectedRange && !methodsToRun.includes('expected_range')) {
		methodsToRun.unshift('expected_range');
	}
	return methodsToRun;
}

export function runDetectionMethods(input: RunDetectionMethodsInput): RunDetectionMethodsResult {
	const methodsToRun = getMethodsToRun(input.metricConfig);
	const alerts: AnomalyAlert[] = [];
	let maxConfidence = 0;

	input.logger?.debugSync('Running detection methods', {
		component: LogComponents.anomaly,
		metric: input.metric,
		value: input.value,
		methods: methodsToRun.join(','),
		hasDbBaseline: !!input.detectorBaseline,
		bufferSize: input.buffer.size,
	});

	for (const method of methodsToRun) {
		const detector = getDetector(method);
		if (!detector) {
			input.logger?.warnSync(`Unknown detection method: ${method}`, {
				component: LogComponents.anomaly,
			});
			continue;
		}

		const result = detector.detect(
			input.value,
			input.buffer,
			input.metricConfig,
			input.detectorBaseline,
		);

		input.logger?.debugSync(`Detector result: ${method}`, {
			component: LogComponents.anomaly,
			metric: input.metric,
			method,
			isAnomaly: result.isAnomaly,
			confidence: result.confidence?.toFixed(3) ?? 'N/A',
			deviation: result.deviation?.toFixed(3) ?? 'N/A',
			expectedRange: `[${result.expectedRange?.[0]?.toFixed(2) ?? 'N/A'}, ${result.expectedRange?.[1]?.toFixed(2) ?? 'N/A'}]`,
			baselineSource: result.baselineSource || 'N/A',
			message: result.message,
		});

		if (result.confidence > maxConfidence) {
			maxConfidence = result.confidence;
		}

		if (result.isAnomaly && result.confidence >= input.minConfidence) {
			input.logger?.infoSync('Creating alert (confidence threshold met)', {
				component: LogComponents.anomaly,
				metric: input.metric,
				method,
				confidence: result.confidence?.toFixed(3) ?? 'N/A',
				minConfidence: input.minConfidence?.toFixed(3) ?? 'N/A',
			});

			alerts.push(
				input.createAlert(
					method,
					result.baselineSource,
					result.confidence,
					result.deviation,
					result.expectedRange,
					result.message,
				),
			);
		} else if (result.isAnomaly) {
			input.logger?.debugSync('Anomaly detected but confidence below threshold', {
				component: LogComponents.anomaly,
				metric: input.metric,
				method,
				confidence: result.confidence?.toFixed(3) ?? 'N/A',
				minConfidence: input.minConfidence?.toFixed(3) ?? 'N/A',
			});
		}
	}

	return {
		methodsToRun,
		alerts,
		maxConfidence,
	};
}
