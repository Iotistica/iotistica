import crypto from 'crypto';
import OpenAI from 'openai';
import { z } from 'zod';
import { query } from '../../db/connection';
import logger from '../../utils/logger';
import { aiTools } from './tools';

export type MetricClass =
  | 'time_series'
  | 'state'
  | 'level'
  | 'instant'
  | 'counter'
  | 'distribution'
  | 'unknown';

export type Bin = 'top' | 'main' | 'side' | 'bottom';
export type ChartType = 'line' | 'bar' | 'gauge' | 'stat';
export type Strategy = 'rules' | 'llm' | 'hybrid';

interface MetricCatalogRow {
  device_id: string;
  device_name: string;
  metric_name: string;
  unit?: string;
}

interface DeviceMetricContext {
  id: string;
  name: string;
  metrics: Array<{
    name: string;
    unit?: string;
  }>;
}

interface CandidateCard {
  id: string;
  deviceId: string;
  deviceName: string;
  metric: string;
  unit?: string;
  chart: ChartType;
  bin: Bin;
  score: number;
  metricClass: MetricClass;
  title?: string;
}

const ALLOWED_CHARTS: ChartType[] = ['line', 'bar', 'gauge', 'stat'];
const ALLOWED_BINS: Bin[] = ['top', 'main', 'side', 'bottom'];

export const BIN_LIMITS: Record<Bin, number> = {
  top: 4,
  main: 6,
  side: 3,
  bottom: 2,
};

const AI_PROVIDER = (process.env.AI_PROVIDER || 'ollama').toLowerCase();
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview';

const isAzure = process.env.OPENAI_BASE_URL?.includes('azure.com');
const openaiClient = AI_PROVIDER === 'openai' && process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: isAzure
        ? `${process.env.OPENAI_BASE_URL}/openai/deployments/${OPENAI_MODEL}`
        : process.env.OPENAI_BASE_URL,
      defaultQuery: isAzure ? { 'api-version': AZURE_API_VERSION } : undefined,
      defaultHeaders: isAzure ? { 'api-key': process.env.OPENAI_API_KEY } : undefined,
    })
  : null;

const suggestedCardSchema = z.object({
  deviceId: z.string().min(1),
  metric: z.string().min(1),
  chart: z.string().min(1),
  bin: z.string().min(1),
  title: z.string().optional(),
});

const suggestedCardsEnvelopeSchema = z.object({
  cards: z.array(suggestedCardSchema),
});

type SuggestedCard = z.infer<typeof suggestedCardSchema>;

export interface DashboardSuggestionCard {
  id: string;
  deviceId: string;
  deviceName: string;
  metric: string;
  unit?: string;
  chart: ChartType;
  bin: Bin;
  score: number;
  metricClass: MetricClass;
  title: string;
}

export interface DashboardSuggestionResult {
  count: number;
  cards: DashboardSuggestionCard[];
  strategyRequested: Strategy;
  source: Strategy | 'rules';
  fallbackReason: string | null;
  generatedAt: string;
  limits: Record<Bin, number>;
}

export function getStrategy(rawValue: unknown): Strategy {
  const value = typeof rawValue === 'string' ? rawValue.toLowerCase() : '';
  if (value === 'llm' || value === 'hybrid' || value === 'rules') {
    return value;
  }
  return 'rules';
}

function classifyMetric(name: string, unit?: string): MetricClass {
  const m = name.toLowerCase();
  const normalizedUnit = (unit || '').toLowerCase();

  if (m.includes('status') || normalizedUnit === 'boolean') return 'state';
  if (m.includes('battery') || normalizedUnit === '%') return 'level';
  if (m.includes('count') || m.includes('total')) return 'counter';
  if (m.includes('rpm')) return 'instant';

  if (
    m.includes('temp') ||
    m.includes('humidity') ||
    normalizedUnit === 'degc' ||
    normalizedUnit === 'c' ||
    normalizedUnit === 'v' ||
    normalizedUnit === 'a'
  ) {
    return 'time_series';
  }

  return 'unknown';
}

