/**
 * AI Chat Service
 * 
 * Handles natural language queries about IoT devices using either Ollama (local) or
 * OpenAI GPT models, depending on environment configuration.
 *
 * Ollama setup:
 *   1. Install Ollama: winget install Ollama.Ollama
 *   2. Pull a model: ollama pull llama3.1
 *   3. It runs on http://localhost:11434
 *
 * OpenAI setup:
 *   1. Set AI_PROVIDER=openai
 *   2. Provide OPENAI_API_KEY (and optional OPENAI_BASE_URL, OPENAI_MODEL)
 */

import OpenAI from 'openai';
import { aiTools, executeTool } from './ai-tools';

// Ollama configuration (FREE local LLM)
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1';

// OpenAI configuration
const AI_PROVIDER = (process.env.AI_PROVIDER || 'ollama').toLowerCase();
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview';

// Configure OpenAI client (works for both OpenAI and Azure OpenAI)
const isAzure = process.env.OPENAI_BASE_URL?.includes('azure.com');
const openaiClient = AI_PROVIDER === 'openai' && process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      // For Azure: https://resource.openai.azure.com/openai/deployments/model-name
      // For OpenAI: https://api.openai.com/v1
      baseURL: isAzure 
        ? `${process.env.OPENAI_BASE_URL}/openai/deployments/${OPENAI_MODEL}` 
        : process.env.OPENAI_BASE_URL,
      defaultQuery: isAzure ? { 'api-version': AZURE_API_VERSION } : undefined,
      defaultHeaders: isAzure ? { 'api-key': process.env.OPENAI_API_KEY } : undefined,
    })
  : null;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatRequest {
  deviceUuid: string;
  message: string;
  conversationHistory?: ChatMessage[];
}

interface ProviderMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

