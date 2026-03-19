export type ParsedCanonicalMetric = {
  deviceUuid: string;
  scope: string;
  metric: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseCanonicalMetricName(metricName: string): ParsedCanonicalMetric | null {
  if (!metricName) return null;

  const firstSep = metricName.indexOf('_');
  const secondSep = firstSep >= 0 ? metricName.indexOf('_', firstSep + 1) : -1;
  if (firstSep <= 0 || secondSep <= firstSep + 1) return null;

  const deviceUuid = metricName.slice(0, firstSep);
  const scope = metricName.slice(firstSep + 1, secondSep);
  const metric = metricName.slice(secondSep + 1);

  if (!UUID_PATTERN.test(deviceUuid) || !scope || !metric) return null;
  return { deviceUuid, scope, metric };
}

function humanizeMetricLeaf(metricName: string): string {
  if (!metricName) return metricName;

  const normalized = metricName.replace(/[_-]+/g, ' ').trim();
  if (!normalized) return metricName;

  return normalized
    .split(/\s+/)
    .map((word) => {
      const lower = word.toLowerCase();
      if (lower === 'cpu') return 'CPU';
      if (lower === 'ram') return 'RAM';
      if (lower === 'io') return 'I/O';
      if (lower === 'rx') return 'RX';
      if (lower === 'tx') return 'TX';
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

export function formatMetricForDisplay(metricName: string): string {
  const parsed = parseCanonicalMetricName(metricName);
  if (parsed) {
    return humanizeMetricLeaf(parsed.metric);
  }

  return humanizeMetricLeaf(metricName);
}
