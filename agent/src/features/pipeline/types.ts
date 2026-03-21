/**
 * Pipeline feature types
 *
 * Shared message-contract types (PipelineFlowNode, PipelineFlow,
 * PipelineTransformInput, PipelineTransformResult, node config shapes,
 * and PIPELINE_ALLOWED_NODE_TYPES) are defined in @iotistic/types and
 * re-exported here for backwards compatibility.
 *
 * Only agent-specific types (PipelineServiceOptions) are defined here.
 *
 * Flow contract (what Node-RED function nodes receive / must return):
 *   msg.payload  – the raw device payload (string or object)
 *   msg.topic    – the MQTT topic that will be used for publishing
 *   msg.deviceId – the endpoint device UUID that produced the payload
 */

export type {
  PipelineFlowNode,
  PipelineFlow,
  PipelineTransformInput,
  PipelineTransformResult,
  PipelineInConfig,
  PipelineOutConfig,
  DeviceFilterConfig,
  PipelineNodeType,
} from '@iotistic/types';

export { PIPELINE_ALLOWED_NODE_TYPES } from '@iotistic/types';

export interface PipelineServiceOptions {
  /** Absolute path to the flows JSON file, or an already-parsed array */
  flows: string | import('@iotistic/types').PipelineFlow;
  /** The UUID of the agent running this pipeline — used to validate flow ownership */
  agentUuid: string;
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

