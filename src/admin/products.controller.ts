import { Client } from '@elastic/elasticsearch';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';

import { config } from '../common/config.js';
import { ELASTICSEARCH_CLIENT } from '../replication/sinks/elasticsearch.sink.js';
import { parseBody } from './parse-body.js';

const DEFAULT_PAGE_SIZE = 20;
/** Elasticsearch refuses from+size beyond index.max_result_window (10,000 by default).
 *  Deep paging needs search_after, which this browser does not need. */
const MAX_RESULT_WINDOW = 10_000;

const querySchema = z.object({
  q: z.string().max(200).default(''),
  from: z.coerce.number().int().nonnegative().default(0),
  size: z.coerce.number().int().positive().max(100).default(DEFAULT_PAGE_SIZE),
});

export interface SearchResponse {
  readonly total: number;
  readonly reachable: number;
  readonly hits: readonly ProductHit[];
}

export interface ProductHit {
  readonly id: string;
  readonly version: number | undefined;
  readonly source: unknown;
}

@Controller('admin/products')
export class ProductsController {
  constructor(@Inject(ELASTICSEARCH_CLIENT) private readonly elasticsearch: Client) {}

  /** Reads the alias, not the index, so a future reindex is invisible here (SPEC §6). */
  @Get()
  async search(@Query() query: unknown): Promise<SearchResponse> {
    const request = parseBody(querySchema, query);
    const { q, size } = request;
    const from = Math.min(request.from, MAX_RESULT_WINDOW - size);

    const response = await this.elasticsearch.search({
      index: config.ELASTICSEARCH_ALIAS,
      from,
      size,
      version: true,
      track_total_hits: true,
      query:
        q === ''
          ? { match_all: {} }
          : { multi_match: { query: q, fields: ['name', 'sku', 'description'] } },
      sort: q === '' ? [{ id: 'asc' as const }] : undefined,
    });

    const total = response.hits.total;

    const matched = typeof total === 'number' ? total : (total?.value ?? 0);

    return {
      total: matched,
      reachable: Math.min(matched, MAX_RESULT_WINDOW),
      hits: response.hits.hits.map((hit) => ({
        id: hit._id ?? '',
        version: hit._version,
        source: hit._source,
      })),
    };
  }
}
