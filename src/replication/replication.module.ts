import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Client } from '@elastic/elasticsearch';

import { CommonModule } from '../common/common.module.js';
import { BackfillWorker } from './backfill/backfill.worker.js';
import { DlqService } from './dlq/dlq.service.js';
import { IncrementalWorker } from './incremental/incremental.worker.js';
import { PoisonCleanupService } from './simulation/poison-cleanup.service.js';
import { SimulatedEventSink, SimulatedProductSink } from './simulation/simulated-sinks.js';
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
    ElasticsearchProductSink,
    RabbitmqEventSink,
    // The simulation decorators are the only bindings the workers see, so switching a sink
    // off from the admin API exercises the real retry path rather than a test-only branch.
    { provide: PRODUCT_SINK, useClass: SimulatedProductSink },
    { provide: EVENT_SINK, useClass: SimulatedEventSink },
    BackfillWorker,
    IncrementalWorker,
    DlqService,
    PoisonCleanupService,
  ],
  exports: [
    BackfillWorker,
    IncrementalWorker,
    DlqService,
    PoisonCleanupService,
    RABBITMQ_CONNECTION,
    ELASTICSEARCH_CLIENT,
  ],
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
