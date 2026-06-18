import { Module } from '@nestjs/common';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { MetricsService } from './metrics.service';

@Module({
  imports: [OrchestratorModule],
  controllers: [AdminController],
  providers: [AdminGuard, MetricsService],
})
export class AdminModule {}
