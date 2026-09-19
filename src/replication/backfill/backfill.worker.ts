import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { config } from '../../common/config.js';
import { DATABASE, type Database } from '../../common/database.js';
import { logger } from '../../common/logger.js';
import { advanceCheckpoint, readCheckpoint, setPipelineStatus } from '../checkpoint.js';
import {
  PRODUCT_SINK,
  type BulkItemFailure,
  type ProductDocument,
  type ProductSink,
} from '../sinks/product-sink.js';

const PIPELINE = 'backfill';
const PROGRESS_EVERY_ROWS = 200_000;

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

function rejectBatchOnFailure(failures: readonly BulkItemFailure[]): void {
  if (failures.length === 0) {
    return;
  }

  for (const failure of failures) {
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
    `${String(failures.length)} item(s) rejected by Elasticsearch and there is no DLQ yet ` +
      `(Phase 4). The checkpoint has not advanced, so the batch is retried on restart.`,
  );
}

@Injectable()
export class BackfillWorker {
  #stopRequested = false;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PRODUCT_SINK) private readonly sink: ProductSink,
  ) {}

  requestStop(): void {
    this.#stopRequested = true;
  }

  async run(): Promise<void> {
    let cursor = await readCheckpoint(this.database, PIPELINE);
    await setPipelineStatus(this.database, PIPELINE, 'running');
    logger.info({ pipeline: PIPELINE, resumingFrom: cursor }, 'backfill started');

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

      const result = await this.sink.writeBatch(documents);
      rejectBatchOnFailure(result.failures);

      cursor = lastDocument.id;
      await advanceCheckpoint(this.database, PIPELINE, cursor);

      applied += result.appliedCount;
      versionConflicts += result.versionConflictCount;

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
