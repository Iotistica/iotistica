/**
 * @iotistic/types — shared type definitions for the Iotistic IoT platform.
 *
 * Source of truth: index.ts (kept in sync manually).
 */

// ── Pipeline message contract ─────────────────────────────────────────────────

export interface PipelineTransformInput {
  payload: unknown;
  topic: string;
  /** UUID (or name) of the endpoint device that produced this reading. */
  deviceId: string;
  [key: string]: unknown;
}

export interface PipelineTransformResult {
  payload: unknown;
  topic: string;
  /** When true the agent drops the message instead of publishing to MQTT. */
  drop?: boolean;
}

// ── Flow node shapes ──────────────────────────────────────────────────────────

export interface PipelineFlowNode {
  id: string;
  type: string;
  name?: string;
  wires: string[][];
  [key: string]: unknown;
}

export type PipelineFlow = PipelineFlowNode[];

// ── Iotistica node config shapes ──────────────────────────────────────────────

export interface PipelineInConfig extends PipelineFlowNode {
  type: 'iotistica-pipeline-in';
  /** UUID of the agent that owns this pipeline. Validated at deploy time. */
  agentUuid: string;
  agentName?: string;
}

export interface PipelineOutConfig extends PipelineFlowNode {
  type: 'iotistica-pipeline-out';
}

export interface DeviceFilterConfig extends PipelineFlowNode {
  type: 'iotistica-device-filter';
  mode: 'allow' | 'block';
  /** Comma-separated endpoint device UUIDs. Empty = match all. */
  devices: string;
  /** Newline-separated MQTT topic patterns (supports + and # wildcards). Empty = match all. */
  topics: string;
}

// ── Allowed node types ────────────────────────────────────────────────────────

export declare const PIPELINE_ALLOWED_NODE_TYPES: readonly [
  'iotistica-pipeline-in',
  'iotistica-pipeline-out',
  'iotistica-device-filter',
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
  'tab',
  'group',
  'global-config',
  'comment',
];

export type PipelineNodeType = (typeof PIPELINE_ALLOWED_NODE_TYPES)[number];
