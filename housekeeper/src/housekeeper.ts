/**
 * Housekeeper - Task Scheduler & Executor
 * 
 * Unified task scheduling system combining:
 * - Cron-based scheduling (from original housekeeper)
 * - Job engine patterns (from agent)
 * 
 * Runs regular maintenance tasks to keep things clean and tidy
 */

import { CronJob } from 'cron';
import { pool } from './db/connection';
import logger from './utils/logger';
import winston from 'winston';
import Transport from 'winston-transport';

/**
 * Custom Winston transport that captures logs to an array
 */
class CaptureTransport extends Transport {
  private output: string[];

  constructor(output: string[], opts?: Transport.TransportStreamOptions) {
    super(opts);
    this.output = output;
  }

  log(info: any, callback: () => void) {
    setImmediate(() => {
      this.emit('logged', info);
    });

    // Format log message
    const level = info.level.toUpperCase();
    const message = info.message;
    const timestamp = info.timestamp || new Date().toISOString();
    
    // Build log line with metadata if present
    const metaKeys = Object.keys(info).filter(k => 
      !['level', 'message', 'timestamp', 'service', Symbol.for('level'), Symbol.for('message')].includes(k)
    );
    
    if (metaKeys.length > 0) {
      const meta = metaKeys.reduce((acc, key) => ({ ...acc, [key]: info[key] }), {});
      this.output.push(`[${timestamp}] ${level}: ${message} ${JSON.stringify(meta)}`);
    } else {
      this.output.push(`[${timestamp}] ${level}: ${message}`);
    }

    callback();
  }
}

export interface HousekeeperTask {
  name: string;
  schedule?: string; // Cron expression (e.g., "0 2 * * *" = 2am daily)
  startup?: boolean | number; // true = run on startup, number = delay in ms
  run: () => Promise<void>;
}

interface RegisteredTask extends HousekeeperTask {
  job?: CronJob;
}

export interface HousekeeperConfig {
  enabled?: boolean;
  timezone?: string;
}

/**
 * Create housekeeper instance
 */
