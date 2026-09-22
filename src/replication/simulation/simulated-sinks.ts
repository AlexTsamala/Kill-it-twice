import { Inject, Injectable } from '@nestjs/common';

import { DATABASE, type Database } from '../../common/database.js';
import { SinkDisabledError } from '../../common/errors.js';
import { ElasticsearchProductSink } from '../sinks/elasticsearch.sink.js';
import type { EventSink, ProductEvent } from '../sinks/event-sink.js';
import type { BulkWriteResult, ProductSink, SinkOperation } from '../sinks/product-sink.js';
import { RabbitmqEventSink } from '../sinks/rabbitmq.sink.js';
import { isSinkEnabled } from './simulation.repository.js';

@Injectable()
export class SimulatedProductSink implements ProductSink {
  constructor(
    private readonly inner: ElasticsearchProductSink,
    @Inject(DATABASE) private readonly database: Database,
  ) {}

  async writeBatch(operations: readonly SinkOperation[]): Promise<BulkWriteResult> {
    if (!(await isSinkEnabled(this.database, 'elasticsearch'))) {
      throw new SinkDisabledError('elasticsearch');
    }

    return this.inner.writeBatch(operations);
  }
}

@Injectable()
export class SimulatedEventSink implements EventSink {
  constructor(
    private readonly inner: RabbitmqEventSink,
    @Inject(DATABASE) private readonly database: Database,
  ) {}

  async publishBatch(events: readonly ProductEvent[]): Promise<void> {
    if (!(await isSinkEnabled(this.database, 'rabbitmq'))) {
      throw new SinkDisabledError('rabbitmq');
    }

    await this.inner.publishBatch(events);
  }
}
