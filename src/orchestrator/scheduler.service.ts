import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { OrchestratorService } from './orchestrator.service';

/**
 * In-process scheduler (PLAN §3, user choice). The cron expression is read from
 * SYNC_CRON at load time. Note (PLAN §7): on Render free tier the web service sleeps
 * after ~15 min idle, so ticks are missed while asleep — but cursor-based incremental
 * self-heals, so a missed tick only delays data, never loses it.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly enabled: boolean;

  constructor(
    config: ConfigService,
    private readonly orchestrator: OrchestratorService,
  ) {
    this.enabled = config.get<boolean>('SYNC_SCHEDULER_ENABLED') ?? true;
  }

  @Cron(process.env.SYNC_CRON || '*/15 * * * *', { name: 'sync-tick' })
  async handleTick(): Promise<void> {
    if (!this.enabled) return;
    this.logger.log('Scheduled tick: dispatching per-source sync jobs');
    try {
      await this.orchestrator.dispatch('scheduled');
    } catch (err) {
      this.logger.error(`Scheduled dispatch failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