export function createHousekeeper(config: HousekeeperConfig = {}) {
  const tasks = new Map<string, RegisteredTask>();
  const delayedStartupTasks: NodeJS.Timeout[] = [];
  const runningTasks = new Set<string>();

  const {
    enabled = true,
    timezone = 'Etc/UTC'
  } = config;



  /**
   * Run a single task
   */
  async function runTask(task: RegisteredTask, triggeredBy: string = 'scheduler'): Promise<void> {
    // Prevent concurrent runs of same task
    if (runningTasks.has(task.name)) {
      logger.warn('Task already running, skipping', { taskName: task.name });
      return;
    }

    runningTasks.add(task.name);
    
    const startTime = Date.now();
    let runId: number | null = null;
    let capturedOutput: string[] = [];
    let capturedError: string | null = null;

    try {
      // Create execution record
      const result = await pool.query(
        `INSERT INTO housekeeper_runs (task_name, started_at, status, triggered_by) 
         VALUES ($1, NOW(), 'running', $2) 
         RETURNING id`,
        [task.name, triggeredBy]
      );
      runId = result.rows[0].id;

      // Create child logger with capture transport
      const captureTransport = new CaptureTransport(capturedOutput);
      const taskLogger = logger.child({ taskName: task.name });
      (taskLogger as any).add(captureTransport);
      
      // Log task start
      taskLogger.info(`Running housekeeper task: '${task.name}'`);

      await task.run();
      
      const duration = Date.now() - startTime;
      
      // Log completion
      taskLogger.info(`Completed task '${task.name}' in ${duration}ms`);
      
      // Remove capture transport
      (taskLogger as any).remove(captureTransport);
      
      // Update execution record with success
      if (runId) {
        await pool.query(
          `UPDATE housekeeper_runs 
           SET completed_at = NOW(), status = 'success', duration_ms = $1, output = $2
           WHERE id = $3`,
          [duration, capturedOutput.join('\n'), runId]
        );
      }
    } catch (error: any) {
      const duration = Date.now() - startTime;
      capturedError = `${error.message}\n${error.stack}`;
      
      // Log error
      logger.error('Task execution failed', {
        taskName: task.name,
        duration,
        error: error.message,
        stack: error.stack
      });
      
      // Update execution record with error
      if (runId) {
        await pool.query(
          `UPDATE housekeeper_runs 
           SET completed_at = NOW(), status = 'error', duration_ms = $1, output = $2, error = $3
           WHERE id = $4`,
          [duration, capturedOutput.join('\n'), capturedError, runId]
        );
      }
    } finally {
      runningTasks.delete(task.name);
    }
  }

  /**
   * Register a new task
   */
  async function registerTask(task: HousekeeperTask): Promise<void> {
    if (!enabled) {
      logger.info('Housekeeper disabled, skipping task registration', { taskName: task.name });
      return;
    }

    if (tasks.has(task.name)) {
      logger.warn('Task already registered, skipping', { taskName: task.name });
      return;
    }

    const registeredTask: RegisteredTask = { ...task };
    tasks.set(task.name, registeredTask);

    // Schedule cron job if schedule provided
    if (task.schedule) {
      try {
        registeredTask.job = new CronJob(
          task.schedule,
          () => runTask(registeredTask),
          null, // onComplete
          true, // start
          timezone
        );
        logger.info('Scheduled task with cron', { 
          taskName: task.name, 
          schedule: task.schedule 
        });
      } catch (error: any) {
        logger.error('Failed to schedule task', {
          taskName: task.name,
          error: error.message
        });
      }
    }
  }

  /**
   * Unregister a task
   */
  function unregisterTask(name: string): void {
    const task = tasks.get(name);
    if (!task) return;

    if (task.job) {
      task.job.stop();
      delete task.job;
    }

    tasks.delete(name);
    logger.info('Unregistered task', { taskName: name });
  }

  /**
   * Run a task manually (on-demand)
   */
  async function runTaskManually(name: string): Promise<void> {
    const task = tasks.get(name);
    if (!task) {
      throw new Error(`Task '${name}' not found`);
    }

    await runTask(task, 'manual');
  }

  /**
   * Get all registered tasks
   */
  function getAllTasks() {
    return Array.from(tasks.values()).map(task => ({
      name: task.name,
      schedule: task.schedule,
      startup: task.startup,
      isRunning: runningTasks.has(task.name)
    }));
  }

  /**
   * Get task by name
   */
  function getTask(name: string) {
    const task = tasks.get(name);
    if (!task) return null;
    
    return {
      name: task.name,
      schedule: task.schedule,
      startup: task.startup,
      isRunning: runningTasks.has(task.name)
    };
  }

  /**
   * Enable/disable a task
   */
  async function toggleTask(name: string, enabled: boolean): Promise<void> {
    const task = tasks.get(name);
    if (!task) {
      throw new Error(`Task '${name}' not found`);
    }

    // Update database config
    await pool.query(
      `INSERT INTO housekeeper_config (task_name, enabled, schedule)
       VALUES ($1, $2, $3)
       ON CONFLICT (task_name) 
       DO UPDATE SET enabled = $2, last_modified_at = NOW()`,
      [name, enabled, task.schedule]
    );

    // Stop or start the cron job
    if (task.job) {
      if (enabled) {
        task.job.start();
      } else {
        task.job.stop();
      }
    }
  }

  /**
   * Get task status
   */
  function getTaskStatus(name: string): {
    registered: boolean;
    running: boolean;
    scheduled: boolean;
  } {
    const task = tasks.get(name);
    return {
      registered: !!task,
      running: runningTasks.has(name),
      scheduled: !!task?.job
    };
  }

  /**
   * List all registered tasks
   */
  function listTasks(): Array<{
    name: string;
    schedule?: string;
    running: boolean;
    scheduled: boolean;
  }> {
    return Array.from(tasks.values()).map(task => ({
      name: task.name,
      schedule: task.schedule,
      running: runningTasks.has(task.name),
      scheduled: !!task.job
    }));
  }

  /**
   * Initialize housekeeper - load and run startup tasks
   */
  async function initialize(): Promise<void> {
    if (!enabled) {
      logger.info('Housekeeper is disabled');
      return;
    }

    logger.info('Initializing housekeeper...');

    // Register built-in tasks
    const tasksToRegister = [
      await import('./tasks/api-key-rotation'),
      await import('./tasks/cleanup-old-logs'),
      await import('./tasks/database-vacuum'),
      await import('./tasks/device-logs-retention'),
      // Disabled: Tables not partitioned in current database schema
      // await import('./tasks/device-logs-partition-maintenance'),
      // await import('./tasks/device-metrics-partition-maintenance'),
      // await import('./tasks/events-partition-maintenance'),
      await import('./tasks/security-scan-images'),
      // Add more tasks here
    ];

    for (const taskModule of tasksToRegister) {
      try {
        await registerTask(taskModule.default);
      } catch (error: any) {
        logger.error('Failed to register task', { error: error.message });
      }
    }

    // Run startup tasks
    for (const task of tasks.values()) {
      if (task.startup === true) {
        // Run immediately on startup
        runTask(task, 'startup').catch(err => {
          logger.error('Startup task failed', {
            taskName: task.name,
            error: err.message
          });
        });
      } else if (typeof task.startup === 'number') {
        // Run after delay
        const timeout = setTimeout(
          () => runTask(task, 'startup').catch(err => {
            logger.error('Delayed startup task failed', {
              taskName: task.name,
              error: err.message
            });
          }),
          task.startup
        );
        delayedStartupTasks.push(timeout);
      }
    }

    logger.info('Housekeeper initialized', { taskCount: tasks.size });
  }

  /**
   * Shutdown housekeeper - stop all scheduled tasks
   */
  async function shutdown(): Promise<void> {
    logger.info('Shutting down housekeeper...');

    // Stop all scheduled jobs
    for (const task of tasks.values()) {
      if (task.job) {
        task.job.stop();
        delete task.job;
      }
    }

    // Clear delayed startup tasks
    for (const timeout of delayedStartupTasks) {
      clearTimeout(timeout);
    }
    delayedStartupTasks.length = 0;

    // Wait for running tasks to complete (with timeout)
    const timeout = 30000; // 30 seconds
    const startTime = Date.now();
    
    while (runningTasks.size > 0 && Date.now() - startTime < timeout) {
      logger.info('Waiting for tasks to complete', { 
        remainingTasks: runningTasks.size 
      });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (runningTasks.size > 0) {
      logger.warn('Shutdown timeout: tasks still running', {
        remainingTasks: runningTasks.size,
        tasks: Array.from(runningTasks)
      });
    }

    tasks.clear();
    logger.info('Housekeeper shutdown complete');
  }

  return {
    initialize,
    shutdown,
    registerTask,
    unregisterTask,
    runTaskManually,
    getTaskStatus,
    listTasks,
    getAllTasks,
    getTask,
    toggleTask
  };
}

export type Housekeeper = ReturnType<typeof createHousekeeper>;
