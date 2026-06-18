import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SyncModule } from '../sync/sync.module';
import { OrchestratorService } from './orchestrator.service';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [ScheduleModule.forRoot(), SyncModule],
  providers: [OrchestratorService, SchedulerService],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
