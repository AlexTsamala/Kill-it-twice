import { z } from 'zod';

import type { Database } from '../common/database.js';
import { PRODUCT_EVENT_TYPES } from './sinks/event-sink.js';

export const outboxPayloadSchema = z.object({
  id: z.coerce.number().int().positive(),
  sku: z.string(),
  name: z.string(),
  price: z.coerce.number(),
  status: z.string(),
});

export const outboxRowSchema = z.object({
  id: z.coerce.number().int().positive(),
  aggregate_id: z.coerce.number().int().positive(),
  event_type: z.enum(PRODUCT_EVENT_TYPES),
  version: z.number().int(),
  occurred_at: z.date(),
  payload: outboxPayloadSchema,
});

export type OutboxRow = z.infer<typeof outboxRowSchema>;

export async function fetchUnprocessedOutboxRows(
  db: Database,
  limit: number,
): Promise<OutboxRow[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT id, aggregate_id, event_type, version, occurred_at, payload
       FROM replication_outbox
      WHERE processed_at IS NULL
      ORDER BY id
      LIMIT $1`,
    [limit],
  );

  return rows.map((row) => outboxRowSchema.parse(row));
}

/**
 * D5: marking the outbox rows processed and moving the checkpoint happen in one transaction,
 * so a crash between them cannot leave work that is neither done nor retryable.
 */
export async function commitOutboxProgress(
  db: Database,
  processedIds: readonly number[],
  lastProcessedId: number,
): Promise<void> {
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE replication_outbox SET processed_at = now() WHERE id = ANY($1::bigint[])',
      [processedIds],
    );
    await client.query(
      `UPDATE replication_checkpoint
          SET last_processed_id = $1, updated_at = now()
        WHERE pipeline = 'incremental'`,
      [lastProcessedId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
