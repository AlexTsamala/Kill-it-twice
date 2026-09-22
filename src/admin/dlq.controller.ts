import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';

import { DATABASE, type Database } from '../common/database.js';
import {
  correctedPayloadSchema,
  listDeadLetters,
  updateDeadLetterPayload,
} from '../replication/dlq/dlq.repository.js';
import { DlqService } from '../replication/dlq/dlq.service.js';
import { parseBody } from './parse-body.js';

const DEFAULT_LIMIT = 100;

const idSchema = z.coerce.number().int().positive();
const limitSchema = z.coerce.number().int().positive().max(1000).default(DEFAULT_LIMIT);

@Controller('admin/dlq')
export class DlqController {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly dlq: DlqService,
  ) {}

  @Get()
  async list(@Query('limit') limit: unknown): Promise<unknown> {
    const rows = await listDeadLetters(this.database, parseBody(limitSchema, limit ?? undefined));

    return { rows, count: rows.length };
  }

  @Patch(':id/payload')
  async correctPayload(@Param('id') id: unknown, @Body() body: unknown): Promise<unknown> {
    const deadLetterId = parseBody(idSchema, id);
    const payload = parseBody(correctedPayloadSchema, body);
    await updateDeadLetterPayload(this.database, deadLetterId, payload);

    return { id: deadLetterId, payload };
  }

  @Post(':id/replay')
  async replay(@Param('id') id: unknown): Promise<unknown> {
    const deadLetterId = parseBody(idSchema, id);
    const outcome = await this.dlq.replay(deadLetterId);

    if (outcome === 'not-found') {
      throw new NotFoundException(`No dead letter with id ${String(deadLetterId)}`);
    }

    return { id: deadLetterId, outcome };
  }

  @Post('replay-all')
  async replayAll(): Promise<unknown> {
    return this.dlq.replayAll();
  }
}
