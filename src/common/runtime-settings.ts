import { z } from 'zod';

import { config } from './config.js';
import type { Database } from './database.js';

export const RUNTIME_KEYS = [
  'backfill_paused',
  'kill_worker',
  'batch_size',
  'outbox_poll_interval_ms',
  'retry_max_attempts',
] as const;

export type RuntimeKey = (typeof RUNTIME_KEYS)[number];

const settingRowSchema = z.object({ key: z.string(), value: z.string() });

export interface RuntimeSettings {
  readonly backfillPaused: boolean;
  readonly killWorker: boolean;
  readonly batchSize: number;
  readonly outboxPollIntervalMs: number;
  readonly retryMaxAttempts: number;
}

function defaults(): RuntimeSettings {
  return {
    backfillPaused: false,
    killWorker: false,
    batchSize: config.BATCH_SIZE,
    outboxPollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    retryMaxAttempts: config.RETRY_MAX_ATTEMPTS,
  };
}

function overlay(base: RuntimeSettings, key: string, value: string): RuntimeSettings {
  const asNumber = Number(value);
  const asBoolean = value === 'true';

  switch (key) {
    case 'backfill_paused':
      return { ...base, backfillPaused: asBoolean };
    case 'kill_worker':
      return { ...base, killWorker: asBoolean };
    case 'batch_size':
      return Number.isFinite(asNumber) ? { ...base, batchSize: asNumber } : base;
    case 'outbox_poll_interval_ms':
      return Number.isFinite(asNumber) ? { ...base, outboxPollIntervalMs: asNumber } : base;
    case 'retry_max_attempts':
      return Number.isFinite(asNumber) ? { ...base, retryMaxAttempts: asNumber } : base;
    default:
      return base;
  }
}

export async function readRuntimeSettings(db: Database): Promise<RuntimeSettings> {
  const { rows } = await db.query<Record<string, unknown>>('SELECT key, value FROM runtime_settings');

  return rows
    .map((row) => settingRowSchema.parse(row))
    .reduce((settings, row) => overlay(settings, row.key, row.value), defaults());
}

export async function writeRuntimeSetting(
  db: Database,
  key: RuntimeKey,
  value: string,
): Promise<void> {
  await db.query(
    `INSERT INTO runtime_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [key, value],
  );
}

export async function clearRuntimeSetting(db: Database, key: RuntimeKey): Promise<void> {
  await db.query('DELETE FROM runtime_settings WHERE key = $1', [key]);
}
