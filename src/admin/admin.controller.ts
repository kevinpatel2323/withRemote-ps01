import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { MetricsService } from './metrics.service';
import { OrchestratorService } from '../orchestrator/orchestrator.service';

@Controller()
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly orchestrator: OrchestratorService,
  ) {}

  /** Observability surface (PLAN §9): ledger aggregates + reconciliation status. */
  @Get('admin/metrics')
  getMetrics() {
    return this.metrics.getMetrics();
  }

  /**
   * Manual trigger (PLAN §13). Runs every source inline with fault isolation and returns
   * the per-source results, so verification doesn't depend on the scheduled tick.
   */
  @Post('internal/sync')
  triggerSync(@Query('full') full?: string) {
    return this.orchestrator.runAllNow('manual', { forceFull: full === 'true' });
  }
}
