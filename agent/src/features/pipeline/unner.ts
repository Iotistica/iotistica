/**
 * POC runner – execute directly with tsx:
 *
 *   cd agent
 *   npx tsx src/features/pipeline/poc-runner.ts
 *
 * Switch to a different flows file:
 *   FLOWS=./src/features/pipeline/flows/opcua-transform.flows.json \
 *   npx tsx src/features/pipeline/poc-runner.ts
 *
 * ── How to wire into PublishManager (production) ────────────────────────────
 *
 *   import { PipelineService } from './features/pipeline/index.js';
 *
 *   const pipeline = new PipelineService({
 *     flows: '/data/flows/my-transform.json',
 *     timeoutMs: 5000,
 *     logger,
 *   });
 *   await pipeline.start();
 *
 *   // Each PublishManager (one per endpoint) gets the same service instance:
 *   publishManager.setPipelineService(pipeline);
 *
 *   // The pipeline runs automatically before every MQTT publish.
 *   // Set msg.drop = true in your flow to discard and skip publishing.
 *   // On pipeline error the original payload is published unchanged (fail-open).
 */

import path from 'path';
import { PipelineService } from './pipeline.service.js';
import { agentTopic, setTenantId } from '../../mqtt/topics.js';

const FLOWS_FILE =
  process.env['FLOWS'] ??
  path.join(__dirname, 'flows', 'example-enrich.flows.json');

setTenantId(process.env['MQTT_TENANT_ID'] ?? 'demo-tenant');

// ── Simple console logger ────────────────────────────────────────────────────
const logger = {
	debug: (msg: string, ...a: unknown[]) => console.debug('[pipeline:debug]', msg, ...a),
	info:  (msg: string, ...a: unknown[]) => console.info( '[pipeline:info] ', msg, ...a),
	warn:  (msg: string, ...a: unknown[]) => console.warn( '[pipeline:warn] ', msg, ...a),
	error: (msg: string, ...a: unknown[]) => console.error('[pipeline:error]', msg, ...a),
};

// ── Sample payloads to transform ─────────────────────────────────────────────
// When FLOWS points to opcua-transform.flows.json, use OPC UA batch payloads.
// Otherwise fall back to simple ADC payloads.

const isOpcuaFlow = FLOWS_FILE.includes('opcua');

const testMessages = isOpcuaFlow
	? [
		// Normal batch – two good-quality readings, one bad
		{
			payload: {
				device: 'plc-001',
				timestamp: new Date().toISOString(),
				messages: [
					{ timestamp: new Date().toISOString(), deviceName: 'plc-001', metric: 'ns2_Temperature', value: 22.5,  unit: '°C',  quality: 'good' },
					{ timestamp: new Date().toISOString(), deviceName: 'plc-001', metric: 'pressure',        value: 150000, unit: 'Pa',  quality: 'good' },
					{ timestamp: new Date().toISOString(), deviceName: 'plc-001', metric: 'humidity',        value: 65,     unit: '%',   quality: 'bad'  },
				],
			},
			topic: agentTopic('abc', 'endpoints', 'plc-001'),
			deviceId: 'plc-001',
		},
		// All-bad batch → should be dropped
		{
			payload: {
				device: 'plc-002',
				timestamp: new Date().toISOString(),
				messages: [
					{ timestamp: new Date().toISOString(), deviceName: 'plc-002', metric: 'vibration', value: 0, quality: 'bad' },
				],
			},
			topic: agentTopic('abc', 'endpoints', 'plc-002'),
			deviceId: 'plc-002',
		},
	]
	: [
		{ payload: { rawAdc: 2048, humidity: 65 }, topic: 'device/temperature', deviceId: 'device-01' },
		{ payload: '{"rawAdc":3000,"humidity":42}',  topic: 'device/temperature', deviceId: 'device-02' },
		{ payload: { rawAdc: 0, humidity: 88 },    topic: 'device/temperature', deviceId: 'device-03' },
	];

async function main() {
	logger.info('Starting Node-RED pipeline POC...');
	logger.info(`Flows file: ${FLOWS_FILE}`);

	const svc = new PipelineService({
		flows: FLOWS_FILE,
		agentUuid: process.env['DEVICE_UUID'] ?? 'dev-runner',
		timeoutMs: 8000,
		logger,
	});

	try {
		await svc.start();
		logger.info('Pipeline started. Running test transforms...\n');

		for (const msg of testMessages) {
			logger.info(`--- Input (${msg.deviceId}) ---`);
			console.log(JSON.stringify(msg.payload, null, 2));

			const result = await svc.transform(msg);

			if (result.drop) {
				logger.warn(`Message from ${msg.deviceId} was DROPPED by the pipeline`);
			} else {
				logger.info(`--- Output (${msg.deviceId}) ---`);
				console.log(JSON.stringify(result.payload, null, 2));
			}
			console.log('');
		}
	} catch (err) {
		logger.error('POC failed:', err);
		process.exitCode = 1;
	} finally {
		await svc.stop();
		logger.info('Pipeline stopped. POC complete.');
	}
}

main();