function suggestChart(metricClass: MetricClass): ChartType {
  switch (metricClass) {
    case 'time_series':
      return 'line';
    case 'level':
      return 'stat';
    case 'instant':
      return 'gauge';
    case 'state':
      return 'stat';
    case 'counter':
      return 'line';
    case 'distribution':
      return 'bar';
    default:
      return 'line';
  }
}

function suggestBin(metricClass: MetricClass): Bin {
  switch (metricClass) {
    case 'level':
    case 'state':
      return 'top';
    case 'instant':
      return 'side';
    case 'time_series':
    case 'counter':
      return 'main';
    case 'distribution':
      return 'bottom';
    default:
      return 'main';
  }
}

function scoreMetric(metricClass: MetricClass): number {
  switch (metricClass) {
    case 'time_series':
      return 10;
    case 'instant':
      return 9;
    case 'level':
      return 8;
    case 'state':
      return 7;
    case 'counter':
      return 6;
    default:
      return 1;
  }
}

async function loadMetricCatalogRows(): Promise<MetricCatalogRow[]> {
  const metricsResult = await query(
    `
    SELECT
      device_uuid::text AS device_id,
      COALESCE(NULLIF(device_name, ''), 'Unknown device') AS device_name,
      metric_name,
      NULLIF(unit, '') AS unit,
      MAX(last_seen) AS last_seen
    FROM metric_catalog
    WHERE device_uuid IS NOT NULL
    GROUP BY device_uuid, COALESCE(NULLIF(device_name, ''), 'Unknown device'), metric_name, unit
    ORDER BY MAX(last_seen) DESC NULLS LAST
    `
  );

  return metricsResult.rows as MetricCatalogRow[];
}

function groupDeviceMetricContext(rows: MetricCatalogRow[]): DeviceMetricContext[] {
  const grouped = new Map<string, DeviceMetricContext>();

  for (const row of rows) {
    if (!grouped.has(row.device_id)) {
      grouped.set(row.device_id, {
        id: row.device_id,
        name: row.device_name,
        metrics: [],
      });
    }

    const device = grouped.get(row.device_id)!;
    const exists = device.metrics.some(
      metric => metric.name.toLowerCase() === row.metric_name.toLowerCase()
    );

    if (!exists) {
      device.metrics.push({
        name: row.metric_name,
        unit: row.unit || undefined,
      });
    }
  }

  return [...grouped.values()];
}

