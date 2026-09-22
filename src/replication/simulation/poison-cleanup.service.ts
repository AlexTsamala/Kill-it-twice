import { Client } from '@elastic/elasticsearch';
import { Inject, Injectable } from '@nestjs/common';

import { config } from '../../common/config.js';
import { DATABASE, type Database } from '../../common/database.js';
import { logger } from '../../common/logger.js';
import { ELASTICSEARCH_CLIENT } from '../sinks/elasticsearch.sink.js';
import { POISON_ID_BASE } from '../sinks/product-sink.js';
import { deletePoisonArtifacts, type PoisonRowsRemoved } from './simulation.repository.js';

const PIPELINE = 'simulation';

export interface PoisonCleanupSummary extends PoisonRowsRemoved {
  readonly indexed: number;
}

@Injectable()
export class PoisonCleanupService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(ELASTICSEARCH_CLIENT) private readonly elasticsearch: Client,
  ) {}

  async removeAll(): Promise<PoisonCleanupSummary> {
    const indexed = await this.#removeFromIndex();
    const rows = await deletePoisonArtifacts(this.database, POISON_ID_BASE);

    logger.info({ pipeline: PIPELINE, indexed, ...rows }, 'poison artifacts removed');
    return { indexed, ...rows };
  }

  async #removeFromIndex(): Promise<number> {
    const response = await this.elasticsearch.deleteByQuery({
      index: config.ELASTICSEARCH_INDEX,
      refresh: true,
      query: { range: { id: { gte: POISON_ID_BASE } } },
    });

    return response.deleted ?? 0;
  }
}
