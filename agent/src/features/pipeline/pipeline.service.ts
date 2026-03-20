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
 *     topic: 'sensor/temperature',
 *     deviceId: 'sensor-01',
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

    // node-red is CJS; require() is always available in this CJS-output project
    this.red = require('node-red');
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
