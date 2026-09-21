import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Client } from '@elastic/elasticsearch';

import { CommonModule } from '../common/common.module.js';
import { BackfillWorker } from './backfill/backfill.worker.js';
import { IncrementalWorker } from './incremental/incremental.worker.js';
import {
  ELASTICSEARCH_CLIENT,
  ElasticsearchProductSink,
  createElasticsearchClient,
} from './sinks/elasticsearch.sink.js';
import { EVENT_SINK } from './sinks/event-sink.js';
import { PRODUCT_SINK } from './sinks/product-sink.js';
import {
  RABBITMQ_CONNECTION,
  RabbitmqEventSink,
  type RabbitmqConnection,
  createRabbitmqConnection,
} from './sinks/rabbitmq.sink.js';

@Module({
  imports: [CommonModule],
  providers: [
    { provide: ELASTICSEARCH_CLIENT, useFactory: createElasticsearchClient },
    { provide: RABBITMQ_CONNECTION, useFactory: createRabbitmqConnection },
    { provide: PRODUCT_SINK, useClass: ElasticsearchProductSink },
    { provide: EVENT_SINK, useClass: RabbitmqEventSink },
    BackfillWorker,
    IncrementalWorker,
  ],
  exports: [BackfillWorker, IncrementalWorker, RABBITMQ_CONNECTION],
})
export class ReplicationModule implements OnApplicationShutdown {
  constructor(
    @Inject(ELASTICSEARCH_CLIENT) private readonly elasticsearch: Client,
    @Inject(RABBITMQ_CONNECTION) private readonly rabbitmq: RabbitmqConnection,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.elasticsearch.close();
    await this.rabbitmq.model.close();
  }
}
