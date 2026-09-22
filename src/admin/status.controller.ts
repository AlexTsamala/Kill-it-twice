import { Controller, Get } from '@nestjs/common';

import { StatusService, type PipelineStatusReport } from './status.service.js';

@Controller()
export class StatusController {
  constructor(private readonly status: StatusService) {}

  /** Liveness only: it must answer before migrations have run, or `make up` blocks `make seed`. */
  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }

  @Get('admin/status')
  async report(): Promise<PipelineStatusReport> {
    return this.status.report();
  }
}
