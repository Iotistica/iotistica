/**
 * Pipeline feature types
 *
 * A "pipeline" is a Node-RED flow that runs inside the agent process.
 * Payloads pass through the flow before being published to the MQTT broker.
 * 
 * Flow contract (what your function nodes receive / must return):
 *   msg.payload  – the raw device payload (string or object)
 *   msg.topic    – the MQTT topic that will be used for publishing
 *   msg.deviceId – the device name/id that produced the payload
 *
 * The last node in the flow MUST be an "inject"-style or normal output node.
 * Whatever msg.payload is when the flow completes, that value is used as the
 * transformed payload sent to the broker.
 */

export interface PipelineFlowNode {
  id: string;
  type: string;
  name?: string;
  wires: string[][];
  [key: string]: unknown;
}

export type PipelineFlow = PipelineFlowNode[];

export interface PipelineTransformInput {
  payload: unknown;
  topic: string;
  deviceId: string;
  [key: string]: unknown;
}

export interface PipelineTransformResult {
  payload: unknown;
  topic: string;
  /** true when the pipeline decided to drop this message */
  drop?: boolean;
}

export interface PipelineServiceOptions {
  /** Absolute path to the flows JSON file, or an already-parsed array */
  flows: string | PipelineFlow;
  /** Working directory Node-RED will use for its userDir (defaults to os.tmpdir()) */
  userDir?: string;
  /** Timeout in ms to wait for a single message to travel through the flow (default 5000) */
  timeoutMs?: number;
  logger?: {
    debug(msg: string, ...args: unknown[]): void;
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
}
