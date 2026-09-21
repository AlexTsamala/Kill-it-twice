import { setTimeout as delay } from 'node:timers/promises';

import { Inject, Injectable } from '@nestjs/common';

import { config } from '../../common/config.js';
import { DATABASE, type Database } from '../../common/database.js';
import { logger } from '../../common/logger.js';
import { setPipelineStatus } from '../checkpoint.js';
import { commitOutboxProgress, fetchUnprocessedOutboxRows, type OutboxRow } from '../outbox.js';
import { buildOutboxEvent } from '../product-event.factory.js';
import { EVENT_SINK, type EventSink } from '../sinks/event-sink.js';
import {
  PRODUCT_SINK,
  type ProductSink,
  type SinkOperation,
  deleteOperation,
  indexOperation,
} from '../sinks/product-sink.js';

const PIPELINE = 'incremental';

function toSinkOperation(row: OutboxRow): SinkOperation {
  if (row.event_type === 'product.deleted') {
    return deleteOperation(row.aggregate_id, row.version);
  }

  return indexOperation({
    id: row.payload.id,
    sku: row.payload.sku,
    name: row.payload.name,
    description: null,
    price: row.payload.price,
    status: row.payload.status,
    version: row.version,
    updated_at: row.occurred_at.toISOString(),
  });
}

@Injectable()
export class IncrementalWorker {
  #stopRequested = false;
  readonly #abort = new AbortController();

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PRODUCT_SINK) private readonly productSink: ProductSink,
    @Inject(EVENT_SINK) private readonly eventSink: EventSink,
  ) {}

  requestStop(): void {
    this.#stopRequested = true;
    this.#abort.abort();
  }

  async run(): Promise<void> {
    await setPipelineStatus(this.database, PIPELINE, 'running');
    logger.info({ pipeline: PIPELINE }, 'incremental worker started');

    let processed = 0;

    while (!this.#stopRequested) {
      const rows = await fetchUnprocessedOutboxRows(this.database, config.BATCH_SIZE);
      const lastRow = rows.at(-1);

      if (lastRow === undefined) {
        await this.#waitBeforeNextPoll();
        continue;
      }

      processed += await this.#processBatch(rows, lastRow.id);
    }

    await setPipelineStatus(this.database, PIPELINE, 'paused');
    logger.info({ pipeline: PIPELINE, processed }, 'incremental worker stopped');
  }

  async #processBatch(rows: readonly OutboxRow[], lastId: number): Promise<number> {
    const result = await this.productSink.writeBatch(rows.map(toSinkOperation));

    if (result.failures.length > 0) {
      for (const failure of result.failures) {
        logger.error(
          {
            pipeline: PIPELINE,
            aggregateId: failure.id,
            errorClass: failure.errorClass,
            reason: failure.reason,
          },
          'bulk item rejected',
        );
      }
      throw new Error(
        `${String(result.failures.length)} outbox item(s) rejected by Elasticsearch and there ` +
          `is no DLQ yet (Phase 4). The rows stay unprocessed and are retried.`,
      );
    }

    await this.eventSink.publishBatch(rows.map(buildOutboxEvent));
    await commitOutboxProgress(
      this.database,
      rows.map((row) => row.id),
      lastId,
    );

    logger.debug(
      { pipeline: PIPELINE, batchSize: rows.length, lastProcessedId: lastId },
      'outbox batch replicated',
    );

    return rows.length;
  }

  async #waitBeforeNextPoll(): Promise<void> {
    try {
      await delay(config.OUTBOX_POLL_INTERVAL_MS, undefined, { signal: this.#abort.signal });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'AbortError') {
        throw error;
      }
    }
  }
}
