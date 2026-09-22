import { z } from 'zod';

import type { Database, DatabaseClient } from '../../common/database.js';

export const SIMULATED_SINKS = ['elasticsearch', 'rabbitmq'] as const;
export type SimulatedSink = (typeof SIMULATED_SINKS)[number];

const enabledRowSchema = z.object({ enabled: z.boolean() });
const idRowSchema = z.object({ id: z.coerce.number().int().positive() });

export async function isSinkEnabled(db: Database, sink: SimulatedSink): Promise<boolean> {
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT enabled FROM simulation_sink_state WHERE sink = $1',
    [sink],
  );

  const row = rows[0];
  return row === undefined ? true : enabledRowSchema.parse(row).enabled;
}

export async function readSinkStates(db: Database): Promise<Record<SimulatedSink, boolean>> {
  const states = await Promise.all(SIMULATED_SINKS.map((sink) => isSinkEnabled(db, sink)));

  return { elasticsearch: states[0] ?? true, rabbitmq: states[1] ?? true };
}

export async function setSinkEnabled(
  db: Database,
  sink: SimulatedSink,
  enabled: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO simulation_sink_state (sink, enabled)
     VALUES ($1, $2)
     ON CONFLICT (sink) DO UPDATE SET enabled = excluded.enabled, updated_at = now()`,
    [sink, enabled],
  );
}

export async function injectPoisonRecords(db: Database, count: number): Promise<number[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `INSERT INTO simulation_poison (id)
     SELECT nextval('simulation_poison_id_seq') FROM generate_series(1, $1)
     RETURNING id`,
    [count],
  );

  return rows.map((row) => idRowSchema.parse(row).id);
}

export async function claimPendingPoison(db: Database, limit: number): Promise<number[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `UPDATE simulation_poison
        SET consumed_at = now()
      WHERE id IN (
        SELECT id FROM simulation_poison
         WHERE consumed_at IS NULL
         ORDER BY id
         LIMIT $1
      )
     RETURNING id`,
    [limit],
  );

  return rows.map((row) => idRowSchema.parse(row).id);
}

export async function releasePoison(db: Database, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  await db.query('UPDATE simulation_poison SET consumed_at = NULL WHERE id = ANY($1::bigint[])', [
    ids,
  ]);
}

export interface PoisonRowsRemoved {
  readonly projection: number;
  readonly processedEvents: number;
  readonly deadLetters: number;
  readonly pending: number;
}

/**
 * Replaying a corrected poison record indexes a document that has no source row, so
 * `source == es == projection` stays broken until the simulation undoes itself.
 */
export async function deletePoisonArtifacts(
  db: Database,
  idFloor: number,
): Promise<PoisonRowsRemoved> {
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    const projection = await client.query('DELETE FROM product_projection WHERE id >= $1', [
      idFloor,
    ]);
    const processed = await client.query(
      'DELETE FROM processed_events WHERE event_id = ANY($1::text[])',
      [await poisonEventIds(client, idFloor)],
    );
    const dlq = await client.query('DELETE FROM replication_dlq WHERE source_ref >= $1', [idFloor]);
    const pending = await client.query('DELETE FROM simulation_poison');
    await client.query('COMMIT');

    return {
      projection: projection.rowCount ?? 0,
      processedEvents: processed.rowCount ?? 0,
      deadLetters: dlq.rowCount ?? 0,
      pending: pending.rowCount ?? 0,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function poisonEventIds(client: DatabaseClient, idFloor: number): Promise<string[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT 'outbox-' || source_ref AS id FROM replication_dlq WHERE source_ref >= $1`,
    [idFloor],
  );

  return rows.map((row) => z.object({ id: z.string() }).parse(row).id);
}

export async function countPendingPoison(db: Database): Promise<number> {
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT count(*) AS id FROM simulation_poison WHERE consumed_at IS NULL',
  );

  return z.object({ id: z.coerce.number().int() }).parse(rows[0]).id;
}
