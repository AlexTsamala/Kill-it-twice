import { setTimeout as delay } from 'node:timers/promises';

import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';

import { config } from './config.js';
import { DATABASE, type Database } from './database.js';
import { logger } from './logger.js';

export const EVENTS_PROCESSED = 'replication_events_processed_total';
export const EVENTS_FAILED = 'replication_events_failed_total';
export const EVENTS_RETRIED = 'replication_events_retried_total';
export const SINK_LATENCY = 'sink_write_latency_ms';

export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

export type MetricLabels = Readonly<Record<string, string>>;

/** Also the Prometheus label syntax, so a stored key renders without further work. */
export function serialiseLabels(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}="${labels[key] ?? ''}"`)
    .join(',');
}

function keyOf(name: string, labels: MetricLabels): string {
  return `${name}\u0000${serialiseLabels(labels)}`;
}

@Injectable()
export class MetricsRecorder implements OnModuleInit, OnApplicationShutdown {
  readonly #pending = new Map<string, number>();
  readonly #abort = new AbortController();
  #flushing: Promise<void> = Promise.resolve();

  constructor(@Inject(DATABASE) private readonly database: Database) {}

  onModuleInit(): void {
    this.#flushing = this.#flushLoop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.#abort.abort();
    await this.#flushing;
    await this.flush();
  }

  increment(name: string, labels: MetricLabels, by = 1): void {
    if (by === 0) {
      return;
    }

    const key = keyOf(name, labels);
    this.#pending.set(key, (this.#pending.get(key) ?? 0) + by);
  }

  /** Cumulative buckets, so the stored rows are already in Prometheus histogram shape. */
  observeLatency(sink: string, milliseconds: number): void {
    for (const bucket of LATENCY_BUCKETS_MS) {
      if (milliseconds <= bucket) {
        this.increment(`${SINK_LATENCY}_bucket`, { sink, le: String(bucket) });
      }
    }

    this.increment(`${SINK_LATENCY}_bucket`, { sink, le: '+Inf' });
    this.increment(`${SINK_LATENCY}_sum`, { sink }, milliseconds);
    this.increment(`${SINK_LATENCY}_count`, { sink });
  }

  async flush(): Promise<void> {
    if (this.#pending.size === 0) {
      return;
    }

    const batch = [...this.#pending.entries()];
    this.#pending.clear();

    try {
      await this.#persist(batch);
    } catch (error) {
      for (const [key, value] of batch) {
        this.#pending.set(key, (this.#pending.get(key) ?? 0) + value);
      }
      logger.warn({ err: error, pending: this.#pending.size }, 'metric flush failed; will retry');
    }
  }

  async #persist(batch: readonly (readonly [string, number])[]): Promise<void> {
    const names: string[] = [];
    const labels: string[] = [];
    const values: number[] = [];

    for (const [key, value] of batch) {
      const [name = '', label = ''] = key.split('\u0000');
      names.push(name);
      labels.push(label);
      values.push(value);
    }

    await this.database.query(
      `INSERT INTO replication_metrics (name, labels, value)
       SELECT * FROM unnest($1::text[], $2::text[], $3::float8[])
       ON CONFLICT (name, labels) DO UPDATE
          SET value = replication_metrics.value + excluded.value, updated_at = now()`,
      [names, labels, values],
    );
  }

  async #flushLoop(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      try {
        await delay(config.METRICS_FLUSH_INTERVAL_MS , undefined, { signal: this.#abort.signal });
      } catch {
        return;
      }
      await this.flush();
    }
  }
}
