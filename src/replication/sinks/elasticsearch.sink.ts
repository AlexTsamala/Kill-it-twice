import { Client } from '@elastic/elasticsearch';
import type { estypes } from '@elastic/elasticsearch';
import { Inject, Injectable } from '@nestjs/common';

import { config } from '../../common/config.js';
import { classifyResponseStatus } from '../../common/errors.js';
import type {
  BulkItemFailure,
  BulkWriteResult,
  ProductSink,
  SinkOperation,
} from './product-sink.js';

export const ELASTICSEARCH_CLIENT = Symbol('ElasticsearchClient');

const VERSION_CONFLICT = 'version_conflict_engine_exception';

const PRODUCTS_MAPPING = {
  dynamic: 'strict',
  properties: {
    id: { type: 'long' },
    sku: { type: 'keyword' },
    name: { type: 'text' },
    description: { type: 'text' },
    price: { type: 'scaled_float', scaling_factor: 100 },
    status: { type: 'keyword' },
    version: { type: 'integer' },
    updated_at: { type: 'date' },
  },
} as const;

export function createElasticsearchClient(): Client {
  return new Client({ node: config.ELASTICSEARCH_NODE });
}

export async function ensureProductsIndex(client: Client): Promise<void> {
  const exists = await client.indices.exists({ index: config.ELASTICSEARCH_INDEX });
  if (exists) {
    return;
  }

  await client.indices.create({
    index: config.ELASTICSEARCH_INDEX,
    mappings: PRODUCTS_MAPPING,
    aliases: { [config.ELASTICSEARCH_ALIAS]: {} },
  });
}

type BulkOperations = NonNullable<estypes.BulkRequest['operations']>;

function toBulkOperations(operations: readonly SinkOperation[]): BulkOperations {
  const bulk: BulkOperations = [];

  for (const operation of operations) {
    if (operation.kind === 'delete') {
      bulk.push({
        delete: {
          _index: config.ELASTICSEARCH_INDEX,
          _id: String(operation.id),
          version: operation.version,
          version_type: 'external',
        },
      });
      continue;
    }

    bulk.push({
      index: {
        _index: config.ELASTICSEARCH_INDEX,
        _id: String(operation.document.id),
        version: operation.document.version,
        version_type: 'external',
      },
    });
    bulk.push(operation.document);
  }

  return bulk;
}

function summariseBulkResponse(response: estypes.BulkResponse): BulkWriteResult {
  let appliedCount = 0;
  let versionConflictCount = 0;
  const failures: BulkItemFailure[] = [];

  for (const item of response.items) {
    const outcome = item.index ?? item.delete;
    if (outcome === undefined) {
      continue;
    }

    if (outcome.error === undefined) {
      appliedCount += 1;
      continue;
    }

    // D3: Elasticsearch already holds a newer version, so the write is redundant rather
    // than failed. Counting this as an error is the single most likely bug here.
    if (outcome.error.type === VERSION_CONFLICT) {
      versionConflictCount += 1;
      continue;
    }

    failures.push({
      id: Number(outcome._id),
      errorClass: classifyResponseStatus(outcome.status),
      reason: outcome.error.reason ?? outcome.error.type,
    });
  }

  return { appliedCount, versionConflictCount, failures };
}

@Injectable()
export class ElasticsearchProductSink implements ProductSink {
  constructor(@Inject(ELASTICSEARCH_CLIENT) private readonly client: Client) {}

  async writeBatch(operations: readonly SinkOperation[]): Promise<BulkWriteResult> {
    if (operations.length === 0) {
      return { appliedCount: 0, versionConflictCount: 0, failures: [] };
    }

    const response = await this.client.bulk({ operations: toBulkOperations(operations) });
    return summariseBulkResponse(response);
  }
}
