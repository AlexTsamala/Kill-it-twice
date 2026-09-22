import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AdminModule } from './admin/admin.module.js';
import { config } from './common/config.js';
import { logger } from './common/logger.js';
import { ConsumerModule } from './consumer/consumer.module.js';
import { ProductConsumer } from './consumer/product.consumer.js';
import { BackfillWorker } from './replication/backfill/backfill.worker.js';
import { IncrementalWorker } from './replication/incremental/incremental.worker.js';
import { ReplicationModule } from './replication/replication.module.js';

function onShutdownSignal(stop: () => void): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutdown requested; finishing in-flight work');
      stop();
    });
  }
}

async function runWorker(): Promise<void> {
  const context = await NestFactory.createApplicationContext(ReplicationModule, { logger: false });
  const backfill = context.get(BackfillWorker);
  const incremental = context.get(IncrementalWorker);

  onShutdownSignal(() => {
    backfill.requestStop();
    incremental.requestStop();
  });

  try {
    await Promise.all([backfill.run(), incremental.run()]);
  } finally {
    await context.close();
  }
}

async function runConsumer(): Promise<void> {
  const context = await NestFactory.createApplicationContext(ConsumerModule, { logger: false });
  await context.get(ProductConsumer).start();

  await new Promise<void>((resolve) => {
    onShutdownSignal(resolve);
  });

  await context.close();
}

async function runApi(): Promise<void> {
  const app = await NestFactory.create(AdminModule, { logger: false });
  app.enableShutdownHooks();
  await app.listen(config.HTTP_PORT);
  logger.info({ port: config.HTTP_PORT }, 'admin api listening');

  await new Promise<void>((resolve) => {
    onShutdownSignal(resolve);
  });

  await app.close();
}

async function runRole(): Promise<void> {
  if (config.APP_ROLE === 'worker') {
    await runWorker();
    return;
  }

  if (config.APP_ROLE === 'consumer') {
    await runConsumer();
    return;
  }

  await runApi();
}

async function main(): Promise<void> {
  logger.info('starting');
  await runRole();
}

try {
  await main();
} catch (error) {
  logger.error({ err: error }, 'process failed');
  process.exit(1);
}