function createRuleCandidates(rows: MetricCatalogRow[]): CandidateCard[] {
  const candidates = rows.map((row) => {
    const metricClass = classifyMetric(row.metric_name, row.unit || undefined);
    return {
      id: crypto.randomUUID(),
      deviceId: row.device_id,
      deviceName: row.device_name,
      metric: row.metric_name,
      unit: row.unit || undefined,
      chart: suggestChart(metricClass),
      bin: suggestBin(metricClass),
      score: scoreMetric(metricClass),
      metricClass,
      title: `${row.device_name} - ${row.metric_name}`,
    } satisfies CandidateCard;
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function applyBinLimits(candidates: CandidateCard[]): CandidateCard[] {
  const bins: Record<Bin, CandidateCard[]> = {
    top: [],
    main: [],
    side: [],
    bottom: [],
  };

  for (const candidate of candidates) {
    const targetBin = bins[candidate.bin];
    if (targetBin.length < BIN_LIMITS[candidate.bin]) {
      targetBin.push(candidate);
    }
  }

  return Object.values(bins).flat();
}

function buildMetricLookup(rows: MetricCatalogRow[]) {
  const deviceIdByLower = new Map<string, string>();
  const metricsByDevice = new Map<string, Map<string, { metricName: string; unit?: string; deviceName: string }>>();

  for (const row of rows) {
    deviceIdByLower.set(row.device_id.toLowerCase(), row.device_id);

    if (!metricsByDevice.has(row.device_id)) {
      metricsByDevice.set(row.device_id, new Map());
    }

    const byMetric = metricsByDevice.get(row.device_id)!;
    const metricKey = row.metric_name.toLowerCase();
    if (!byMetric.has(metricKey)) {
      byMetric.set(metricKey, {
        metricName: row.metric_name,
        unit: row.unit || undefined,
        deviceName: row.device_name,
      });
    }
  }

  return { deviceIdByLower, metricsByDevice };
}

function normalizeLlmCards(rawCards: SuggestedCard[], rows: MetricCatalogRow[]): CandidateCard[] {
  const { deviceIdByLower, metricsByDevice } = buildMetricLookup(rows);
  const seen = new Set<string>();
  const normalized: CandidateCard[] = [];

  for (const card of rawCards) {
    const resolvedDeviceId = deviceIdByLower.get(card.deviceId.trim().toLowerCase());
    if (!resolvedDeviceId) continue;

    const metricLookup = metricsByDevice.get(resolvedDeviceId);
    const metricInfo = metricLookup?.get(card.metric.trim().toLowerCase());
    if (!metricInfo) continue;

    const signature = `${resolvedDeviceId}::${metricInfo.metricName.toLowerCase()}`;
    if (seen.has(signature)) continue;
    seen.add(signature);

    const metricClass = classifyMetric(metricInfo.metricName, metricInfo.unit);
    normalized.push({
      id: crypto.randomUUID(),
      deviceId: resolvedDeviceId,
      deviceName: metricInfo.deviceName,
      metric: metricInfo.metricName,
      unit: metricInfo.unit,
      chart: ALLOWED_CHARTS.includes(card.chart as ChartType) ? (card.chart as ChartType) : 'line',
      bin: ALLOWED_BINS.includes(card.bin as Bin) ? (card.bin as Bin) : 'main',
      score: scoreMetric(metricClass),
      metricClass,
      title: card.title?.trim() || `${metricInfo.deviceName} - ${metricInfo.metricName}`,
    });
  }

  return normalized;
}

function attachTitlesAndLayout(cards: CandidateCard[], llmCards: CandidateCard[]): CandidateCard[] {
  const llmBySignature = new Map<string, CandidateCard>();
  for (const card of llmCards) {
    llmBySignature.set(`${card.deviceId}::${card.metric.toLowerCase()}`, card);
  }

  return cards.map((card) => {
    const llmCard = llmBySignature.get(`${card.deviceId}::${card.metric.toLowerCase()}`);
    if (!llmCard) return card;

    return {
      ...card,
      chart: llmCard.chart,
      bin: llmCard.bin,
      title: llmCard.title || card.title,
    };
  });
}

function toResponseCards(cards: CandidateCard[]): DashboardSuggestionCard[] {
  return cards.map((card) => ({
    id: card.id,
    deviceId: card.deviceId,
    deviceName: card.deviceName,
    metric: card.metric,
    unit: card.unit,
    chart: card.chart,
    bin: card.bin,
    score: card.score,
    metricClass: card.metricClass,
    title: card.title || `${card.deviceName} - ${card.metric}`,
  }));
}

function extractFirstJsonObject(raw: string): unknown {
  const text = raw.trim();
  if (!text) return { cards: [] };

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
  }

  return { cards: [] };
}

async function getLlmSuggestedCards(
  rows: MetricCatalogRow[],
  options: { baselineCards?: CandidateCard[]; userPrompt?: string } = {}
): Promise<SuggestedCard[]> {
  const devices = groupDeviceMetricContext(rows);
  const baselineCards = options.baselineCards || [];

  const systemPrompt = `You are an IoT dashboard assistant.

Goal:
Suggest useful dashboard charts.

Rules:
- Use only provided devices and metrics
- Prefer important metrics (temperature, rpm, voltage, battery)
- Use:
  - line -> time series
  - gauge -> single value like rpm
  - stat -> battery/status
- Layout bins:
  - top -> stats
  - main -> charts
  - side -> gauges
  - bottom -> secondary

Return ONLY valid JSON using the tool.
Do not explain anything.`;

  const userPayload: Record<string, unknown> = { devices };
  if (baselineCards.length > 0) {
    userPayload.baselineCards = baselineCards.map((card) => ({
      deviceId: card.deviceId,
      metric: card.metric,
      chart: card.chart,
      bin: card.bin,
      title: card.title,
    }));
    userPayload.task = 'Improve titles and layout based on baseline cards while using only listed devices and metrics.';
  }
  if (options.userPrompt?.trim()) {
    userPayload.userRequest = options.userPrompt.trim();
  }

  if (AI_PROVIDER === 'openai') {
    if (!openaiClient || !process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI provider selected but OPENAI_API_KEY is not set');
    }

    const tool = aiTools.find((candidate) => candidate.function.name === 'generate_dashboard_cards');
    if (!tool) {
      throw new Error('generate_dashboard_cards tool is not registered');
    }

    const completion = await openaiClient.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(userPayload) },
      ],
      tools: [tool as any],
      tool_choice: {
        type: 'function',
        function: { name: 'generate_dashboard_cards' },
      },
      temperature: 0.2,
    });

    const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall?.function?.arguments) {
      throw new Error('LLM did not return generate_dashboard_cards arguments');
    }

    return suggestedCardsEnvelopeSchema.parse(JSON.parse(toolCall.function.arguments)).cards;
  }

  const response = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content:
            `${JSON.stringify(userPayload)}\n\nReturn exactly JSON object with this shape: {"cards":[{"deviceId":"...","metric":"...","chart":"line|bar|gauge|stat","bin":"top|main|side|bottom","title":"..."}]}`,
        },
      ],
      stream: false,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json() as any;
  const content = data?.choices?.[0]?.message?.content || '';
  return suggestedCardsEnvelopeSchema.parse(extractFirstJsonObject(content)).cards;
}

