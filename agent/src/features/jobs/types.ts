import { z } from 'zod';

/**
 * Job Status enumeration matching AWS IoT Jobs API
 */
export enum JobStatus {
  QUEUED = 'QUEUED',
  IN_PROGRESS = 'IN_PROGRESS',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  TIMED_OUT = 'TIMED_OUT',
  REJECTED = 'REJECTED',
  CANCELED = 'CANCELED'
}

/**
 * Job Execution Types
 */
export enum JobExecutionType {
  ONE_TIME = 'oneTime',
  RECURRING = 'recurring',
  CONTINUOUS = 'continuous'
}

/**
 * Job Action Types - matches C++ ActionType constants
 */
export enum ActionType {
  RUN_HANDLER = 'runHandler',
  RUN_COMMAND = 'runCommand'
}

/**
 * Job Condition schema for conditional job execution
 */
export const JobConditionSchema = z.object({
  key: z.string(),
  value: z.array(z.string()),
  type: z.string().optional().default('stringEqual')
});

export type JobCondition = z.infer<typeof JobConditionSchema>;

/**
 * Handler Input schema - for runHandler type actions
 */
export const ActionHandlerInputSchema = z.object({
  handler: z.string(),
  args: z.array(z.string()).optional(),
  path: z.string().optional()
});

export type ActionHandlerInput = z.infer<typeof ActionHandlerInputSchema>;

/**
 * Command Input schema - for runCommand type actions
 */
export const ActionCommandInputSchema = z.object({
  command: z.string()
});

export type ActionCommandInput = z.infer<typeof ActionCommandInputSchema>;

/**
 * Job Action schema - represents a single step in job execution
 */
export const JobActionSchema = z.object({
  name: z.string(),
  type: z.nativeEnum(ActionType),
  input: z.union([
    ActionHandlerInputSchema,
    ActionCommandInputSchema
  ]),
  runAsUser: z.string().optional(),
  allowStdErr: z.number().optional(),
  ignoreStepFailure: z.boolean().optional().default(false)
});

export type JobAction = z.infer<typeof JobActionSchema>;

/**
 * Job Schedule Configuration for recurring jobs
 */
export const JobScheduleSchema = z.object({
  type: z.enum(['interval', 'cron']),
  intervalMinutes: z.number().optional(),
  cronExpression: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional()
});

export type JobSchedule = z.infer<typeof JobScheduleSchema>;

/**
 * Job Document schema - supports both new (v1.0) and legacy formats
 */
export const JobDocumentSchema = z.object({
  version: z.string().default('1.0'),
  includeStdOut: z.boolean().optional().default(false),
  conditions: z.array(JobConditionSchema).optional(),
  steps: z.array(JobActionSchema),
  finalStep: JobActionSchema.optional(),
  
  // Enhanced execution options
  executionType: z.nativeEnum(JobExecutionType).optional().default(JobExecutionType.ONE_TIME),
  schedule: JobScheduleSchema.optional(),
  maxExecutions: z.number().optional(),
  maxDurationMinutes: z.number().optional(),
  reportProgress: z.boolean().optional().default(false),
  progressIntervalSeconds: z.number().optional().default(60),
  
  // Legacy schema support (version 0.0)
  operation: z.string().optional(),
  args: z.array(z.string()).optional(),
  allowStdErr: z.number().optional(),
  path: z.string().optional()
});

export type JobDocument = z.infer<typeof JobDocumentSchema>;

/**
 * Job Execution Data - matches AWS IoT Jobs ExecutionData structure
 */
export interface JobExecutionData {
  jobId: string;
  deviceUuid: string;
  jobDocument: JobDocument;
  status: JobStatus;
  queuedAt?: Date | undefined;
  startedAt?: Date | undefined;
  lastUpdatedAt?: Date | undefined;
  versionNumber: number;
  executionNumber: number;
  statusDetails?: Record<string, string> | undefined;
}

/**
 * Job Execution Status Info - aggregates execution results
 */
export interface JobExecutionStatusInfo {
  status: JobStatus;
  reason?: string;
  stdOutput?: string;
  stdError?: string;
}

/**
 * Job Action Result - result of executing a single action
 */
export interface ActionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
  reason?: string;
}

/**
 * Job Execution Result - overall job execution result
 */
export interface JobResult {
  success: boolean;
  exitCode: number;
  reason: string;
  stdout: string;
  stderr: string;
  executedSteps: number;
  failedStep?: string | undefined;
}

/**
 * MQTT Topic patterns for AWS IoT Jobs
 */
export interface JobsTopics {
  startNext: string;
  startNextAccepted: string;
  startNextRejected: string;
  updateAccepted: string;
  updateRejected: string;
  notifyNext: string;
}

/**
 * Jobs Configuration
 */
export interface JobsConfig {
  enabled: boolean;
  deviceUuid: string;
  handlerDirectory: string;
  maxConcurrentJobs?: number;
  defaultHandlerTimeout?: number;
}

/**
 * MQTT Connection interface abstraction
 */
export interface MqttConnection {
  publish(topic: string, payload: string): Promise<void>;
  subscribe(topic: string, callback: (topic: string, payload: Buffer) => void): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
  isConnected(): boolean;
}

/**
 * Logger interface abstraction  
 */
export interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

/**
 * Client Base Notifier interface - matches C++ ClientBaseNotifier
 */
export interface ClientBaseNotifier {
  onEvent(featureName: string, event: string): void;
  onError(featureName: string, error: string, message: string): void;
}

/**
 * Feature interface - matches C++ Feature interface
 */
export interface Feature {
  getName(): string;
  start(): Promise<void>;
  stop(): Promise<void>;
}
