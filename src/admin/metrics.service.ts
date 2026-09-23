import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { config } from '../common/config.js';
import { DATABASE, type Database } from '../common/database.js';
import {
  EVENTS_FAILED,
  EVENTS_PROCESSED,
  EVENTS_RETRIED,
  LATENCY_BUCKETS_MS,
  SINK_LATENCY,
} from '../common/metrics.js';
import {
  RABBITMQ_CONNECTION,
  type RabbitmqConnection,
} from '../replication/sinks/rabbitmq.sink.js';

const MILLISECONDS_PER_SECOND = 1000;

const storedMetricSchema = z.object({
  name: z.string(),
  labels: z.string(),
  value: z.coerce.number(),
});

type StoredMetric = z.infer<typeof storedMetricSchema>;

const gaugeRowSchema = z.object({
  backfill_cursor: z.coerce.number(),
  incremental_cursor: z.coerce.number(),
  source_total: z.coerce.number(),
  dlq_depth: z.coerce.number(),
  lag_seconds: z.coerce.number(),
});

type Gauges = z.infer<typeof gaugeRowSchema>;

interface Family {
  readonly name: string;
  readonly type: 'counter' | 'gauge' | 'histogram';
  readonly help: string;
  readonly samples: readonly string[];
}

interface ThroughputSample {
  readonly cursor: number;
  readonly at: number;
}

const COUNTER_HELP: Readonly<Record<string, string>> = {
  [EVENTS_PROCESSED]: 'Events written to a sink, by pipeline',
  [EVENTS_FAILED]: 'Events rejected by a sink, by pipeline and error class',
  [EVENTS_RETRIED]: 'Batch retries taken after a transient failure',
};

@Injectable()
export class MetricsService {
  readonly #lastSample = new Map<string, ThroughputSample>();

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(RABBITMQ_CONNECTION) private readonly rabbitmq: RabbitmqConnection,
  ) {}

  async render(): Promise<string> {
    const [stored, gauges, queueDepth] = await Promise.all([
      this.#storedMetrics(),
      this.#liveGauges(),
      this.#consumerQueueDepth(),
    ]);

    const families = [
      ...this.#gaugeFamilies(gauges, queueDepth),
      ...counterFamilies(stored),
      latencyFamily(stored),
    ];

    return families
      .filter((family) => family.samples.length > 0)
      .map(renderFamily)
      .join('');
  }

  #gaugeFamilies(gauges: Gauges, queueDepth: number): Family[] {
    const progress = gauges.source_total === 0 ? 0 : gauges.backfill_cursor / gauges.source_total;

    return [
      gauge('replication_dlq_depth', 'Dead letters awaiting replay', [
        sample('replication_dlq_depth', '', gauges.dlq_depth),
      ]),
      gauge('replication_lag_seconds', 'Age of the oldest unprocessed outbox row', [
        sample('replication_lag_seconds', '', gauges.lag_seconds),
      ]),
      gauge('backfill_progress_ratio', 'Backfill cursor over source row count', [
        sample('backfill_progress_ratio', '', Math.min(progress, 1)),
      ]),
      gauge('consumer_queue_depth', 'Messages waiting in the consumer queue', [
        sample('consumer_queue_depth', '', queueDepth),
      ]),
      gauge('replication_last_processed_id', 'Checkpoint position, by pipeline', [
        sample('replication_last_processed_id', 'pipeline="backfill"', gauges.backfill_cursor),
        sample(
          'replication_last_processed_id',
          'pipeline="incremental"',
          gauges.incremental_cursor,
        ),
      ]),
      gauge('pipeline_throughput_per_second', 'Checkpoint movement per second, by pipeline', [
        sample(
          'pipeline_throughput_per_second',
          'pipeline="backfill"',
          this.#throughput('backfill', gauges.backfill_cursor),
        ),
        sample(
          'pipeline_throughput_per_second',
          'pipeline="incremental"',
          this.#throughput('incremental', gauges.incremental_cursor),
        ),
      ]),
    ];
  }

  async #storedMetrics(): Promise<StoredMetric[]> {
    const { rows } = await this.database.query<Record<string, unknown>>(
      'SELECT name, labels, value FROM replication_metrics ORDER BY name, labels',
    );

    return rows.map((row) => storedMetricSchema.parse(row));
  }

  async #liveGauges(): Promise<Gauges> {
    const { rows } = await this.database.query<Record<string, unknown>>(
      `SELECT
         (SELECT last_processed_id FROM replication_checkpoint WHERE pipeline = 'backfill')    AS backfill_cursor,
         (SELECT last_processed_id FROM replication_checkpoint WHERE pipeline = 'incremental') AS incremental_cursor,
         (SELECT count(*) FROM products WHERE deleted_at IS NULL)                              AS source_total,
         (SELECT count(*) FROM replication_dlq WHERE replayed_at IS NULL)                      AS dlq_depth,
         -- SPEC §10: measured from the OLDEST unprocessed row, so a stall makes it climb.
         COALESCE((SELECT EXTRACT(EPOCH FROM now() - min(occurred_at))
                     FROM replication_outbox WHERE processed_at IS NULL), 0)                   AS lag_seconds`,
    );

    return gaugeRowSchema.parse(rows[0]);
  }

  async #consumerQueueDepth(): Promise<number> {
    try {
      const queue = await this.rabbitmq.channel.checkQueue(config.RABBITMQ_QUEUE);
      return queue.messageCount;
    } catch {
      return 0;
    }
  }

  #throughput(pipeline: string, cursor: number): number {
    const now = Date.now();
    const previous = this.#lastSample.get(pipeline);
    this.#lastSample.set(pipeline, { cursor, at: now });

    if (previous === undefined || now === previous.at) {
      return 0;
    }

    return Math.max(((cursor - previous.cursor) * MILLISECONDS_PER_SECOND) / (now - previous.at), 0);
  }
}

