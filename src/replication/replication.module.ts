import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Client } from '@elastic/elasticsearch';

import { CommonModule } from '../common/common.module.js';
import { BackfillWorker } from './backfill/backfill.worker.js';
import {
  ELASTICSEARCH_CLIENT,
  ElasticsearchProductSink,
  createElasticsearchClient,
} from './sinks/elasticsearch.sink.js';
import { PRODUCT_SINK } from './sinks/product-sink.js';

@Module({
  imports: [CommonModule],
  providers: [
    { provide: ELASTICSEARCH_CLIENT, useFactory: createElasticsearchClient },
    { provide: PRODUCT_SINK, useClass: ElasticsearchProductSink },
    BackfillWorker,
  ],
  exports: [BackfillWorker],
})
export class ReplicationModule implements OnApplicationShutdown {
  constructor(@Inject(ELASTICSEARCH_CLIENT) private readonly elasticsearch: Client) {}

  async onApplicationShutdown(): Promise<void> {
    await this.elasticsearch.close();
  }
}
