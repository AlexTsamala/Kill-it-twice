import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';

import { DATABASE, type Database, createDatabasePool } from './database.js';

@Module({
  providers: [{ provide: DATABASE, useFactory: createDatabasePool }],
  exports: [DATABASE],
})
export class CommonModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async onApplicationShutdown(): Promise<void> {
    await this.database.end();
  }
}
