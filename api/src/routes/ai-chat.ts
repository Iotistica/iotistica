/**
 * AI Chat API Routes
 */

import { Router } from 'express';
import { processAIChat } from '../services/ai-chat.service';

const router = Router();

/**
 * POST /api/v1/ai/chat
 * Send a message to the AI assistant
 */
router.post('/ai/chat', async (req, res) => {
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
      error: 'AI chat failed',
      message: error.message,
      provider: process.env.AI_PROVIDER || 'ollama',
    });
  }
});

export default router;
