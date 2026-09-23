import { Client } from '@elastic/elasticsearch';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { config } from '../common/config.js';
import { DATABASE, type Database } from '../common/database.js';
import { countUnreplayedDeadLetters } from '../replication/dlq/dlq.repository.js';
import {
  countPendingPoison,
  readSinkStates,
  type SimulatedSink,
} from '../replication/simulation/simulation.repository.js';
import { ELASTICSEARCH_CLIENT } from '../replication/sinks/elasticsearch.sink.js';
import {
  RABBITMQ_CONNECTION,
  type RabbitmqConnection,
} from '../replication/sinks/rabbitmq.sink.js';

const checkpointRowsSchema = z.array(
  z.object({
    pipeline: z.string(),
    last_processed_id: z.coerce.number().int(),
    status: z.string(),
  }),
);

const countsSchema = z.object({
  source: z.coerce.number().int(),
  projection: z.coerce.number().int(),
  processed_events: z.coerce.number().int(),
  outbox_pending: z.coerce.number().int(),
});

const lagRowSchema = z.object({ lag_seconds: z.coerce.number() });

export interface PipelineStatusReport {
  readonly checkpoints: z.infer<typeof checkpointRowsSchema>;
  readonly counts: z.infer<typeof countsSchema> & { readonly elasticsearch: number | null };
  readonly backfillProgressRatio: number;
  readonly lagSeconds: number;
  readonly consumerQueueDepth: number;
  readonly dlqDepth: number;
  readonly pendingPoison: number;
  readonly sinks: Record<SimulatedSink, boolean>;
}

@Injectable()
export class StatusService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(ELASTICSEARCH_CLIENT) private readonly elasticsearch: Client,
    @Inject(RABBITMQ_CONNECTION) private readonly rabbitmq: RabbitmqConnection,
  ) {}

  async report(): Promise<PipelineStatusReport> {
    const [checkpoints, counts, dlqDepth, pendingPoison, sinks, elasticsearch, lagSeconds, queue] =
      await Promise.all([
        this.#checkpoints(),
        this.#counts(),
        countUnreplayedDeadLetters(this.database),
        countPendingPoison(this.database),
        readSinkStates(this.database),
        this.#elasticsearchCount(),
        this.#lagSeconds(),
        this.#consumerQueueDepth(),
      ]);

    const backfill = checkpoints.find((row) => row.pipeline === 'backfill')?.last_processed_id ?? 0;

    return {
      checkpoints,
      counts: { ...counts, elasticsearch },
      backfillProgressRatio: counts.source === 0 ? 0 : Math.min(backfill / counts.source, 1),
      lagSeconds,
      consumerQueueDepth: queue,
      dlqDepth,
      pendingPoison,
      sinks,
    };
  }

  async #checkpoints(): Promise<z.infer<typeof checkpointRowsSchema>> {
    const { rows } = await this.database.query<Record<string, unknown>>(
      'SELECT pipeline, last_processed_id, status FROM replication_checkpoint ORDER BY pipeline',
    );

    return checkpointRowsSchema.parse(rows);
  }

  async #counts(): Promise<z.infer<typeof countsSchema>> {
    const { rows } = await this.database.query<Record<string, unknown>>(
      `SELECT (SELECT count(*) FROM products WHERE deleted_at IS NULL)            AS source,
              (SELECT count(*) FROM product_projection)                           AS projection,
              (SELECT count(*) FROM processed_events)                             AS processed_events,
              (SELECT count(*) FROM replication_outbox WHERE processed_at IS NULL) AS outbox_pending`,
    );

    return countsSchema.parse(rows[0]);
  }

  async #lagSeconds(): Promise<number> {
    const { rows } = await this.database.query<Record<string, unknown>>(
      `SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(occurred_at)), 0) AS lag_seconds
         FROM replication_outbox WHERE processed_at IS NULL`,
    );

    return lagRowSchema.parse(rows[0]).lag_seconds;
  }

  async #consumerQueueDepth(): Promise<number> {
    try {
      return (await this.rabbitmq.channel.checkQueue(config.RABBITMQ_QUEUE)).messageCount;
    } catch {
      return 0;
    }
  }

  /** Null, not a throw: a status endpoint that dies with a sink cannot report the outage. */
  async #elasticsearchCount(): Promise<number | null> {
    try {
      const response = await this.elasticsearch.count({ index: config.ELASTICSEARCH_INDEX });
      return response.count;
    } catch {
      return null;
    }
  }
}
