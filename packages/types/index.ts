/**
 * @iotistic/types — shared type definitions for the Iotistic IoT platform.
 *
 * Consumed by:
 *   agent/         TypeScript — imports interfaces + PIPELINE_ALLOWED_NODE_TYPES
 *   nr-pipeline/   Plain JS nodes — JSDoc @type annotations reference these for IDE support
 */

// ── Pipeline message contract ─────────────────────────────────────────────────

/** The message that enters and flows through a Node-RED transform pipeline. */
export interface PipelineTransformInput {
  payload: unknown;
  topic: string;
  /** UUID (or name) of the endpoint device that produced this reading. */
  deviceId: string;
  [key: string]: unknown;
}

/** The message that exits the Node-RED transform pipeline. */
export interface PipelineTransformResult {
  payload: unknown;
  topic: string;
  /** When true the agent drops the message instead of publishing to MQTT. */
  drop?: boolean;
}

// ── Flow node shapes ──────────────────────────────────────────────────────────

/** A single node entry in the pipeline flow JSON array. */
export interface PipelineFlowNode {
  id: string;
  type: string;
  name?: string;
  wires: string[][];
  [key: string]: unknown;
}

export type PipelineFlow = PipelineFlowNode[];

// ── Iotistica node config shapes ──────────────────────────────────────────────

/** Config stored in the flow JSON for an `iotistica-pipeline-in` node. */
export interface PipelineInConfig extends PipelineFlowNode {
  type: 'iotistica-pipeline-in';
  /** UUID of the agent that owns this pipeline. Validated at deploy time. */
  agentUuid: string;
  agentName?: string;
}

/** Config stored in the flow JSON for an `iotistica-pipeline-out` node. */
export interface PipelineOutConfig extends PipelineFlowNode {
  type: 'iotistica-pipeline-out';
}

/** Config stored in the flow JSON for an `iotistica-device-filter` node. */
export interface DeviceFilterConfig extends PipelineFlowNode {
  type: 'iotistica-device-filter';
  /** 'allow' sends matching messages to output 1; 'block' sends them to output 2. */
  mode: 'allow' | 'block';
  /** Comma-separated list of endpoint device UUIDs to match. Empty = match all. */
  devices: string;
  /** Newline-separated list of MQTT topic patterns (supports + and # wildcards). Empty = match all. */
  topics: string;
}

// ── Allowed node types ────────────────────────────────────────────────────────

/**
 * Exhaustive list of Node-RED node types allowed inside an Iotistica pipeline.
 *
 * The agent's pipeline sanitizer validates every node against this list.
 * Deliberately excludes: exec, file, http-request, tcp, udp, mqtt-out,
 * websocket, link, subflow — anything that could escape the sandbox.
 *
 * To add a new Iotistica node: add it here and re-install the package.
 */
export const PIPELINE_ALLOWED_NODE_TYPES = [
  // Iotistica boundary nodes
  'iotistica-pipeline-in',
  'iotistica-pipeline-out',
  'iotistica-device-filter',
  // NR core — logic / transform
  'function',
  'switch',
  'change',
  'template',
  'split',
  'join',
  'sort',
  'batch',
  'delay',
  'filter',
  'range',
  'json',
  'csv',
  'xml',
  'yaml',
  'html',
  'rbe',
  'debug',
  // NR editor metadata (safe, ignored at runtime)
  'tab',
  'group',
  'global-config',
  'comment',
] as const;

export type PipelineNodeType = (typeof PIPELINE_ALLOWED_NODE_TYPES)[number];
