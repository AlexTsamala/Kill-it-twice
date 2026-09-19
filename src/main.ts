import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { config } from './common/config.js';
import { logger } from './common/logger.js';
import { BackfillWorker } from './replication/backfill/backfill.worker.js';
import { ReplicationModule } from './replication/replication.module.js';

async function runWorker(): Promise<void> {
  const context = await NestFactory.createApplicationContext(ReplicationModule, {
    logger: false,
  });

  const worker = context.get(BackfillWorker);

  // Signals set a flag rather than tearing down: the loop must finish its in-flight batch
  // and persist the checkpoint before Nest closes the pool (D5).
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutdown requested; finishing in-flight batch');
      worker.requestStop();
    });
  }

  try {
    await worker.run();
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  logger.info('starting');

  if (config.APP_ROLE === 'worker') {
    await runWorker();
    return;
  }

  throw new Error(`APP_ROLE '${config.APP_ROLE}' is not implemented yet`);
}

try {
  await main();
} catch (error) {
  logger.error({ err: error }, 'process failed');
  process.exit(1);
}
