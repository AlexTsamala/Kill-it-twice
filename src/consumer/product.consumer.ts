import { Inject, Injectable } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';

import { config } from '../common/config.js';
import { DATABASE, type Database } from '../common/database.js';
import { classifyThrownError } from '../common/errors.js';
import { logger } from '../common/logger.js';
import { EVENTS_FAILED, EVENTS_PROCESSED, MetricsRecorder } from '../common/metrics.js';
import { productEventSchema } from '../replication/sinks/event-sink.js';
import {
  RABBITMQ_CONNECTION,
  type RabbitmqConnection,
} from '../replication/sinks/rabbitmq.sink.js';
import { AggregateSerializer } from './aggregate-serializer.js';
import { applyProductEvent } from './product-projection.repository.js';

const PIPELINE = 'consumer';
const PROGRESS_EVERY_MESSAGES = 200_000;

@Injectable()
export class ProductConsumer {
  #applied = 0;
  #duplicates = 0;
  #superseded = 0;
  #nextProgressAt = PROGRESS_EVERY_MESSAGES;
  readonly #serializer = new AggregateSerializer();

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(RABBITMQ_CONNECTION) private readonly connection: RabbitmqConnection,
    private readonly metrics: MetricsRecorder,
  ) {}

  async start(): Promise<void> {
    const { channel } = this.connection;

    await channel.prefetch(config.RABBITMQ_PREFETCH);
    await channel.consume(
      config.RABBITMQ_QUEUE,
      (message) => {
        if (message === null) {
          return;
        }

        const aggregateId = this.#readAggregateId(message);
        if (aggregateId === undefined) {
          logger.error({ pipeline: PIPELINE }, 'unparseable message dropped');
          this.connection.channel.nack(message, false, false);
          return;
        }

        this.#serializer.run(aggregateId, () => this.#handleMessage(message));
      },
      { noAck: false },
    );

    logger.info(
      { pipeline: PIPELINE, queue: config.RABBITMQ_QUEUE, prefetch: config.RABBITMQ_PREFETCH },
      'consumer listening',
    );
  }

  #readAggregateId(message: ConsumeMessage): number | undefined {
    const parsed = productEventSchema.safeParse(JSON.parse(message.content.toString('utf8')));
    return parsed.success ? parsed.data.aggregateId : undefined;
  }

  async #handleMessage(message: ConsumeMessage): Promise<void> {
    const { channel } = this.connection;

    try {
      const event = productEventSchema.parse(JSON.parse(message.content.toString('utf8')));
      const outcome = await applyProductEvent(this.database, event);

      this.#record(outcome);
      this.metrics.increment(EVENTS_PROCESSED, { pipeline: PIPELINE, sink: 'projection' });
      channel.ack(message);
    } catch (error) {
      const errorClass = classifyThrownError(error);
      this.metrics.increment(EVENTS_FAILED, {
        pipeline: PIPELINE,
        sink: 'projection',
        reason: errorClass,
      });
      logger.error(
        { pipeline: PIPELINE, errorClass, messageId: message.properties.messageId, err: error },
        'projection failed',
      );
      channel.nack(message, false, errorClass === 'transient');
    }
  }

  #record(outcome: 'applied' | 'duplicate' | 'superseded'): void {
    if (outcome === 'applied') {
      this.#applied += 1;
    } else if (outcome === 'duplicate') {
      this.#duplicates += 1;
    } else {
      this.#superseded += 1;
    }

    const total = this.#applied + this.#duplicates + this.#superseded;
    if (total < this.#nextProgressAt) {
      return;
    }

    logger.info(
      {
        pipeline: PIPELINE,
        applied: this.#applied,
        duplicates: this.#duplicates,
        superseded: this.#superseded,
      },
      'consumer progress',
    );
    this.#nextProgressAt = total + PROGRESS_EVERY_MESSAGES;
  }
}
