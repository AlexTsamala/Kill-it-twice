import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { config } from '../../common/config.js';
import { DATABASE, type Database } from '../../common/database.js';
import { logger } from '../../common/logger.js';
import {
  EVENTS_FAILED,
  EVENTS_PROCESSED,
  EVENTS_RETRIED,
  MetricsRecorder,
} from '../../common/metrics.js';
import { type RetryOptions, waitAfterFailedRound } from '../../common/retry.js';
import { writeBatchWithRetry } from '../batch-writer.js';
import { advanceCheckpoint, readCheckpoint, setPipelineStatus } from '../checkpoint.js';
import { type DeadLetterEntry, deadLetterAndAdvanceCheckpoint } from '../dlq/dlq.repository.js';
import { buildSnapshotEvent } from '../product-event.factory.js';
import {
  type BulkItemFailure,
  type ProductDocument,
  indexOperation,
} from '../sinks/product-sink.js';
import { SINKS, type Sinks } from '../sinks/sinks.js';

const PIPELINE = 'backfill';
const PROGRESS_EVERY_ROWS = 200_000;
const RETRY_SAME_CURSOR = 'retry-same-cursor';

const productRowSchema = z.object({
  id: z.coerce.number().int().positive(),
  sku: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  price: z.coerce.number(),
  status: z.string(),
  version: z.number().int(),
  updated_at: z.date(),
});

interface BatchCounts {
  readonly applied: number;
  readonly versionConflicts: number;
}

function toProductDocument(row: unknown): ProductDocument {
  const parsed = productRowSchema.parse(row);
  return {
    id: parsed.id,
    sku: parsed.sku,
    name: parsed.name,
    description: parsed.description,
    price: parsed.price,
    status: parsed.status,
    version: parsed.version,
    updated_at: parsed.updated_at.toISOString(),
  };
}

function unknownDocument(id: number): ProductDocument {
  return {
    id,
    sku: `UNKNOWN-${String(id)}`,
    name: 'unknown',
    description: null,
    price: 0,
    status: 'unknown',
    version: 1,
    updated_at: new Date().toISOString(),
  };
}

function toDeadLetterEntry(
  failure: BulkItemFailure,
  documents: readonly ProductDocument[],
): DeadLetterEntry {
  return {
    sourceRef: failure.id,
    aggregateId: failure.id,
    eventType: 'product.snapshot',
    payload: documents[failure.position] ?? unknownDocument(failure.id),
    error: failure.reason,
    attempts: config.RETRY_MAX_ATTEMPTS,
  };
}

