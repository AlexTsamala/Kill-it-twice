import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { z } from 'zod';

import { DATABASE, type Database } from '../common/database.js';
import {
  type RuntimeSettings,
  readRuntimeSettings,
  writeRuntimeSetting,
} from '../common/runtime-settings.js';
import { advanceCheckpoint, setPipelineStatus } from '../replication/checkpoint.js';
import { parseBody } from './parse-body.js';

const runtimeConfigSchema = z.object({
  batchSize: z.number().int().positive().max(10_000).optional(),
  outboxPollIntervalMs: z.number().int().positive().max(60_000).optional(),
  retryMaxAttempts: z.number().int().positive().max(20).optional(),
});

@Controller('admin/control')
export class ControlController {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  @Get('config')
  async readConfig(): Promise<RuntimeSettings> {
    return readRuntimeSettings(this.database);
  }

  @Post('config')
  async writeConfig(@Body() body: unknown): Promise<RuntimeSettings> {
    const request = parseBody(runtimeConfigSchema, body);

    if (request.batchSize !== undefined) {
      await writeRuntimeSetting(this.database, 'batch_size', String(request.batchSize));
    }
    if (request.outboxPollIntervalMs !== undefined) {
      await writeRuntimeSetting(
        this.database,
        'outbox_poll_interval_ms',
        String(request.outboxPollIntervalMs),
      );
    }
    if (request.retryMaxAttempts !== undefined) {
      await writeRuntimeSetting(
        this.database,
        'retry_max_attempts',
        String(request.retryMaxAttempts),
      );
    }

    return readRuntimeSettings(this.database);
  }

  @Post('backfill/pause')
  async pause(): Promise<{ backfillPaused: boolean }> {
    await writeRuntimeSetting(this.database, 'backfill_paused', 'true');
    return { backfillPaused: true };
  }

  @Post('backfill/resume')
  async resume(): Promise<{ backfillPaused: boolean }> {
    await writeRuntimeSetting(this.database, 'backfill_paused', 'false');
    return { backfillPaused: false };
  }

  /** Rewinds the cursor to zero. Safe to do at any time: D3's external versioning means a
   *  replayed document cannot overwrite a newer one. */
  @Post('backfill/reset')
  async reset(): Promise<{ pipeline: string; lastProcessedId: number }> {
    await advanceCheckpoint(this.database, 'backfill', 0);
    await setPipelineStatus(this.database, 'backfill', 'idle');
    return { pipeline: 'backfill', lastProcessedId: 0 };
  }
}
