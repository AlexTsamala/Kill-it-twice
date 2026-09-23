import { Client } from '@elastic/elasticsearch';
import { Inject, Injectable } from '@nestjs/common';

import { config } from '../common/config.js';
import { DATABASE, type Database } from '../common/database.js';
import { ELASTICSEARCH_CLIENT } from '../replication/sinks/elasticsearch.sink.js';
import {
  RABBITMQ_CONNECTION,
  type RabbitmqConnection,
} from '../replication/sinks/rabbitmq.sink.js';

export interface ReadinessReport {
  readonly ready: boolean;
  readonly dependencies: Readonly<Record<string, boolean>>;
}

@Injectable()
export class ReadinessService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(ELASTICSEARCH_CLIENT) private readonly elasticsearch: Client,
    @Inject(RABBITMQ_CONNECTION) private readonly rabbitmq: RabbitmqConnection,
  ) {}

  async report(): Promise<ReadinessReport> {
    const [postgres, elasticsearch, rabbitmq] = await Promise.all([
      reachable(() => this.database.query('SELECT 1')),
      reachable(() => this.elasticsearch.ping()),
      reachable(() => this.rabbitmq.channel.checkQueue(config.RABBITMQ_QUEUE)),
    ]);

    return {
      ready: postgres && elasticsearch && rabbitmq,
      dependencies: { postgres, elasticsearch, rabbitmq },
    };
  }
}

async function reachable(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch {
    return false;
  }
}
