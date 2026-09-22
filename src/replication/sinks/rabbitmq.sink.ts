import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import { Inject, Injectable } from '@nestjs/common';

import { config } from '../../common/config.js';
import { EVENT_SINK, type EventSink, type ProductEvent } from './event-sink.js';

export const RABBITMQ_CONNECTION = Symbol('RabbitmqConnection');

const ROUTING_PATTERN = 'product.#';

export interface RabbitmqConnection {
  readonly model: ChannelModel;
  readonly channel: ConfirmChannel;
}

export async function ensureRabbitmqTopology(channel: ConfirmChannel): Promise<void> {
  await channel.assertExchange(config.RABBITMQ_EXCHANGE, 'topic', { durable: true });

  await channel.assertQueue(config.RABBITMQ_QUEUE, { durable: true });
  await channel.bindQueue(config.RABBITMQ_QUEUE, config.RABBITMQ_EXCHANGE, ROUTING_PATTERN);
}

export async function createRabbitmqConnection(): Promise<RabbitmqConnection> {
  const model = await amqp.connect(config.RABBITMQ_URL);
  const channel = await model.createConfirmChannel();
  await ensureRabbitmqTopology(channel);
  return { model, channel };
}

function waitForDrainOrThrow(channel: ConfirmChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      channel.off('drain', onDrain);
      channel.off('error', onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    channel.once('drain', onDrain);
    channel.once('error', onError);
  });
}

@Injectable()
export class RabbitmqEventSink implements EventSink {
  constructor(@Inject(RABBITMQ_CONNECTION) private readonly connection: RabbitmqConnection) {}

  async publishBatch(events: readonly ProductEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const { channel } = this.connection;

    for (const event of events) {
      const accepted = channel.publish(
        config.RABBITMQ_EXCHANGE,
        event.eventType,
        Buffer.from(JSON.stringify(event)),
        { persistent: true, messageId: event.eventId, contentType: 'application/json' },
      );

      if (!accepted) {
        await waitForDrainOrThrow(channel);
      }
    }

    await channel.waitForConfirms();
  }
}

export const RABBITMQ_SINK_PROVIDERS = [
  { provide: RABBITMQ_CONNECTION, useFactory: createRabbitmqConnection },
  { provide: EVENT_SINK, useClass: RabbitmqEventSink },
];
