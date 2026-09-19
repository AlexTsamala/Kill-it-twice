import { z } from 'zod';

import type { Database } from '../common/database.js';

export type PipelineName = 'backfill' | 'incremental';
export type PipelineStatus = 'idle' | 'running' | 'paused' | 'completed';

const checkpointRowSchema = z.object({
  last_processed_id: z.coerce.number().int().nonnegative(),
});

export async function readCheckpoint(db: Database, pipeline: PipelineName): Promise<number> {
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT last_processed_id FROM replication_checkpoint WHERE pipeline = $1',
    [pipeline],
  );

  const row = rows[0];
  if (row === undefined) {
    throw new Error(`No checkpoint row for pipeline '${pipeline}' — migrations may not have run`);
  }

  return checkpointRowSchema.parse(row).last_processed_id;
}

export async function advanceCheckpoint(
  db: Database,
  pipeline: PipelineName,
  lastProcessedId: number,
): Promise<void> {
  await db.query(
    `UPDATE replication_checkpoint
        SET last_processed_id = $2, updated_at = now()
      WHERE pipeline = $1`,
    [pipeline, lastProcessedId],
  );
}

export async function setPipelineStatus(
  db: Database,
  pipeline: PipelineName,
  status: PipelineStatus,
): Promise<void> {
  await db.query(
    `UPDATE replication_checkpoint
        SET status = $2, updated_at = now()
      WHERE pipeline = $1`,
    [pipeline, status],
  );
}
