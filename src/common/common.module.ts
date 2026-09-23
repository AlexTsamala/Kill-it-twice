import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';

import { DATABASE, type Database, createDatabasePool } from './database.js';
import { MetricsRecorder } from './metrics.js';

@Module({
  providers: [{ provide: DATABASE, useFactory: createDatabasePool }, MetricsRecorder],
  exports: [DATABASE, MetricsRecorder],
})
export class CommonModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async onApplicationShutdown(): Promise<void> {
    await this.database.end();
  }
}