export async function generateDashboardSuggestions(options: {
  strategy?: Strategy;
  requestId?: string;
  userId?: string | number;
  userPrompt?: string;
} = {}): Promise<DashboardSuggestionResult> {
  const strategy = options.strategy || 'rules';
  const rows = await loadMetricCatalogRows();
  const baselineCandidates = applyBinLimits(createRuleCandidates(rows));

  let cards = baselineCandidates;
  let source: DashboardSuggestionResult['source'] = 'rules';
  let fallbackReason: string | null = null;

  if (strategy === 'llm' || strategy === 'hybrid') {
    try {
      const llmRawCards = await getLlmSuggestedCards(rows, {
        baselineCards: strategy === 'hybrid' ? baselineCandidates : undefined,
        userPrompt: options.userPrompt,
      });
      const llmCandidates = applyBinLimits(normalizeLlmCards(llmRawCards, rows));

      if (strategy === 'llm') {
        if (llmCandidates.length > 0) {
          cards = llmCandidates;
          source = 'llm';
        } else {
          fallbackReason = 'llm_empty_after_normalization';
        }
      } else if (llmCandidates.length > 0) {
        cards = applyBinLimits(attachTitlesAndLayout(baselineCandidates, llmCandidates));
        source = 'hybrid';
      } else {
        fallbackReason = 'llm_empty_after_normalization';
      }
    } catch (error: any) {
      fallbackReason = error?.message || 'llm_failed';
      logger.warn('LLM dashboard card generation failed, using rules fallback', {
        requestId: options.requestId,
        strategy,
        userId: options.userId,
        provider: AI_PROVIDER,
        error: fallbackReason,
      });
    }
  }

  return {
    count: cards.length,
    cards: toResponseCards(cards),
    strategyRequested: strategy,
    source,
    fallbackReason,
    generatedAt: new Date().toISOString(),
    limits: BIN_LIMITS,
  };
}

export function buildDashboardAssistantSummary(cards: DashboardSuggestionCard[]): string {
  if (cards.length === 0) {
    return 'I could not find enough metrics to build dashboard suggestions right now.';
  }

  const topCards = cards.slice(0, 5).map((card) => `- ${card.title} (${card.chart}, ${card.bin})`);
  return [
    `I generated ${cards.length} dashboard suggestions based on your available devices and metrics.`,
    '',
    'Top suggestions:',
    ...topCards,
    '',
    'Use the preview action below to open them in the dashboard.',
  ].join('\n');
}