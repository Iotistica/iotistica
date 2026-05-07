/**
 * Pipeline feature types
 *
 * Flow contract (what Node-RED function nodes receive / must return):
 *   msg.payload  – the raw device payload (string or object)
 *   msg.topic    – the MQTT topic that will be used for publishing
 *   msg.deviceId – the endpoint device UUID that produced the payload
 */

/** Allowed Node-RED node types for pipeline flows (transformation-safe only). */
export const PIPELINE_ALLOWED_NODE_TYPES = [
	'function',
	'change',
	'switch',
	'template',
	'json',
	'debug',
	'comment',
	'tab',
	'iotistica-pipeline-in',
	'iotistica-pipeline-out',
] as const;

export type PipelineNodeType = (typeof PIPELINE_ALLOWED_NODE_TYPES)[number];

/** Config properties on an iotistica-pipeline-in node. */
export interface PipelineInConfig {
  agentUuid?: string;
}

/** Config properties on an iotistica-pipeline-out node. */
export type PipelineOutConfig = Record<string, unknown>;

/** Config properties on a device-filter node (if used). */
export interface DeviceFilterConfig {
  deviceIds?: string[];
}

/** A single node in a Node-RED flow array. */
export interface PipelineFlowNode {
  id: string;
  type: string;
  name?: string;
  /** Node-RED wiring: outer array = outputs, inner array = downstream node IDs. */
  wires?: string[][];
  /** For function nodes: the JS function body. */
  func?: string;
  /** For iotistica-pipeline-in nodes: owning agent UUID. */
  agentUuid?: string;
  [key: string]: unknown;
}

/** A Node-RED flow is an ordered array of nodes. */
export type PipelineFlow = PipelineFlowNode[];

/** Input message passed into the pipeline. */
export interface PipelineTransformInput {
  payload: unknown;
  topic: string;
  deviceId: string;
}

/** Result message produced by the pipeline. */
export interface PipelineTransformResult {
  payload: unknown;
  topic: string;
  /** Set to true by a function node to discard the message (skip publishing). */
  drop?: boolean;
  [key: string]: unknown;
}

export interface PipelineServiceOptions {
  /** Absolute path to the flows JSON file, or an already-parsed array. */
  flows: string | PipelineFlow;
  /** The UUID of the agent running this pipeline — used to validate flow ownership. */
  agentUuid: string;
  /** Working directory Node-RED will use for its userDir (defaults to os.tmpdir()). */
  userDir?: string;
  /** Timeout in ms to wait for a single message to travel through the flow (default 5000). */
  timeoutMs?: number;
  logger?: {
    debug(msg: string, ...args: unknown[]): void;
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
}

