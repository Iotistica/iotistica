/**
 * AI Chat API Routes
 * SECURITY: Rate limited to prevent API abuse on expensive AI operations
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { processAIChat } from '../services/ai-chat.service';
import { logger } from '../utils/logger';
import { jwtAuth } from '../middleware/jwt-auth';

const router = Router();

// Apply JWT auth only to /ai/* routes (path-specific to avoid intercepting other routes)
router.use('/ai', jwtAuth);

// SECURITY: Rate limit for AI chat (expensive operation)
const aiChatRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // Max 50 chat requests per hour per IP
  message: 'Too many AI chat requests',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('[SECURITY] AI chat rate limit exceeded', {
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });
    res.status(429).json({
      error: 'Too many requests',
      message: 'Too many AI chat requests. Please try again later.'
    });
  }
});

/**
 * POST /api/v1/ai/chat
 * Send a message to the AI assistant
 * SECURITY: Rate limited endpoint
 */
router.post('/ai/chat', aiChatRateLimit, async (req, res) => {
  try {
    const { deviceUuid, message, conversationHistory } = req.body;

    console.log('[AI Chat] Request received:', {
      deviceUuid,
      messageLength: message?.length,
      historyLength: conversationHistory?.length,
      provider: process.env.AI_PROVIDER || 'ollama',
      hasOpenAiKey: !!process.env.OPENAI_API_KEY,
    });

    if (!deviceUuid || !message) {
      console.error('[AI Chat] Missing required fields:', { deviceUuid: !!deviceUuid, message: !!message });
      return res.status(400).json({
        error: 'Missing required fields: deviceUuid, message',
      });
    }

    const response = await processAIChat({
      deviceUuid,
      message,
      conversationHistory: conversationHistory || [],
    });

    console.log('[AI Chat] Response generated successfully:', {
      responseLength: response?.length,
      deviceUuid,
    });

    res.json({ response });
  } catch (error: any) {
    console.error('[AI Chat] Error occurred:', {
      message: error.message,
      stack: error.stack,
      provider: process.env.AI_PROVIDER || 'ollama',
      hasOpenAiKey: !!process.env.OPENAI_API_KEY,
      openAiModel: process.env.OPENAI_MODEL,
    });
    res.status(500).json({
      error: 'Internal server error',
      requestId: req.id || 'unknown'
    });
  }
});

export default router;
