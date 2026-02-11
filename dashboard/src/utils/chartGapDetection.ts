/**
 * Utility functions for detecting and visualizing gaps/interruptions in time-series chart data
 * Used to show service interruptions similar to Azure metrics
 */

import React from 'react';

export interface DataPointWithTime {
  time: string | number;
  [key: string]: any;
}

/**
 * Process time-series data to detect and mark gaps/service interruptions
 * Gaps are detected when the time between consecutive points exceeds a threshold
 * 
 * @param data - Array of data points with time field
 * @param gapMultiplier - Multiplier for average interval to detect gaps (default: 2.5)
 * @returns Processed data with isGap flag on points that have a gap before them
 */
export function detectGaps<T extends DataPointWithTime>(
  data: T[],
  gapMultiplier: number = 2.5
): (T & { isGap?: boolean })[] {
  if (data.length < 2) {
    return data;
  }

  // Calculate median time interval between points to avoid skew from large gaps
  const intervals: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const prevTime = typeof data[i - 1].time === 'number' 
      ? data[i - 1].time 
      : new Date(data[i - 1].time as string).getTime();
    const currTime = typeof data[i].time === 'number' 
      ? data[i].time 
      : new Date(data[i].time as string).getTime();
    
    const interval = (currTime as number) - (prevTime as number);
    intervals.push(interval);
  }

  if (intervals.length === 0) {
    return data;
  }

  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  const mid = Math.floor(sortedIntervals.length / 2);
  const medianInterval = sortedIntervals.length % 2 === 0
    ? (sortedIntervals[mid - 1] + sortedIntervals[mid]) / 2
    : sortedIntervals[mid];
  const gapThreshold = medianInterval * gapMultiplier;

  // Mark points that have a gap before them
  const processed: (T & { isGap?: boolean })[] = [data[0]];

  for (let i = 1; i < data.length; i++) {
    const prevTime = typeof data[i - 1].time === 'number' 
      ? data[i - 1].time 
      : new Date(data[i - 1].time as string).getTime();
    const currTime = typeof data[i].time === 'number' 
      ? data[i].time 
      : new Date(data[i].time as string).getTime();
    
    const timeDiff = (currTime as number) - (prevTime as number);

    if (timeDiff > gapThreshold) {
      // Mark this point as having a gap before it
      processed.push({ ...data[i], isGap: true });
    } else {
      processed.push(data[i]);
    }
  }

  return processed;
}

/**
 * Custom dot renderer for Recharts that shows warning indicators at gap points
 * Use this with Line or Area components: dot={(props) => renderGapDot(props)}
 */
export function renderGapDot(props: any, color: string = '#ef4444', size: number = 4): React.ReactElement<SVGElement> {
  // Show warning dot at gap points
  if (props.payload?.isGap) {
    return React.createElement('circle', {
      key: `gap-dot-${props.index}`,
      cx: props.cx,
      cy: props.cy,
      r: size,
      fill: color,
      stroke: '#ffffff',
      strokeWidth: 2
    }) as unknown as React.ReactElement<SVGElement>;
  }
  // Return empty SVG group instead of null to satisfy Recharts type requirements
  return React.createElement('g', { key: `gap-dot-empty-${props.index}` }) as unknown as React.ReactElement<SVGElement>;
}

/**
 * Creates a gap dot renderer with custom options
 */
export function createGapDotRenderer(options?: { color?: string; size?: number }) {
  const color = options?.color || '#ef4444';
  const size = options?.size || 4;
  
  return (props: any) => renderGapDot(props, color, size);
}
