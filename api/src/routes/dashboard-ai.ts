import express from 'express';
import crypto from 'crypto';
import { query } from '../db/connection';
import { jwtAuth } from '../middleware/jwt-auth';
import logger from '../utils/logger';

type MetricClass =
  | 'time_series'
  | 'state'
  | 'level'
  | 'instant'
  | 'counter'
  | 'distribution'
  | 'unknown';

type Bin = 'top' | 'main' | 'side' | 'bottom';
type ChartType = 'line' | 'bar' | 'gauge' | 'stat';

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
}

const BIN_LIMITS: Record<Bin, number> = {
  top: 4,
  main: 6,
  side: 3,
  bottom: 2,
};

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

const router = express.Router();

router.get('/ai-cards', jwtAuth, async (req, res) => {
  const requestId = (req as any).id || 'unknown';

  try {
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

    const candidates: CandidateCard[] = metricsResult.rows.map((row: any) => {
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
      };
    });

    candidates.sort((a, b) => b.score - a.score);

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

    const cards = Object.values(bins).flat();

    res.json({
      count: cards.length,
      cards,
      generatedAt: new Date().toISOString(),
      limits: BIN_LIMITS,
    });
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
