import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';

import { CommonModule } from '../common/common.module.js';
import {
  RABBITMQ_CONNECTION,
  RabbitmqEventSink,
  type RabbitmqConnection,
  createRabbitmqConnection,
} from '../replication/sinks/rabbitmq.sink.js';
import { EVENT_SINK } from '../replication/sinks/event-sink.js';
import { ProductConsumer } from './product.consumer.js';

@Module({
  imports: [CommonModule],
  providers: [
    { provide: RABBITMQ_CONNECTION, useFactory: createRabbitmqConnection },
    { provide: EVENT_SINK, useClass: RabbitmqEventSink },
    ProductConsumer,
  ],
  exports: [ProductConsumer],
})
export class ConsumerModule implements OnApplicationShutdown {
  constructor(@Inject(RABBITMQ_CONNECTION) private readonly rabbitmq: RabbitmqConnection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.rabbitmq.model.close();
  }
}
