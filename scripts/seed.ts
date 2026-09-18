import pg from 'pg';
import { z } from 'zod';

import { config } from '../src/common/config.js';
import { logger } from '../src/common/logger.js';
import { copyProductsFromStdin } from './seed-copy-stream.js';

const { Client } = pg;
type Client = pg.Client;

const countRowSchema = z.object({ count: z.coerce.number().int().nonnegative() });

async function resetReplicatedState(client: Client): Promise<void> {
  await client.query(
    `TRUNCATE products, replication_outbox, replication_dlq, processed_events,
              product_projection
     RESTART IDENTITY CASCADE`,
  );
  await client.query(
    `UPDATE replication_checkpoint
        SET last_processed_id = 0, status = 'idle', updated_at = now()`,
  );
}

async function assertSeededRowCount(client: Client, expected: number): Promise<void> {
  const { rows } = await client.query<Record<string, unknown>>(
    'SELECT count(*) AS count FROM products',
  );
  const { count } = countRowSchema.parse(rows[0]);

  if (count !== expected) {
    throw new Error(`Expected ${expected} products after seeding, found ${count}`);
  }
}

async function seed(): Promise<void> {
  const total = config.SEED_TOTAL;
  const chunkSize = config.SEED_BATCH_SIZE;

  const client = new Client({ connectionString: config.DATABASE_URL });
  await client.connect();

  try {
    logger.info('resetting replicated state');
    await resetReplicatedState(client);

    logger.info({ total, chunkSize }, 'seeding products');
    const elapsedSeconds = await copyProductsFromStdin({ client, total, chunkSize });

    await assertSeededRowCount(client, total);

    logger.info(
      {
        seeded: total,
        elapsedSeconds: Number(elapsedSeconds.toFixed(1)),
        rowsPerSecond: Math.round(total / Math.max(elapsedSeconds, 0.001)),
      },
      'seed complete',
    );
  } finally {
    await client.end();
  }
}

try {
  await seed();
} catch (error) {
  logger.error({ err: error }, 'seed failed');
  process.exit(1);
}
