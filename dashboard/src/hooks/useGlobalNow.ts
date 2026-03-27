import { useSyncExternalStore } from 'react';

const GLOBAL_NOW_INTERVAL_MS = 1000;

let currentNow = Date.now();
let intervalHandle: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function startGlobalClock(): void {
  if (intervalHandle !== null) {
    return;
  }

  intervalHandle = setInterval(() => {
    currentNow = Date.now();
    listeners.forEach((listener) => listener());
  }, GLOBAL_NOW_INTERVAL_MS);
}

function stopGlobalClockIfUnused(): void {
  if (listeners.size > 0 || intervalHandle === null) {
    return;
  }

  clearInterval(intervalHandle);
  intervalHandle = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  startGlobalClock();

  return () => {
    listeners.delete(listener);
    stopGlobalClockIfUnused();
  };
}

function getSnapshot(): number {
  return currentNow;
}

export function useGlobalNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
