import type { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

import type pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

import { logger } from '../src/common/logger.js';
import { PRODUCT_CSV_COLUMNS, buildProductCsvRow } from './seed-product-generator.js';

interface CopyProductsRequest {
  readonly client: pg.Client;
  readonly total: number;
  readonly chunkSize: number;
}

function waitForDrainOrThrow(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

function throughputPerSecond(rows: number, startedAt: number): number {
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  return Math.round(rows / Math.max(elapsedSeconds, 0.001));
}

function buildChunk(fromIndex: number, toIndex: number): string {
  let chunk = '';
  for (let index = fromIndex; index < toIndex; index += 1) {
    chunk += buildProductCsvRow(index);
  }
  return chunk;
}

export async function copyProductsFromStdin(request: CopyProductsRequest): Promise<number> {
  const { client, total, chunkSize } = request;

  const stream = client.query(
    copyFrom(
      `COPY products (${PRODUCT_CSV_COLUMNS.join(', ')}) FROM STDIN WITH (FORMAT csv)`,
    ),
  );

  const startedAt = Date.now();
  const progressStep = Math.max(chunkSize, Math.floor(total / 10));
  let written = 0;
  let nextProgressAt = progressStep;

  while (written < total) {
    const upTo = Math.min(written + chunkSize, total);

    if (!stream.write(buildChunk(written, upTo))) {
      await waitForDrainOrThrow(stream);
    }
    written = upTo;

    if (written >= nextProgressAt) {
      logger.info(
        { written, total, rowsPerSecond: throughputPerSecond(written, startedAt) },
        'seed progress',
      );
      nextProgressAt = written + progressStep;
    }
  }

  stream.end();
  await finished(stream);

  return (Date.now() - startedAt) / 1000;
}
