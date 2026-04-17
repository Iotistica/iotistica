/**
 * AI Chat API Routes
 * SECURITY: Rate limited to prevent API abuse on expensive AI operations
 */


import { processAIChat } from '../services/ai/chat';
import { logger } from '../utils/logger';
import { jwtAuth } from '../middleware/jwt-auth';
import {
  buildDashboardAssistantSummary,
  generateDashboardSuggestions,
  getStrategy,
} from '../services/ai/dashboard-suggestions';
import {
  generateDeviceSuggestions,
  buildDeviceAssistantResponse,
} from '../services/ai/device-suggestions';
import type { FastifyPluginAsync } from 'fastify'

type AssistantMode = 'dashboard' | 'device';

type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type DeviceView =
  | 'metrics'
  | 'logs'
  | 'endpoints'
  | 'devices'
  | 'config'
  | 'settings'
  | 'jobs'
  | 'applications';

type AIChatBody = {
  deviceUuid?: string;
  message?: string;
  conversationHistory?: ConversationMessage[];
  mode?: AssistantMode;
  strategy?: string;
  deviceView?: string;
  deviceName?: string;
};

const plugin: FastifyPluginAsync = async (fastify) => {

// Apply JWT auth only to /ai/* routes (path-specific to avoid intercepting other routes)
fastify.addHook('preHandler', jwtAuth);


/**
 * POST /api/v1/ai/chat
 * Send a message to the AI assistant
 * SECURITY: Rate limited endpoint
 */
fastify.post<{ Body: AIChatBody }>('/ai/chat', async (req, reply) => {
  try {
    const { deviceUuid, message, conversationHistory, mode, strategy, deviceView, deviceName } = req.body;
    const normalizedMessage = typeof message === 'string' ? message.toLowerCase() : '';
    const hasDashboardIntent = /\bdashboard\b|\bcharts?\b|\bwidgets?\b|\blayout\b/.test(normalizedMessage);
    const hasRequestedStrategy = typeof strategy === 'string' && strategy.trim().length > 0;
    const assistantMode =
      mode === 'dashboard' || (!mode && (hasDashboardIntent || hasRequestedStrategy))
        ? 'dashboard'
        : 'device';

    logger.info('[AI Chat] Request received', {
      mode: assistantMode,
      deviceUuid,
      deviceView,
      messageLength: message?.length,
      historyLength: conversationHistory?.length,
      provider: process.env.AI_PROVIDER || 'ollama',
      hasOpenAiKey: !!process.env.OPENAI_API_KEY,
    });

    if (!message || (assistantMode === 'device' && !deviceUuid)) {
      logger.warn('[AI Chat] Missing required fields', {
        mode: assistantMode,
        deviceUuid: !!deviceUuid,
        message: !!message,
      });
      return reply.status(400).send({
        error: assistantMode === 'device'
          ? 'Missing required fields: deviceUuid, message'
          : 'Missing required fields: message',
      });
    }

    if (assistantMode === 'dashboard') {
      const result = await generateDashboardSuggestions({
        strategy: getStrategy(strategy ?? 'hybrid'),
        requestId: req.id || 'unknown',
        userId: req.user?.id,
        customerId: req.user?.customerId,
        userPrompt: message,
      });

      const response = buildDashboardAssistantSummary(result.cards);
      return reply.send({
        response,
        dashboardSuggestions: result.cards,
        source: result.source,
        strategyRequested: result.strategyRequested,
        fallbackReason: result.fallbackReason,
      });
    }

    // Device mode - generate context-aware suggestions
    const normalizedView = (deviceView || 'metrics').toLowerCase();
    const validViews: DeviceView[] = ['metrics', 'logs', 'endpoints', 'devices', 'config', 'settings', 'jobs', 'applications'];
    const safeView: DeviceView = validViews.includes(normalizedView as DeviceView) ? (normalizedView as DeviceView) : 'metrics';
    
    const deviceSuggestionsResult = await generateDeviceSuggestions({
      context: {
        deviceUuid,
        deviceName: deviceName || 'Device',
        deviceView: safeView,
        userPrompt: message,
      },
      requestId: req.id || 'unknown',
      userId: req.user?.id !== undefined ? String(req.user.id) : undefined,
    });

    const deviceResponse = buildDeviceAssistantResponse(deviceSuggestionsResult);
    
    // Optionally: Also get conversational response from AI service for more context
    const conversationalResponse = await processAIChat({
      deviceUuid,
      message,
      conversationHistory: conversationHistory ?? [],
    }).catch(() => deviceResponse); // Fallback to device response if AI service fails

    logger.info('[AI Chat] Device suggestions generated successfully', {
      deviceUuid,
      view: safeView,
      suggestionCount: deviceSuggestionsResult.suggestions.length,
    });

    reply.send({
      response: deviceResponse,
      deviceSuggestions: deviceSuggestionsResult.suggestions,
      viewContext: deviceSuggestionsResult.viewContext,
      recommendedActions: deviceSuggestionsResult.recommendedActions,
      conversationalResponse,
    });
  } catch (error: any) {
    logger.error('[AI Chat] Error occurred', {
      message: error.message,
      stack: error.stack,
      provider: process.env.AI_PROVIDER || 'ollama',
      hasOpenAiKey: !!process.env.OPENAI_API_KEY,
      openAiModel: process.env.OPENAI_MODEL,
    });
    reply.status(500).send({
      error: 'Internal server error',
      requestId: req.id || 'unknown'
    });
  }
});

};

export default plugin;