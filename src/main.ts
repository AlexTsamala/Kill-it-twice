import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AdminModule } from './admin/admin.module.js';
import { config } from './common/config.js';
import { logger } from './common/logger.js';
import { ConsumerModule } from './consumer/consumer.module.js';
import { ProductConsumer } from './consumer/product.consumer.js';
import { BackfillWorker } from './replication/backfill/backfill.worker.js';
import { IncrementalWorker } from './replication/incremental/incremental.worker.js';
import { ReplicationModule } from './replication/replication.module.js';

/** The built UI ships inside the image; an unbuilt checkout simply has no assets to serve,
 *  which must not stop the api from starting. */
function serveUi(app: NestExpressApplication): void {
  const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
  if (!existsSync(assets)) {
    logger.warn({ assets }, 'ui assets not found; serving the api only');
    return;
  }

  app.useStaticAssets(assets);
}

/** Node exits on an unhandled rejection, which is right — the state is unknown. Logging it
 *  through pino first is what makes it diagnosable instead of a bare stack trace. */
function reportUnhandledRejections(): void {
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({ err: reason }, 'unhandled rejection; exiting');
    process.exit(1);
  });
}

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
  const app = await NestFactory.create<NestExpressApplication>(AdminModule, { logger: false });
  app.enableShutdownHooks();
  serveUi(app);
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
  reportUnhandledRejections();
  logger.info('starting');
  await runRole();
}

try {
  await main();
} catch (error) {
  logger.error({ err: error }, 'process failed');
  process.exit(1);
}
