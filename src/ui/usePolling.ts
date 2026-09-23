import { useEffect, useState } from 'react';

export const POLL_INTERVAL_MS = 2000;

export interface Polled<Value> {
  value: Value | undefined;
  error: string | undefined;
  refresh: () => void;
}

/** Skips a tick rather than stacking requests, so a slow api cannot queue up work. */
export function usePolling<Value>(load: () => Promise<Value>, intervalMs = POLL_INTERVAL_MS) {
  const [value, setValue] = useState<Value>();
  const [error, setError] = useState<string>();
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const tick = (): void => {
      if (inFlight) {
        return;
      }

      inFlight = true;
      load()
        .then((next) => {
          if (!cancelled) {
            setValue(next);
            setError(undefined);
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        })
        .finally(() => {
          inFlight = false;
        });
    };

    tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs, nonce]);

  return {
    value,
    error,
    refresh: () => {
      setNonce((n) => n + 1);
    },
  };
}