function sample(name: string, labels: string, value: number): string {
  return labels === '' ? `${name} ${String(value)}` : `${name}{${labels}} ${String(value)}`;
}

function gauge(name: string, help: string, samples: readonly string[]): Family {
  return { name, type: 'gauge', help, samples };
}

function renderFamily(family: Family): string {
  return [
    `# HELP ${family.name} ${family.help}`,
    `# TYPE ${family.name} ${family.type}`,
    ...family.samples,
    '',
  ].join('\n');
}

function counterFamilies(stored: readonly StoredMetric[]): Family[] {
  return Object.keys(COUNTER_HELP).map((name) => ({
    name,
    type: 'counter' as const,
    help: COUNTER_HELP[name] ?? name,
    samples: stored
      .filter((metric) => metric.name === name)
      .map((metric) => sample(metric.name, metric.labels, metric.value)),
  }));
}

function sinkOf(labels: string): string {
  return /sink="([^"]*)"/.exec(labels)?.[1] ?? '';
}

/**
 * Buckets must be cumulative, ascending and complete. Emitting only the buckets that were
 * incremented leaves gaps that make histogram_quantile silently wrong.
 */
function latencyFamily(stored: readonly StoredMetric[]): Family {
  const sinks = [
    ...new Set(
      stored.filter((m) => m.name.startsWith(SINK_LATENCY)).map((m) => sinkOf(m.labels)),
    ),
  ].sort();

  const samples: string[] = [];

  for (const sink of sinks) {
    const valueOf = (name: string, le?: string): number =>
      stored.find((m) => m.name === name && sinkOf(m.labels) === sink && matchesLe(m.labels, le))
        ?.value ?? 0;

    for (const bucket of LATENCY_BUCKETS_MS) {
      const le = String(bucket);
      samples.push(
        sample(`${SINK_LATENCY}_bucket`, `le="${le}",sink="${sink}"`, valueOf(`${SINK_LATENCY}_bucket`, le)),
      );
    }

    const total = valueOf(`${SINK_LATENCY}_count`);
    samples.push(
      sample(`${SINK_LATENCY}_bucket`, `le="+Inf",sink="${sink}"`, total),
      sample(`${SINK_LATENCY}_sum`, `sink="${sink}"`, valueOf(`${SINK_LATENCY}_sum`)),
      sample(`${SINK_LATENCY}_count`, `sink="${sink}"`, total),
    );
  }

  return {
    name: SINK_LATENCY,
    type: 'histogram',
    help: 'Sink write latency in milliseconds',
    samples,
  };
}

function matchesLe(labels: string, le: string | undefined): boolean {
  return le === undefined ? true : labels.includes(`le="${le}"`);
}
