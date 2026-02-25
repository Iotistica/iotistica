import { Router } from 'express';
import { deploymentQueue } from '../services/deployment-queue';

const router = Router();

/**
 * GET /api/queue/stats
 * Get queue statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await deploymentQueue.getStats();
    res.json(stats);
  } catch (error: any) {
    console.error('Error getting queue stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/queue/jobs/:jobId
 * Get job status
 */
router.get('/jobs/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await deploymentQueue.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const state = await job.getState();
    const progress = job.progress();
    const failedReason = job.failedReason;

    res.json({
      id: job.id,
      name: job.name,
      data: job.data,
      state,
      progress,
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts,
      failedReason,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
    });
  } catch (error: any) {
    console.error('Error getting job:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/queue/customer/:customerId/jobs
 * Get all jobs for a customer
 */
router.get('/customer/:customerId/jobs', async (req, res) => {
  try {
    const { customerId } = req.params;
    const jobs = await deploymentQueue.getCustomerJobs(customerId);

    const jobsWithState = await Promise.all(
      jobs.map(async (job) => ({
        id: job.id,
        name: job.name,
        state: await job.getState(),
        progress: job.progress(),
        timestamp: job.timestamp,
        finishedOn: job.finishedOn,
      }))
    );

    res.json({ jobs: jobsWithState });
  } catch (error: any) {
    console.error('Error getting customer jobs:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/queue/jobs/:jobId/retry
 * Retry a failed job
 */
router.post('/jobs/:jobId/retry', async (req, res) => {
  try {
    const { jobId } = req.params;
    await deploymentQueue.retryJob(jobId);
    res.json({ success: true, message: 'Job queued for retry' });
  } catch (error: any) {
    console.error('Error retrying job:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/queue/clean
 * Clean old completed and failed jobs
 */
router.post('/clean', async (req, res) => {
  try {
    await deploymentQueue.cleanOldJobs();
    res.json({ success: true, message: 'Old jobs cleaned' });
  } catch (error: any) {
    console.error('Error cleaning jobs:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