async function createChatCompletion(
  messages: any[],
  options: { includeTools?: boolean } = {},
): Promise<ProviderMessage> {
  const includeTools = options.includeTools ?? true;

  if (AI_PROVIDER === 'openai') {
    if (!openaiClient || !process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI provider selected but OPENAI_API_KEY is not set');
    }

    const params: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
      model: OPENAI_MODEL,
      messages,
    };

    if (includeTools) {
      params.tools = aiTools as any;
      params.tool_choice = 'auto';
    }

    const completion = await openaiClient.chat.completions.create(params);
    return completion.choices[0].message as ProviderMessage;
  }

  // Ollama doesn't support tools parameter in the same way as OpenAI
  // So we'll use simple message-based interaction for now
  const body: Record<string, any> = {
    model: OLLAMA_MODEL,
    messages,
    stream: false, // Disable streaming for now
  };

  console.log('[AI Service] Ollama request:', {
    url: `${OLLAMA_URL}/v1/chat/completions`,
    model: OLLAMA_MODEL,
    messageCount: messages.length,
    bodySize: JSON.stringify(body).length,
  });

  // Add timeout controller (2 minutes for first inference)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000); // 120 second timeout

  try {
    const response = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    console.log('[AI Service] Ollama response status:', response.status, response.statusText);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AI Service] Ollama error response:', {
        status: response.status,
        statusText: response.statusText,
        body: errorText,
        headers: Object.fromEntries(response.headers.entries()),
      });
      throw new Error(`Ollama error: ${response.statusText} - ${errorText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: ProviderMessage }>;
    };

    console.log('[AI Service] Ollama response:', {
      hasChoices: !!data.choices,
      choiceCount: data.choices?.length,
      hasMessage: !!data.choices?.[0]?.message,
      messageContentLength: data.choices?.[0]?.message?.content?.length,
    });

    return data.choices[0].message;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.error('[AI Service] Ollama request timeout after 120s');
      throw new Error('AI request timed out. The model may be loading or busy. Please try again in a moment.');
    }
    throw error;
  }
}

/**
 * Process a chat message with the configured AI provider
 */
export async function processAIChat(request: ChatRequest): Promise<string> {
  const { deviceUuid, message, conversationHistory = [] } = request;

  console.log('[AI Service] Processing chat request:', {
    provider: AI_PROVIDER,
    model: AI_PROVIDER === 'openai' ? OPENAI_MODEL : OLLAMA_MODEL,
    hasOpenAiClient: !!openaiClient,
    deviceUuid,
  });

  try {
    // For Ollama, fetch device data upfront and include in context
    // For OpenAI, use tool calling
    let systemPrompt = `You are an IoT device assistant. You help users monitor and manage their IoT devices.
Current device UUID: ${deviceUuid}

Be concise and helpful. When showing metrics, use clear formatting.
If asked to perform actions like restarting containers, explain that you can provide information but the user needs to use the dashboard controls for actions.`;

    if (AI_PROVIDER === 'ollama') {
      // Fetch device data and include in system prompt
      console.log('[AI Service] Fetching device data for Ollama context');
      try {
        const deviceInfo = await executeTool('get_device_info', { deviceUuid });
        const deviceMetrics = await executeTool('get_device_metrics', {
          deviceUuid,
          limit: 10,
        });

        console.log('[AI Service] Device data fetched:', {
          deviceInfoLength: deviceInfo.length,
          deviceMetricsLength: deviceMetrics.length,
        });

        systemPrompt += `\n\nCurrent Device Information:\n${deviceInfo}\n\nRecent Metrics (last 10 readings):\n${deviceMetrics}\n\nUse this data to answer the user's questions.`;
      } catch (err: any) {
        console.warn('[AI Service] Failed to fetch device data for context:', {
          error: err.message,
          stack: err.stack,
        });
      }
    }

    // Build messages array
    const messages: any[] = [
      {
        role: 'system',
        content: systemPrompt,
      },
      ...conversationHistory
        .filter((msg) => msg.content && msg.content.trim().length > 0) // Filter out empty messages
        .map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
      {
        role: 'user',
        content: message,
      },
    ];

    console.log('[AI Service] Prepared messages:', {
      messageCount: messages.length,
      systemPromptLength: systemPrompt.length,
      userMessageLength: message.length,
      historyLength: conversationHistory.length,
      filteredHistoryLength: conversationHistory.filter((msg) => msg.content && msg.content.trim().length > 0).length,
    });

    const responseMessage = await createChatCompletion(messages, {
      includeTools: AI_PROVIDER === 'openai', // Only use tools with OpenAI
    });

    console.log('[AI Service] Received response from AI:', {
      hasContent: !!responseMessage.content,
      contentLength: responseMessage.content?.length,
      hasToolCalls: !!responseMessage.tool_calls,
      toolCallCount: responseMessage.tool_calls?.length,
    });

    // Check if AI wants to use tools (OpenAI only)
    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      // Execute tool calls
      messages.push(responseMessage);

      for (const toolCall of responseMessage.tool_calls) {
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);
        const functionResponse = await executeTool(functionName, functionArgs);

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: functionResponse,
        });
      }

      const finalMessage = await createChatCompletion(messages, { includeTools: false });
      return finalMessage.content || 'No response';
    }

    return responseMessage.content || 'No response';
  } catch (error: any) {
    console.error('[AI Service] Error in processAIChat:', {
      provider: AI_PROVIDER,
      errorMessage: error.message,
      errorStack: error.stack,
      errorName: error.name,
      errorCode: error.code,
      openAiError: error.error,
      hasOpenAiClient: !!openaiClient,
    });
    
    if (AI_PROVIDER === 'ollama' && (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED'))) {
      throw new Error('Ollama is not running. Please start it with: ollama serve');
    }
    
    if (AI_PROVIDER === 'openai') {
      // Log detailed OpenAI error
      console.error('[AI Service] OpenAI Error Details:', {
        status: error.status,
        type: error.type,
        code: error.code,
        param: error.param,
        error: error.error,
      });
    }
    
    throw new Error(`AI chat failed: ${error.message}`);
  }
}