@Injectable()
export class BackfillWorker {
  #stopRequested = false;
  #consecutiveFailures = 0;
  readonly #abort = new AbortController();

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(SINKS) private readonly sinks: Sinks,
    private readonly metrics: MetricsRecorder,
  ) {}

  requestStop(): void {
    this.#stopRequested = true;
    this.#abort.abort();
  }

  async run(): Promise<void> {
    let cursor = await readCheckpoint(this.database, PIPELINE);
    await setPipelineStatus(this.database, PIPELINE, 'running');
    logger.info(
      { pipeline: PIPELINE, resumingFrom: cursor, publishEvents: config.BACKFILL_PUBLISH_EVENTS },
      'backfill started',
    );

    const startedAt = Date.now();
    let applied = 0;
    let versionConflicts = 0;
    let nextProgressAt = PROGRESS_EVERY_ROWS;

    while (!this.#stopRequested) {
      const documents = await this.#fetchNextBatch(cursor);
      const lastDocument = documents.at(-1);
      if (lastDocument === undefined) {
        break;
      }

      const counts = await this.#tryBatch(documents, cursor);
      if (counts === RETRY_SAME_CURSOR) {
        this.#consecutiveFailures += 1;
        continue;
      }
      this.#consecutiveFailures = 0;

      cursor = lastDocument.id;
      applied += counts.applied;
      versionConflicts += counts.versionConflicts;

      if (applied + versionConflicts >= nextProgressAt) {
        this.#logProgress({ cursor, applied, versionConflicts, startedAt });
        nextProgressAt = applied + versionConflicts + PROGRESS_EVERY_ROWS;
      }
    }

    const paused = this.#stopRequested;
    await setPipelineStatus(this.database, PIPELINE, paused ? 'paused' : 'completed');

    logger.info(
      {
        pipeline: PIPELINE,
        cursor,
        applied,
        versionConflicts,
        elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      },
      paused ? 'backfill paused for shutdown' : 'backfill complete',
    );
  }

  async #tryBatch(
    documents: readonly ProductDocument[],
    cursor: number,
  ): Promise<BatchCounts | typeof RETRY_SAME_CURSOR> {
    try {
      return await this.#processBatch(documents, cursor);
    } catch (error) {
      if (this.#stopRequested) {
        return RETRY_SAME_CURSOR;
      }

      logger.error(
        { pipeline: PIPELINE, cursor, err: error },
        'batch failed after retries; checkpoint held, will retry',
      );
      await this.#waitBeforeRetryRound();
      return RETRY_SAME_CURSOR;
    }
  }

  async #processBatch(documents: readonly ProductDocument[], cursor: number): Promise<BatchCounts> {
    const result = await writeBatchWithRetry(
      this.sinks.product,
      documents.map(indexOperation),
      this.#retryOptions(),
    );

    const advanceTo = documents.at(-1)?.id ?? cursor;
    const failedPositions = new Set(result.failures.map((failure) => failure.position));
    const survivors = documents.filter((_, position) => !failedPositions.has(position));

    if (config.BACKFILL_PUBLISH_EVENTS) {
      await this.sinks.event.publishBatch(survivors.map(buildSnapshotEvent));
    }

    const counts = {
      applied: result.appliedCount,
      versionConflicts: result.versionConflictCount,
    };

    this.#countApplied(result.appliedCount + result.versionConflictCount, survivors.length);

    if (result.failures.length === 0) {
      await advanceCheckpoint(this.database, PIPELINE, advanceTo);
      return counts;
    }

    for (const failure of result.failures) {
      this.metrics.increment(EVENTS_FAILED, {
        pipeline: PIPELINE,
        sink: 'elasticsearch',
        reason: failure.errorClass,
      });
    }

    await deadLetterAndAdvanceCheckpoint(this.database, {
      pipeline: PIPELINE,
      entries: result.failures.map((failure) => toDeadLetterEntry(failure, documents)),
      checkpointAt: cursor,
      advanceTo,
      processedOutboxIds: [],
    });

    logger.warn(
      { pipeline: PIPELINE, cursor, deadLettered: result.failures.length },
      'batch partially dead-lettered',
    );
    return counts;
  }

  #countApplied(indexed: number, published: number): void {
    this.metrics.increment(EVENTS_PROCESSED, { pipeline: PIPELINE, sink: 'elasticsearch' }, indexed);
    if (config.BACKFILL_PUBLISH_EVENTS) {
      this.metrics.increment(EVENTS_PROCESSED, { pipeline: PIPELINE, sink: 'rabbitmq' }, published);
    }
  }

  async #fetchNextBatch(afterId: number): Promise<ProductDocument[]> {
    const { rows } = await this.database.query<Record<string, unknown>>(
      `SELECT id, sku, name, description, price, status, version, updated_at
         FROM products
        WHERE id > $1 AND deleted_at IS NULL
        ORDER BY id
        LIMIT $2`,
      [afterId, config.BATCH_SIZE],
    );

    return rows.map(toProductDocument);
  }

  #retryOptions(): RetryOptions {
    return {
      pipeline: PIPELINE,
      signal: this.#abort.signal,
      random: Math.random,
      onRetry: () => {
        this.metrics.increment(EVENTS_RETRIED, { pipeline: PIPELINE, sink: 'elasticsearch' });
      },
    };
  }

  async #waitBeforeRetryRound(): Promise<void> {
    await waitAfterFailedRound(this.#consecutiveFailures, this.#retryOptions());
  }

  #logProgress(progress: {
    cursor: number;
    applied: number;
    versionConflicts: number;
    startedAt: number;
  }): void {
    const total = progress.applied + progress.versionConflicts;
    const elapsedSeconds = (Date.now() - progress.startedAt) / 1000;

    logger.info(
      {
        pipeline: PIPELINE,
        cursor: progress.cursor,
        applied: progress.applied,
        versionConflicts: progress.versionConflicts,
        rowsPerSecond: Math.round(total / Math.max(elapsedSeconds, 0.001)),
      },
      'backfill progress',
    );
  }
}
