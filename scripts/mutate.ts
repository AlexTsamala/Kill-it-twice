import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { logger } from '../src/common/logger.js';
import { SourceModule } from '../src/source/source.module.js';
import { ProductsRepository } from '../src/source/products.repository.js';

async function mutate(): Promise<void> {
  const context = await NestFactory.createApplicationContext(SourceModule, { logger: false });
  const products = context.get(ProductsRepository);

  try {
    const created = await products.create({
      sku: `SKU-MUTATE-${String(Date.now())}`,
      name: 'Mutation Probe',
      description: 'created by scripts/mutate.ts',
      price: 9.99,
      status: 'active',
    });
    logger.info({ aggregateId: created.id, version: created.version }, 'product created');

    const updated = await products.update(created.id, { name: 'Mutation Probe Renamed' });
    logger.info({ aggregateId: created.id, version: updated?.version }, 'product updated');

    const second = await products.create({
      sku: `SKU-MUTATE-${String(Date.now())}-b`,
      name: 'Mutation Probe To Delete',
      description: 'created then soft-deleted',
      price: 1.5,
      status: 'active',
    });
    const deleted = await products.softDelete(second.id);
    logger.info({ aggregateId: second.id, version: deleted?.version }, 'product soft-deleted');
  } finally {
    await context.close();
  }
}

try {
  await mutate();
} catch (error) {
  logger.error({ err: error }, 'mutate failed');
  process.exit(1);
}
