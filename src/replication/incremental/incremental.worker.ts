import { setTimeout as delay } from 'node:timers/promises';

import { Inject, Injectable } from '@nestjs/common';

import { config } from '../../common/config.js';
import { DATABASE, type Database } from '../../common/database.js';
import { logger } from '../../common/logger.js';
import { type RetryOptions, waitAfterFailedRound } from '../../common/retry.js';
import { writeBatchWithRetry } from '../batch-writer.js';
import { readCheckpoint, setPipelineStatus } from '../checkpoint.js';
import {
  type DeadLetterEntry,
  type DeadLetterPayload,
  deadLetterAndAdvanceCheckpoint,
  deadLetterPayloadSchema,
} from '../dlq/dlq.repository.js';
import { commitOutboxProgress, fetchUnprocessedOutboxRows, type OutboxRow } from '../outbox.js';
import { buildOutboxEvent } from '../product-event.factory.js';
import { claimPendingPoison, releasePoison } from '../simulation/simulation.repository.js';
import { EVENT_SINK, type EventSink } from '../sinks/event-sink.js';
import {
  PRODUCT_SINK,
  type BulkItemFailure,
  type ProductSink,
  type SinkOperation,
  deleteOperation,
  indexOperation,
  poisonDocumentBody,
  poisonOperation,
} from '../sinks/product-sink.js';

const PIPELINE = 'incremental';
const POISON_EVENT_TYPE = 'product.snapshot';

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

function outboxPayload(row: OutboxRow): DeadLetterPayload {
  return {
    id: row.payload.id,
    sku: row.payload.sku,
    name: row.payload.name,
    description: null,
    price: row.payload.price,
    status: row.payload.status,
    version: row.version,
    updated_at: row.occurred_at.toISOString(),
  };
}

function poisonPayload(documentId: number): DeadLetterPayload {
  return deadLetterPayloadSchema.parse(poisonDocumentBody(documentId));
}

function toDeadLetterEntry(failure: BulkItemFailure, rows: readonly OutboxRow[]): DeadLetterEntry {
  const row = rows[failure.position];

  if (row === undefined) {
    return {
      sourceRef: failure.id,
      aggregateId: failure.id,
      eventType: POISON_EVENT_TYPE,
      payload: poisonPayload(failure.id),
      error: failure.reason,
      attempts: config.RETRY_MAX_ATTEMPTS,
    };
  }

  return {
    sourceRef: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: outboxPayload(row),
    error: failure.reason,
    attempts: config.RETRY_MAX_ATTEMPTS,
  };
}

@Injectable()
export class IncrementalWorker {
  #stopRequested = false;
  #consecutiveFailures = 0;
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
      processed += await this.#pollOnce();
    }

    await setPipelineStatus(this.database, PIPELINE, 'paused');
    logger.info({ pipeline: PIPELINE, processed }, 'incremental worker stopped');
  }

  async #pollOnce(): Promise<number> {
    // Poison takes slots from the batch rather than adding to it, so G4's "3 rejections in a
    // 500-record batch" is literally a batch of 500 (D7).
    const poisonIds = await claimPendingPoison(this.database, config.BATCH_SIZE);
    const rows = await fetchUnprocessedOutboxRows(
      this.database,
      config.BATCH_SIZE - poisonIds.length,
    );

    if (rows.length === 0 && poisonIds.length === 0) {
      await this.#waitBeforeNextPoll();
      return 0;
    }

    try {
      const processed = await this.#processBatch(rows, poisonIds);
      this.#consecutiveFailures = 0;
      return processed;
    } catch (error) {
      await releasePoison(this.database, poisonIds);
      this.#reportBatchFailure(error);
      await waitAfterFailedRound(this.#consecutiveFailures, this.#retryOptions());
      this.#consecutiveFailures += 1;
      return 0;
    }
  }

  async #processBatch(rows: readonly OutboxRow[], poisonIds: readonly number[]): Promise<number> {
    const checkpointAt = await readCheckpoint(this.database, PIPELINE);
    const operations = [...rows.map(toSinkOperation), ...poisonIds.map(poisonOperation)];
    const result = await writeBatchWithRetry(this.productSink, operations, this.#retryOptions());
    const advanceTo = rows.at(-1)?.id ?? checkpointAt;

    if (result.failures.length === 0) {
      await this.eventSink.publishBatch(rows.map(buildOutboxEvent));
      await commitOutboxProgress(
        this.database,
        rows.map((row) => row.id),
        advanceTo,
      );
      return rows.length;
    }

    return this.#deadLetterBatch({ rows, failures: result.failures, checkpointAt, advanceTo });
  }

  async #deadLetterBatch(batch: {
    rows: readonly OutboxRow[];
    failures: readonly BulkItemFailure[];
    checkpointAt: number;
    advanceTo: number;
  }): Promise<number> {
    const failedPositions = new Set(batch.failures.map((failure) => failure.position));
    const survivors = batch.rows.filter((_, position) => !failedPositions.has(position));

    await this.eventSink.publishBatch(survivors.map(buildOutboxEvent));

    // D5: the failed items, the outbox rows they came from and the checkpoint move in one
    // transaction. 3 bad records must not roll back the 497 that Elasticsearch accepted.
    await deadLetterAndAdvanceCheckpoint(this.database, {
      pipeline: PIPELINE,
      entries: batch.failures.map((failure) => toDeadLetterEntry(failure, batch.rows)),
      checkpointAt: batch.checkpointAt,
      advanceTo: batch.advanceTo,
      processedOutboxIds: batch.rows.map((row) => row.id),
    });

    logger.warn(
      { pipeline: PIPELINE, deadLettered: batch.failures.length, applied: survivors.length },
      'batch partially dead-lettered',
    );
    return survivors.length;
  }

  #reportBatchFailure(error: unknown): void {
    if (this.#stopRequested) {
      return;
    }

    logger.error(
      { pipeline: PIPELINE, consecutiveFailures: this.#consecutiveFailures, err: error },
      'batch failed after retries; checkpoint held, will retry',
    );
  }

  #retryOptions(): RetryOptions {
    return { pipeline: PIPELINE, signal: this.#abort.signal, random: Math.random };
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
