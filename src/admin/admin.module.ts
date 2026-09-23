import { Module } from '@nestjs/common';

import { CommonModule } from '../common/common.module.js';
import { ReplicationModule } from '../replication/replication.module.js';
import { SourceModule } from '../source/source.module.js';
import { DlqController } from './dlq.controller.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';
import { ReadinessService } from './readiness.service.js';
import { SimulationController } from './simulation.controller.js';
import { SimulationService } from './simulation.service.js';
import { StatusController } from './status.controller.js';
import { StatusService } from './status.service.js';

@Module({
  imports: [CommonModule, ReplicationModule, SourceModule],
  controllers: [StatusController, DlqController, SimulationController, MetricsController],
  providers: [StatusService, SimulationService, MetricsService, ReadinessService],
})
export class AdminModule {}
