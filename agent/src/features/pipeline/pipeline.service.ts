/**
 * Node-RED Pipeline Service
 *
 * POC: embeds a minimal Node-RED runtime inside the agent process and uses it
 * to run user-supplied flows as a payload-transformation pipeline.
 *
 * Usage
 * -----
 *   const svc = new PipelineService({ flows: '/path/to/flows.json' });
 *   await svc.start();
 *
 *   const result = await svc.transform({
 *     payload: { temperature: 22.5 },
 *     topic: 'device/temperature',
 *     deviceId: 'device-01',
 *   });
 *
 *   console.log(result.payload); // transformed payload
 *   await svc.stop();
 *
 * Flow contract inside function nodes:
 *   msg.payload    raw device payload (string or object)
 *   msg.topic      MQTT topic
 *   msg.deviceId   originating device id
 *   msg.drop       set true to discard the message (no publish)
 *
 * The service auto-wraps your flows with iotistica-pipeline-in / out nodes
 * (plain CJS files in nr-nodes/) so you only need to supply the middle
 * transformation nodes.
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import type {
	PipelineFlow,
	PipelineServiceOptions,
	PipelineTransformInput,
	PipelineTransformResult,
} from './types.js';
import { PIPELINE_ALLOWED_NODE_TYPES } from './types.js';

//  Internal event bus and pending-promise map 
// Exposed on globalThis so the CJS nr-nodes loaded by Node-RED can reach them.

const pipelineEvents = new EventEmitter();
pipelineEvents.setMaxListeners(200);

const pendingTransforms = new Map<
  string,
  {
    resolve: (result: PipelineTransformResult) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

(globalThis as Record<string, unknown>)['__iotisticaPipelineEvents'] = pipelineEvents;
(globalThis as Record<string, unknown>)['__iotisticaPendingTransforms'] = pendingTransforms;

//  Service 

export class PipelineService {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private red: any = null;
	private started = false;

	private readonly timeoutMs: number;
	private readonly userDir: string;

	constructor(private readonly options: PipelineServiceOptions) {
		this.timeoutMs = options.timeoutMs ?? 5000;
		this.userDir   = options.userDir ?? path.join(os.tmpdir(), 'iotistica-pipeline');
	}

	//  Lifecycle 

	async start(): Promise<void> {
		if (this.started) return;

		fs.mkdirSync(this.userDir, { recursive: true });

		const flows    = this._resolveFlows();
		this._sanitizeFlows(flows);
		const augmented = this._augmentFlows(flows);
		const flowsFile = path.join(this.userDir, 'flows.json');
		fs.writeFileSync(flowsFile, JSON.stringify(augmented, null, 2), 'utf8');

		// Node-RED automatically scans <userDir>/nodes/ for raw .js node files.
		// Copy our custom in/out nodes there so they are loaded at startup.
		const userNodesDir = path.join(this.userDir, 'nodes');
		fs.mkdirSync(userNodesDir, { recursive: true });
		const nrNodesSource = path.join(__dirname, 'nr-nodes');
		for (const file of fs.readdirSync(nrNodesSource).filter((f) => f.endsWith('.js') || f.endsWith('.html'))) {
			fs.copyFileSync(path.join(nrNodesSource, file), path.join(userNodesDir, file));
		}

		const settings = {
			httpAdminRoot: false,
			httpNodeRoot:  false,
			userDir:       this.userDir,
			flowFile:      flowsFile,
			logging: {
				console: { level: 'warn', metrics: false, audit: false },
			},
			editorTheme: { tours: false },
			// Restrict function nodes: no require(), no access to agent globals.
			// Note: process.env is still reachable via vm-escape unless child-process
			// isolation is used. These settings only block the obvious attack surface.
			functionExternalModules: false,
			functionGlobalContext: {},
		};

		// node-red is intentionally optional. Keep the runtime out of the default
		// agent install and require an explicit plugin-style install when needed.
		try {
			const nodeRedModule = await import('node-red');
			this.red = (nodeRedModule).default || nodeRedModule;
		} catch (error: any) {
			if (error?.code === 'MODULE_NOT_FOUND' || String(error?.message || '').includes("Cannot find module 'node-red'")) {
				throw new Error('Embedded Node-RED runtime is not installed. Install node-red separately and set ENABLE_EMBEDDED_NODE_RED=true to enable the optional pipeline runtime.');
			}

			throw error;
		}
		this.red.init(null, settings);

		// Wait for flows to be fully deployed before resolving
		const flowsReady = new Promise<void>((resolve) => {
			this.red.events.once('flows:started', () => resolve());
		});

		await this.red.start();
		await flowsReady;

		this.started = true;
		this.options.logger?.info('PipelineService started');
		this.options.logger?.info('  flows : ' + flowsFile);
		this.options.logger?.info('  nodes : ' + userNodesDir);
	}

	async stop(): Promise<void> {
		if (!this.started || !this.red) return;
		await this.red.stop();
		this.started = false;
		this.options.logger?.info('PipelineService stopped');
	}

	//  Transform 

	/**
   * Run `input` through the Node-RED pipeline.
   * Resolves when the flow produces output; rejects after timeoutMs.
   */
	async transform(input: PipelineTransformInput): Promise<PipelineTransformResult> {
		if (!this.started) throw new Error('PipelineService not started  call start() first');

		const correlationId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

		return new Promise<PipelineTransformResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				pendingTransforms.delete(correlationId);
				reject(new Error(`Pipeline transform timed out after ${this.timeoutMs}ms`));
			}, this.timeoutMs);

			pendingTransforms.set(correlationId, { resolve, reject, timer });
			pipelineEvents.emit('pipeline:in', { correlationId, ...input });
		});
	}

	//  Private helpers 

	/**
   * Validate the flow structure and reject any node types that could be used
   * to escape the sandbox, exfiltrate data, or cause side-effects outside the
   * transform pipeline.
   *
   * Allowlisted node types cover the standard NR function/logic nodes that
   * are useful for payload transformation.  Add to ALLOWED_TYPES if you need
   * a specific contrib node that is safe.
   */
	private _sanitizeFlows(flows: PipelineFlow): void {
		if (!Array.isArray(flows)) {
			throw new Error('Pipeline flows must be a JSON array');
		}
		if (flows.length === 0) {
			throw new Error('Pipeline flows array is empty');
		}
		if (flows.length > 100) {
			throw new Error(`Pipeline flows too large: ${flows.length} nodes (max 100)`);
		}

		// Node types that are safe for payload transformation.
		// The canonical list lives in @iotistic/types — add new Iotistica nodes there.
		const ALLOWED_TYPES = new Set<string>(PIPELINE_ALLOWED_NODE_TYPES);

		const seenIds = new Set<string>();

		for (const node of flows) {
			// Structural checks
			if (typeof node !== 'object' || node === null) {
				throw new Error('Pipeline flow contains a non-object node');
			}
			if (typeof node.id !== 'string' || !node.id.trim()) {
				throw new Error('Pipeline flow node is missing a valid id');
			}
			if (typeof node.type !== 'string' || !node.type.trim()) {
				throw new Error(`Pipeline flow node '${node.id}' is missing a valid type`);
			}

			// Duplicate id check
			if (seenIds.has(node.id)) {
				throw new Error(`Pipeline flow contains duplicate node id: '${node.id}'`);
			}
			seenIds.add(node.id);

			// Allowlist check
			if (!ALLOWED_TYPES.has(node.type)) {
				throw new Error(
					`Pipeline flow contains disallowed node type: '${node.type}'. ` +
          `Only transform-safe node types are permitted.`
				);
			}

			// Agent UUID ownership check — every pipeline-in node must declare
			// the UUID of this agent.  A mismatch means the flow was built for a
			// different agent and must not run here.
			if (node.type === 'iotistica-pipeline-in') {
				const declaredUuid = typeof node.agentUuid === 'string' ? node.agentUuid.trim() : '';
				if (!declaredUuid) {
					throw new Error(
						`Pipeline flow node '${node.id}' (pipeline-in) has no agentUuid. ` +
            `Open the node in the editor, select an agent, and redeploy.`
					);
				}
				if (declaredUuid !== this.options.agentUuid) {
					throw new Error(
						`Pipeline flow node '${node.id}' is assigned to agent '${declaredUuid}' ` +
            `but this agent is '${this.options.agentUuid}'. Flow ownership mismatch.`
					);
				}
			}

			// Wires must be an array (if present)
			if (node.wires !== undefined && !Array.isArray(node.wires)) {
				throw new Error(`Pipeline flow node '${node.id}' has invalid wires (must be array)`);
			}

			// Guard against excessively large function bodies (> 64 KB)
			if (node.type === 'function' && typeof node.func === 'string' && node.func.length > 65536) {
				throw new Error(`Pipeline function node '${node.id}' func body exceeds 64 KB limit`);
			}
		}
	}

	private _resolveFlows(): PipelineFlow {
		const { flows } = this.options;
		if (typeof flows === 'string') {
			return JSON.parse(fs.readFileSync(flows, 'utf8')) as PipelineFlow;
		}
		return flows;
	}

	/**
   * Wrap the user nodes with iotistica-pipeline-in  ...  iotistica-pipeline-out
   * if those boundary nodes are not already present.
   */
	private _augmentFlows(flows: PipelineFlow): PipelineFlow {
		const hasIn  = flows.some((n) => n.type === 'iotistica-pipeline-in');
		const hasOut = flows.some((n) => n.type === 'iotistica-pipeline-out');
		if (hasIn && hasOut) return flows;

		// Clone to avoid mutating the original
		const nodes: PipelineFlow = flows.map((n) => ({ ...n, wires: [...(n.wires ?? [])] }));

		const IN_ID  = '__poc-in__';
		const OUT_ID = '__poc-out__';

		const firstNode = nodes[0];
		const lastNode  = nodes[nodes.length - 1];

		const inNode: PipelineFlow[number] = {
			id: IN_ID,
			type: 'iotistica-pipeline-in',
			name: 'Pipeline In',
			wires: firstNode ? [[firstNode.id]] : [[OUT_ID]],
		};

		const outNode: PipelineFlow[number] = {
			id: OUT_ID,
			type: 'iotistica-pipeline-out',
			name: 'Pipeline Out',
			wires: [],
		};

		if (lastNode) lastNode.wires = [[OUT_ID]];

		return [inNode, ...nodes, outNode];
	}
}
