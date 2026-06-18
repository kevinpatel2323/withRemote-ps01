import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import PgBoss from 'pg-boss';

export const SYNC_QUEUE = 'sync';
export const SYNC_DLQ = 'sync-dlq';

/**
 * Postgres-backed job queue (PLAN §3). Durable retries + dead-letter without Redis,
 * which fits the Render free tier (its free Redis has eviction + no persistence).
 * pg-boss owns its own `pgboss` schema in the same database.
 */
@Injectable()
export class PgBossService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PgBossService.name);
  readonly boss: PgBoss;

  constructor(config: ConfigService) {
    this.boss = new PgBoss({ connectionString: config.getOrThrow<string>('DATABASE_URL') });
    this.boss.on('error', (err) => this.logger.error(`pg-boss error: ${err.message}`));
  }

  async onModuleInit(): Promise<void> {
    await this.boss.start();
    await this.boss.createQueue(SYNC_DLQ);
    // Failed jobs that exhaust retries land in the dead-letter queue (PLAN §8).
    await this.boss.createQueue(SYNC_QUEUE, {
      name: SYNC_QUEUE,
      retryLimit: 5,
      retryBackoff: true,
      deadLetter: SYNC_DLQ,
    });
    this.logger.log('pg-boss started; queues ready');
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss.stop({ graceful: true });
  }
}
