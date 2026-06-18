import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SourceName } from '../common/normalized-record';
import { CONNECTORS, SourceConnector } from '../connectors/connector.interface';
import { PgBossService, SYNC_QUEUE } from '../queue/pgboss.service';
import { SyncRunner, SyncRunResult } from '../sync/sync-runner';

export type SyncTrigger = 'scheduled' | 'webhook' | 'manual';

interface SyncJobData {
  source: SourceName;
  trigger: SyncTrigger;
  forceFull?: boolean;
}

/**
 * Fans a sync tick out into one independent pg-boss job per source (PLAN §8 fault
 * isolation). Each job runs the connector via SyncRunner; a throw fails only that job
 * (retried, then dead-lettered) and never touches the other sources' jobs.
 */
@Injectable()
export class OrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly pgboss: PgBossService,
    @Inject(CONNECTORS) private readonly connectors: SourceConnector[],
    private readonly runner: SyncRunner,
  ) {}

  /** Register the worker. batchSize 1 keeps each source's job isolated. */
  async onModuleInit(): Promise<void> {
    await this.pgboss.boss.work<SyncJobData>(SYNC_QUEUE, { batchSize: 1 }, async ([job]) => {
      const { source, trigger, forceFull } = job.data;
      const connector = this.connectors.find((c) => c.source === source);
      if (!connector) throw new Error(`No connector registered for source "${source}"`);
      await this.runner.run(connector, { trigger, forceFull });
    });
  }

  /** Enqueue one job per source. singletonKey prevents overlapping runs for a source. */
  async dispatch(trigger: SyncTrigger, opts?: { forceFull?: boolean }): Promise<string[]> {
    const ids: string[] = [];
    for (const connector of this.connectors) {
      const id = await this.pgboss.boss.send(
        SYNC_QUEUE,
        { source: connector.source, trigger, forceFull: opts?.forceFull },
        { singletonKey: connector.source, retryLimit: 5, retryBackoff: true },
      );
      if (id) ids.push(id);
    }
    this.logger.log(`Dispatched ${ids.length} sync job(s) (trigger=${trigger})`);
    return ids;
  }

  /** Enqueue a single source (used by the webhook path, M7). */
  async dispatchSource(source: SourceName, trigger: SyncTrigger): Promise<string | null> {
    return this.pgboss.boss.send(
      SYNC_QUEUE,
      { source, trigger },
      { singletonKey: source, retryLimit: 5, retryBackoff: true },
    );
  }

  /**
   * Run every source inline, isolating failures (PLAN §8). One source throwing is
   * caught and reported; the others still complete. Used by the manual trigger and tests.
   */
  async runAllNow(trigger: SyncTrigger, opts?: { forceFull?: boolean }): Promise<SyncRunResult[]> {
    return Promise.all(
      this.connectors.map(async (connector) => {
        try {
          return await this.runner.run(connector, { trigger, forceFull: opts?.forceFull });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`${connector.source}: isolated failure — ${message}`);
          return {
            source: connector.source,
            status: 'failed' as const,
            mode: 'INCREMENTAL' as const,
            backfillTriggered: false,
            seen: 0,
            inserted: 0,
            updated: 0,
            deduped: 0,
            quarantined: 0,
            deleted: 0,
            pagesFetched: 0,
            cursorBefore: null,
            cursorAfter: null,
            reconciled: true,
            error: message,
          };
        }
      }),
    );
  }
}
