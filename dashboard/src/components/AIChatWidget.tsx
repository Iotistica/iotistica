/**
 * AI Chat Widget
 * 
 * Allows customers to interact with their IoT devices using natural language.
 * Powered by OpenAI + your API66
 */

import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Send, X, Loader2, Bot, User } from 'lucide-react';
import { buildApiUrl } from '../config/api';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  dashboardSuggestions?: DashboardSuggestion[];
}

interface DashboardSuggestion {
  id: string;
  deviceId: string;
  deviceName: string;
  metric: string;
  unit?: string;
  chart: 'line' | 'bar' | 'gauge' | 'stat';
  bin: 'top' | 'main' | 'side' | 'bottom';
  score: number;
  metricClass: string;
  title: string;
}

interface AIChatWidgetProps {
  mode: 'device' | 'dashboard';
  deviceUuid?: string;
  deviceName?: string;
  isOpen: boolean;
  onClose: () => void;
}

export function AIChatWidget({ mode, deviceUuid, deviceName, isOpen, onClose }: AIChatWidgetProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      role: 'assistant',
      content: mode === 'dashboard'
        ? "Hi! I'm your dashboard assistant. I can suggest dashboard layouts and metrics based on your devices. What kind of dashboard do you want?"
        : "Hi! I'm your IoT assistant. I can help you monitor agents, check logs, restart containers, and more. What would you like to know?",
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  // Format agent identifier for display
  const agentIdentifier = deviceUuid
    ? (deviceName ? `agent ${deviceName} [${deviceUuid}]` : `agent [${deviceUuid}]`)
    : 'your fleet';
  
  const promptPresets = mode === 'dashboard'
    ? [
        {
          label: 'Ops dashboard',
          prompt: 'Build me an operations dashboard with the most important charts for health, performance, and battery metrics.',
        },
        {
          label: 'Energy dashboard',
          prompt: 'Create a dashboard focused on power, voltage, current, and battery related metrics.',
        },
        {
          label: 'Temperature trends',
          prompt: 'Suggest a dashboard centered on temperature and humidity trends across devices.',
        },
        {
          label: 'Executive summary',
          prompt: 'Give me a compact executive dashboard with top stats, one or two main charts, and side gauges.',
        },
      ]
    : [
        {
          label: 'Health snapshot',
          prompt: `Give me a health summary for ${agentIdentifier} covering uptime, CPU, memory, and any critical alerts over the past 24 hours.`,
        },
        {
          label: 'Performance spikes',
          prompt: `Analyze ${agentIdentifier} for any CPU or memory spikes during the last 4 hours and explain likely causes with supporting metrics.`,
        },
        {
          label: 'Error log digest',
          prompt: `Review the most recent logs for ${agentIdentifier} and list the top recurring errors with timestamps and impacted services.`,
        },
        {
          label: 'Container review',
          prompt: `List all running containers on ${agentIdentifier}, highlight ones consuming the most resources, and recommend restarts if needed.`,
        },
        {
          label: 'Connectivity issues',
          prompt: `Investigate recent connectivity drops for ${agentIdentifier} and suggest remediation steps based on status history and metrics.`,
        },
      ];

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch(buildApiUrl('/api/v1/ai/chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
        },
        body: JSON.stringify({
          mode,
          deviceUuid,
          message: input,
          conversationHistory: messages.slice(-5), // Last 5 messages for context
          strategy: mode === 'dashboard' ? 'hybrid' : undefined,
        }),
      });

      const data = await response.json();

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.response,
        timestamp: new Date(),
        dashboardSuggestions: Array.isArray(data.dashboardSuggestions) ? data.dashboardSuggestions : undefined,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      console.error('AI chat error:', error);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: "Sorry, I'm having trouble connecting right now. Please try again.",
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const previewDashboardSuggestions = (suggestions: DashboardSuggestion[]) => {
    window.dispatchEvent(new CustomEvent('dashboard-ai-suggestions-generated', {
      detail: {
        cards: suggestions,
      },
    }));
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50" style={{ width: '384px', height: '600px' }}>
      <Card className="flex flex-col h-full w-full shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b bg-primary text-primary-foreground">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5" />
            <h3 className="font-semibold">{mode === 'dashboard' ? 'Dashboard Assistant' : 'IoT Assistant'}</h3>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="text-primary-foreground hover:bg-primary-foreground/20"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex gap-2 ${
                message.role === 'user' ? 'justify-end' : 'justify-start'
              }`}
            >
              {message.role === 'assistant' && (
                <div className="flex-shrink-0">
                  <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <Bot className="h-4 w-4 text-primary" />
                  </div>
                </div>
              )}

              <div
                className={`max-w-[75%] rounded-lg p-3 ${
                  message.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted'
                }`}
              >
                {message.role === 'assistant' ? (
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]} 
                    className="text-sm prose prose-sm max-w-none dark:prose-invert prose-headings:mt-2 prose-headings:mb-1 prose-p:my-1 prose-ul:my-1 prose-ol:my-1"
                  >
                    {message.content}
                  </ReactMarkdown>
                ) : (
                  <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                )}
                <span className="text-xs opacity-70 mt-1 block">
                  {message.timestamp.toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                {mode === 'dashboard' && message.dashboardSuggestions && message.dashboardSuggestions.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={() => previewDashboardSuggestions(message.dashboardSuggestions!)}
                  >
                    Preview Suggested Dashboard
                  </Button>
                )}
              </div>

              {message.role === 'user' && (
                <div className="flex-shrink-0">
                  <div className="h-8 w-8 rounded-full bg-primary flex items-center justify-center">
                    <User className="h-4 w-4 text-primary-foreground" />
                  </div>
                </div>
              )}
            </div>
          ))}

          {isLoading && (
            <div className="flex gap-2 justify-start">
              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                <Bot className="h-4 w-4 text-primary" />
              </div>
              <div className="bg-muted rounded-lg p-3">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="p-4 border-t">
          <div className="flex gap-2">
            <Input
              placeholder={mode === 'dashboard' ? 'Ask for a dashboard layout...' : 'Ask about your devices...'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={handleKeyPress}
              disabled={isLoading}
              className="flex-1"
            />
            <Button onClick={sendMessage} disabled={isLoading || !input.trim()}>
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>

          {/* Suggestions */}
          <div 
            className="mt-2 flex flex-wrap gap-1 max-h-[80px] overflow-y-auto pr-2"
            style={{
              scrollbarWidth: 'thin',
              scrollbarColor: '#9ca3af #f3f4f6'
            }}
          >
            {promptPresets.map(({ label, prompt }) => (
              <Button
                key={label}
                variant="outline"
                size="sm"
                className="text-xs flex-shrink-0"
                onClick={() => setInput(prompt)}
                disabled={isLoading}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
