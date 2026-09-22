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

export interface PipelineStatusReport {
  readonly checkpoints: z.infer<typeof checkpointRowsSchema>;
  readonly counts: z.infer<typeof countsSchema> & { readonly elasticsearch: number | null };
  readonly dlqDepth: number;
  readonly pendingPoison: number;
  readonly sinks: Record<SimulatedSink, boolean>;
}

@Injectable()
export class StatusService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(ELASTICSEARCH_CLIENT) private readonly elasticsearch: Client,
  ) {}

  async report(): Promise<PipelineStatusReport> {
    const [checkpoints, counts, dlqDepth, pendingPoison, sinks, elasticsearch] = await Promise.all([
      this.#checkpoints(),
      this.#counts(),
      countUnreplayedDeadLetters(this.database),
      countPendingPoison(this.database),
      readSinkStates(this.database),
      this.#elasticsearchCount(),
    ]);

    return { checkpoints, counts: { ...counts, elasticsearch }, dlqDepth, pendingPoison, sinks };
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
