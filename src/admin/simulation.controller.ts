import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { z } from 'zod';

import { DATABASE, type Database } from '../common/database.js';
import {
  SIMULATED_SINKS,
  countPendingPoison,
  injectPoisonRecords,
  readSinkStates,
  setSinkEnabled,
} from '../replication/simulation/simulation.repository.js';
import { parseBody } from './parse-body.js';
import { SimulationService } from './simulation.service.js';

const sinkToggleSchema = z.object({
  sink: z.enum(SIMULATED_SINKS),
  enabled: z.boolean(),
});

const poisonSchema = z.object({
  count: z.number().int().positive().max(500),
});

const mutationSchema = z.object({
  count: z.number().int().positive().max(100_000),
  ratePerSecond: z.number().positive().max(10_000),
});

@Controller('admin/simulate')
export class SimulationController {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly simulation: SimulationService,
  ) {}

  @Get()
  async state(): Promise<unknown> {
    const [sinks, pendingPoison] = await Promise.all([
      readSinkStates(this.database),
      countPendingPoison(this.database),
    ]);

    return { sinks, pendingPoison };
  }

  @Post('sink')
  async toggleSink(@Body() body: unknown): Promise<unknown> {
    const request = parseBody(sinkToggleSchema, body);
    await setSinkEnabled(this.database, request.sink, request.enabled);

    return { sink: request.sink, enabled: request.enabled };
  }

  @Post('poison')
  async injectPoison(@Body() body: unknown): Promise<unknown> {
    const request = parseBody(poisonSchema, body);
    const ids = await injectPoisonRecords(this.database, request.count);

    return { injected: ids.length, ids };
  }

  @Post('mutations')
  async generateMutations(@Body() body: unknown): Promise<unknown> {
    const request = parseBody(mutationSchema, body);

    return this.simulation.generateMutations(request);
  }
}
