import { Inject, Injectable } from '@nestjs/common';
import { count, desc, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/db.module';
import { syncRun } from '../db/schema';

/**
 * Reads the sync_run ledger to prove the pipeline doesn't lie (PLAN §9). The headline
 * number is reconciliation violations: successful runs where
 * seen != inserted + updated + deduped + quarantined. That count must stay 0.
 */
@Injectable()
export class MetricsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async getMetrics() {
    const recent = await this.db.select().from(syncRun).orderBy(desc(syncRun.startedAt)).limit(20);

    const [totals] = await this.db
      .select({
        runs: count(),
        seen: sql<number>`coalesce(sum(records_seen),0)::int`,
        inserted: sql<number>`coalesce(sum(records_inserted),0)::int`,
        updated: sql<number>`coalesce(sum(records_updated),0)::int`,
        deduped: sql<number>`coalesce(sum(records_deduped),0)::int`,
        quarantined: sql<number>`coalesce(sum(records_quarantined),0)::int`,
        deleted: sql<number>`coalesce(sum(records_deleted),0)::int`,
        backfills: sql<number>`coalesce(sum(case when backfill_triggered then 1 else 0 end),0)::int`,
      })
      .from(syncRun);

    const [violationsRow] = await this.db
      .select({ n: count() })
      .from(syncRun)
      .where(
        sql`status = 'success' and records_seen <> records_inserted + records_updated + records_deduped + records_quarantined`,
      );
    const violations = Number(violationsRow?.n ?? 0);

    return {
      generatedAt: new Date().toISOString(),
      reconciliation: {
        ok: violations === 0,
        violations,
        invariant: 'seen == inserted + updated + deduped + quarantined',
      },
      totals: {
        runs: Number(totals?.runs ?? 0),
        seen: Number(totals?.seen ?? 0),
        inserted: Number(totals?.inserted ?? 0),
        updated: Number(totals?.updated ?? 0),
        deduped: Number(totals?.deduped ?? 0),
        quarantined: Number(totals?.quarantined ?? 0),
        deleted: Number(totals?.deleted ?? 0),
        backfillsTriggered: Number(totals?.backfills ?? 0),
      },
      recentRuns: recent.map((r) => ({
        id: r.id,
        source: r.source,
        objectType: r.objectType,
        mode: r.mode,
        trigger: r.trigger,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        backfillTriggered: r.backfillTriggered,
        seen: r.recordsSeen,
        inserted: r.recordsInserted,
        updated: r.recordsUpdated,
        deduped: r.recordsDeduped,
        quarantined: r.recordsQuarantined,
        deleted: r.recordsDeleted,
        cursorBefore: r.cursorBefore,
        cursorAfter: r.cursorAfter,
        error: r.error,
      })),
    };
  }
}
