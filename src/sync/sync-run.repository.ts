import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/db.module';
import { syncRun } from '../db/schema';
import { SourceName } from '../common/normalized-record';

export interface RunCounts {
  seen: number;
  inserted: number;
  updated: number;
  deduped: number;
  quarantined: number;
  deleted: number;
  pagesFetched: number;
}

export interface StartRunParams {
  source: SourceName;
  objectType: string;
  mode: 'INCREMENTAL' | 'BACKFILL';
  trigger: 'scheduled' | 'webhook' | 'manual';
  cursorBefore: string | null;
}

export interface FinishRunParams extends RunCounts {
  status: 'success' | 'failed' | 'partial';
  cursorAfter: string | null;
  backfillTriggered: boolean;
  error?: string | null;
}

/** Writes the audit ledger that proves the pipeline doesn't lie (PLAN §9). */
@Injectable()
export class SyncRunRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async start(params: StartRunParams): Promise<string> {
    const [row] = await this.db
      .insert(syncRun)
      .values({
        source: params.source,
        objectType: params.objectType,
        mode: params.mode,
        trigger: params.trigger,
        status: 'running',
        cursorBefore: params.cursorBefore,
      })
      .returning({ id: syncRun.id });
    return row.id;
  }

  async finish(runId: string, params: FinishRunParams): Promise<void> {
    await this.db
      .update(syncRun)
      .set({
        status: params.status,
        finishedAt: new Date(),
        cursorAfter: params.cursorAfter,
        backfillTriggered: params.backfillTriggered,
        recordsSeen: params.seen,
        recordsInserted: params.inserted,
        recordsUpdated: params.updated,
        recordsDeduped: params.deduped,
        recordsQuarantined: params.quarantined,
        recordsDeleted: params.deleted,
        pagesFetched: params.pagesFetched,
        error: params.error ?? null,
      })
      .where(eq(syncRun.id, runId));
  }
}
