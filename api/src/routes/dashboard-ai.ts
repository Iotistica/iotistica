import express from 'express';
import { jwtAuth } from '../middleware/jwt-auth';
import logger from '../utils/logger';
import { generateDashboardSuggestions, getStrategy } from '../services/ai/dashboard-suggestions.service';

const router = express.Router();

router.get('/ai-cards', jwtAuth, async (req, res) => {
  const requestId = (req as any).id || 'unknown';
  const strategy = getStrategy(req.query?.strategy);

  try {
    const result = await generateDashboardSuggestions({
      strategy,
      requestId,
      userId: (req as any).user?.id,
    });

    res.json(result);
  } catch (error: any) {
    logger.error('Failed to generate AI dashboard cards', {
      requestId,
      userId: (req as any).user?.id,
      error: error?.message || 'Unknown error',
    });

    res.status(500).json({ error: 'Failed to generate AI dashboard cards', requestId });
  }
});

export default router;