import { z } from 'zod';

import type { Database, DatabaseClient } from '../../common/database.js';
import type { PipelineName } from '../checkpoint.js';

const productFields = {
  id: z.coerce.number().int().positive(),
  sku: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  price: z.coerce.number(),
  status: z.string(),
  version: z.number().int(),
  updated_at: z.string(),
};

export const deadLetterPayloadSchema = z.object(productFields).loose();

export const correctedPayloadSchema = z.object(productFields);

export type DeadLetterPayload = z.infer<typeof correctedPayloadSchema>;

export const deadLetterRowSchema = z.object({
  id: z.coerce.number().int().positive(),
  pipeline: z.string(),
  source_ref: z.coerce.number().int(),
  aggregate_id: z.coerce.number().int(),
  event_type: z.string().nullable(),
  payload: deadLetterPayloadSchema,
  error: z.string(),
  attempts: z.number().int(),
  checkpoint_at: z.coerce.number().int(),
  first_failed_at: z.date(),
  last_failed_at: z.date(),
  replayed_at: z.date().nullable(),
});

export type DeadLetterRow = z.infer<typeof deadLetterRowSchema>;

export interface DeadLetterEntry {
  readonly sourceRef: number;
  readonly aggregateId: number;
  readonly eventType: string;
  readonly payload: DeadLetterPayload;
  readonly error: string;
  readonly attempts: number;
}

export interface DeadLetterBatch {
  readonly pipeline: PipelineName;
  readonly entries: readonly DeadLetterEntry[];
  readonly checkpointAt: number;
  readonly advanceTo: number;
  readonly processedOutboxIds: readonly number[];
}

async function insertDeadLetters(client: DatabaseClient, batch: DeadLetterBatch): Promise<void> {
  for (const entry of batch.entries) {
    await client.query(
      `INSERT INTO replication_dlq
         (pipeline, source_ref, aggregate_id, event_type, payload, error, attempts, checkpoint_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        batch.pipeline,
        entry.sourceRef,
        entry.aggregateId,
        entry.eventType,
        JSON.stringify(entry.payload),
        entry.error,
        entry.attempts,
        batch.checkpointAt,
      ],
    );
  }
}

export async function deadLetterAndAdvanceCheckpoint(
  db: Database,
  batch: DeadLetterBatch,
): Promise<void> {
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    await insertDeadLetters(client, batch);

    if (batch.processedOutboxIds.length > 0) {
      await client.query(
        'UPDATE replication_outbox SET processed_at = now() WHERE id = ANY($1::bigint[])',
        [batch.processedOutboxIds],
      );
    }

    await client.query(
      `UPDATE replication_checkpoint
          SET last_processed_id = $2, updated_at = now()
        WHERE pipeline = $1`,
      [batch.pipeline, batch.advanceTo],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listDeadLetters(db: Database, limit: number): Promise<DeadLetterRow[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT id, pipeline, source_ref, aggregate_id, event_type, payload, error, attempts,
            checkpoint_at, first_failed_at, last_failed_at, replayed_at
       FROM replication_dlq
      ORDER BY id
      LIMIT $1`,
    [limit],
  );

  return rows.map((row) => deadLetterRowSchema.parse(row));
}

export async function fetchReplayableDeadLetters(
  db: Database,
  limit: number,
): Promise<DeadLetterRow[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT id, pipeline, source_ref, aggregate_id, event_type, payload, error, attempts,
            checkpoint_at, first_failed_at, last_failed_at, replayed_at
       FROM replication_dlq
      WHERE replayed_at IS NULL
      ORDER BY id
      LIMIT $1`,
    [limit],
  );

  return rows.map((row) => deadLetterRowSchema.parse(row));
}

export async function fetchDeadLetter(
  db: Database,
  id: number,
): Promise<DeadLetterRow | undefined> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT id, pipeline, source_ref, aggregate_id, event_type, payload, error, attempts,
            checkpoint_at, first_failed_at, last_failed_at, replayed_at
       FROM replication_dlq
      WHERE id = $1`,
    [id],
  );

  const row = rows[0];
  return row === undefined ? undefined : deadLetterRowSchema.parse(row);
}

export async function markDeadLetterReplayed(db: Database, id: number): Promise<void> {
  await db.query('UPDATE replication_dlq SET replayed_at = now() WHERE id = $1', [id]);
}

export async function countUnreplayedDeadLetters(db: Database): Promise<number> {
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT count(*) AS count FROM replication_dlq WHERE replayed_at IS NULL',
  );

  return z.object({ count: z.coerce.number().int() }).parse(rows[0]).count;
}

export async function updateDeadLetterPayload(
  db: Database,
  id: number,
  payload: DeadLetterPayload,
): Promise<void> {
  await db.query('UPDATE replication_dlq SET payload = $2::jsonb WHERE id = $1', [
    id,
    JSON.stringify(payload),
  ]);
}
