import express, { Request, Response } from 'express';
import { deploymentQueue } from '../services/deployment-queue';

const router = express.Router();

/**
 * GET /api/admin/jobs
 * List all jobs in the deployment queue
 */
router.get('/jobs', async (req: Request, res: Response) => {
  try {
    const queue = deploymentQueue.getQueue();
    const [waiting, active, completed, failed] = await Promise.all([
      queue.getWaiting(),
      queue.getActive(),
      queue.getCompleted(),
      queue.getFailed(),
    ]);

    const allJobs = [...waiting, ...active, ...completed, ...failed];
    
    const jobsWithState = await Promise.all(
      allJobs.map(async (job) => ({
        id: job.id,
        type: job.name,
        data: job.data,
        progress: job.progress(),
        state: await job.getState(),
        attempts: job.attemptsMade,
        timestamp: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        failedReason: job.failedReason
      }))
    );

    res.json({ jobs: jobsWithState });
  } catch (error) {
    console.error('❌ Error fetching jobs:', error);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

/**
 * GET /api/admin/jobs/:jobId
 * Get status of a specific job
 */
router.get('/jobs/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const job = await deploymentQueue.getJob(jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const state = await job.getState();
    const progress = job.progress();
    
    res.json({
      id: job.id,
      type: job.name,
      data: job.data,
      state,
      progress,
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts || 3,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
      stacktrace: job.stacktrace,
      returnvalue: job.returnvalue
    });
  } catch (error) {
    console.error('❌ Error fetching job:', error);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

export default router;
