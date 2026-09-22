import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { DATABASE, type Database } from '../../common/database.js';
import { logger } from '../../common/logger.js';
import {
  EVENT_SINK,
  PRODUCT_EVENT_TYPES,
  type EventSink,
  type ProductEvent,
} from '../sinks/event-sink.js';
import {
  PRODUCT_SINK,
  type ProductSink,
  type SinkOperation,
  deleteOperation,
  indexOperation,
} from '../sinks/product-sink.js';
import {
  type DeadLetterRow,
  fetchDeadLetter,
  fetchReplayableDeadLetters,
  markDeadLetterReplayed,
} from './dlq.repository.js';

const PIPELINE = 'dlq-replay';
const REPLAY_ALL_LIMIT = 1000;

export type ReplayOutcome = 'replayed' | 'not-found' | 'already-replayed' | 'rejected';

const eventTypeSchema = z.enum(PRODUCT_EVENT_TYPES);

function toSinkOperation(row: DeadLetterRow): SinkOperation {
  if (row.event_type === 'product.deleted') {
    return deleteOperation(row.payload.id, row.payload.version);
  }

  return indexOperation(row.payload);
}

/**
 * SPEC §13.2: replay re-sends the payload stored at failure time, never a fresh read of the
 * source, so a DLQ row means the same thing whatever happened to the row it came from.
 */
function toProductEvent(row: DeadLetterRow): ProductEvent {
  const eventType = eventTypeSchema.parse(row.event_type);
  const prefix = row.pipeline === 'backfill' ? 'backfill' : 'outbox';

  return {
    eventId: `${prefix}-${String(row.source_ref)}`,
    eventType,
    aggregateId: row.aggregate_id,
    version: row.payload.version,
    occurredAt: row.payload.updated_at,
    data: {
      id: row.payload.id,
      sku: row.payload.sku,
      name: row.payload.name,
      price: row.payload.price,
      status: row.payload.status,
    },
  };
}

@Injectable()
export class DlqService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PRODUCT_SINK) private readonly productSink: ProductSink,
    @Inject(EVENT_SINK) private readonly eventSink: EventSink,
  ) {}

  async replay(id: number): Promise<ReplayOutcome> {
    const row = await fetchDeadLetter(this.database, id);

    if (row === undefined) {
      return 'not-found';
    }
    if (row.replayed_at !== null) {
      return 'already-replayed';
    }

    return this.#replayRow(row);
  }

  async replayAll(): Promise<{ replayed: number; rejected: number }> {
    const rows = await fetchReplayableDeadLetters(this.database, REPLAY_ALL_LIMIT);
    let replayed = 0;
    let rejected = 0;

    for (const row of rows) {
      const outcome = await this.#replayRow(row);
      if (outcome === 'replayed') {
        replayed += 1;
      } else {
        rejected += 1;
      }
    }

    return { replayed, rejected };
  }

  async #replayRow(row: DeadLetterRow): Promise<ReplayOutcome> {
    const result = await this.productSink.writeBatch([toSinkOperation(row)]);

    if (result.failures.length > 0) {
      logger.warn(
        {
          pipeline: PIPELINE,
          aggregateId: row.aggregate_id,
          reason: result.failures[0]?.reason,
        },
        'replay rejected again; row stays in the DLQ',
      );
      return 'rejected';
    }

    await this.eventSink.publishBatch([toProductEvent(row)]);
    await markDeadLetterReplayed(this.database, row.id);

    logger.info(
      { pipeline: PIPELINE, aggregateId: row.aggregate_id, dlqId: row.id },
      'dead letter replayed',
    );
    return 'replayed';
  }
}
