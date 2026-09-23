import { setTimeout as delay } from 'node:timers/promises';

import { config } from './config.js';
import { classifyThrownError } from './errors.js';
import { logger } from './logger.js';

export interface RetryOptions {
  readonly pipeline: string;
  readonly signal: AbortSignal;
  readonly random: () => number;
  /** Called once per retry. A callback rather than a recorder keeps this file free of the
   *  database, so the backoff stays unit-testable without a running Postgres. */
  readonly onRetry: () => void;
}

export function backoffCeilingMs(attempt: number): number {
  return Math.min(config.RETRY_CAP_MS, config.RETRY_BASE_MS * 2 ** attempt);
}

export function fullJitterDelayMs(attempt: number, random: () => number): number {
  return Math.floor(random() * backoffCeilingMs(attempt));
}

async function waitBeforeRetry(
  attempt: number,
  error: unknown,
  options: RetryOptions,
): Promise<void> {
  const delayMs = fullJitterDelayMs(attempt, options.random);
  options.onRetry();

  logger.warn(
    { pipeline: options.pipeline, attempt: attempt + 1, delayMs, err: error },
    'transient failure; retrying',
  );

  await delay(delayMs, undefined, { signal: options.signal });
}

/**
 * Backs off between whole rounds too, not just between attempts inside one. Without it a
 * round restarts the moment the previous one gave up, and a 60s outage costs ~36 attempts
 * against G3's budget of 30.
 */
export async function waitAfterFailedRound(
  consecutiveFailures: number,
  options: RetryOptions,
): Promise<void> {
  try {
    await delay(fullJitterDelayMs(consecutiveFailures, options.random), undefined, {
      signal: options.signal,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'AbortError') {
      throw error;
    }
  }
}

export async function retryTransient<Result>(
  work: () => Promise<Result>,
  options: RetryOptions,
): Promise<Result> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const isLastAttempt = attempt + 1 >= config.RETRY_MAX_ATTEMPTS;
      if (isLastAttempt || classifyThrownError(error) === 'permanent') {
        throw error;
      }

      await waitBeforeRetry(attempt, error, options);
    }
  }
}
