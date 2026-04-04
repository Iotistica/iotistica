import { useEffect, useRef, useState } from 'react';
import { buildApiUrl } from '@/config/api';
import { metricsRequestQueue } from '@/utils/metricsRequestQueue';

export interface IngestionHealth {
  lastProcessedTimestamp: number | null;
  ingestionHealthy: boolean;
  spoolingActive: boolean;
  backlogSize: number;
}

// All MetricDataCard instances share one poll via metricsRequestQueue's in-flight+cache dedup.
const CACHE_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 30_000;

export function useIngestionHealth(): IngestionHealth | null {
  const [health, setHealth] = useState<IngestionHealth | null>(null);
  const fetchRef = useRef<() => Promise<void>>(async () => {});

  const fetchHealth = async () => {
    try {
      const result = await metricsRequestQueue.enqueue<IngestionHealth>(
        'ingestion-health',
        async () => {
          const response = await fetch(buildApiUrl('/api/v1/metrics/ingestion-health'), {
            headers: {
              Authorization: `Bearer ${localStorage.getItem('accessToken')}`,
            },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<IngestionHealth>;
        },
        CACHE_TTL_MS,
      );
      setHealth(result);
    } catch {
      // Non-fatal: ingestion health failure must not break the chart render
    }
  };

  fetchRef.current = fetchHealth;

  useEffect(() => {
    void fetchRef.current();
    const interval = setInterval(() => void fetchRef.current(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return health;
}
