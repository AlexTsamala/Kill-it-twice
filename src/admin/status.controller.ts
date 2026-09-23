import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { ReadinessService, type ReadinessReport } from './readiness.service.js';
import { StatusService, type PipelineStatusReport } from './status.service.js';

@Controller()
export class StatusController {
  constructor(
    private readonly status: StatusService,
    private readonly readiness: ReadinessService,
  ) {}

  /** Liveness only: it must answer before migrations have run, or `make up` blocks `make seed`. */
  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }

  /** Readiness, unlike liveness, fails when a dependency is down rather than reporting
   *  healthy while nothing can be written. */
  @Get('ready')
  async ready(): Promise<ReadinessReport> {
    const report = await this.readiness.report();

    if (!report.ready) {
      throw new ServiceUnavailableException(report);
    }

    return report;
  }

  @Get('admin/status')
  async report(): Promise<PipelineStatusReport & Pick<ReadinessReport, 'dependencies'>> {
    const [status, readiness] = await Promise.all([this.status.report(), this.readiness.report()]);

    return { ...status, dependencies: readiness.dependencies };
  }
}
