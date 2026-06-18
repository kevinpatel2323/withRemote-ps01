import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/db.module';
import { syncState, SyncStateRow } from '../db/schema';
import { SourceName } from '../common/normalized-record';
import { Cursor } from '../connectors/connector.interface';

type SyncMode = 'INCREMENTAL' | 'BACKFILL' | 'NEEDS_BACKFILL';

/** Cursor + mode persistence per (source, object_type) — PLAN §7. */
@Injectable()
export class SyncStateRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async getOrInit(source: SourceName, objectType: string): Promise<SyncStateRow> {
    const found = await this.find(source, objectType);
    if (found) return found;
    await this.db
      .insert(syncState)
      .values({ source, objectType, mode: 'NEEDS_BACKFILL' })
      .onConflictDoNothing();
    // Re-read (handles a concurrent initializer).
    return (await this.find(source, objectType))!;
  }

  cursorOf(state: SyncStateRow): Cursor | null {
    if (!state.cursorValue) return null;
    return { type: state.cursorType ?? 'cursor', value: state.cursorValue };
  }

  async saveCursor(
    source: SourceName,
    objectType: string,
    cursor: Cursor | null,
    mode: SyncMode,
    opts?: { full?: boolean },
  ): Promise<void> {
    await this.db
      .update(syncState)
      .set({
        cursorValue: cursor?.value ?? null,
        cursorType: cursor?.type ?? null,
        mode,
        updatedAt: new Date(),
        ...(opts?.full ? { lastFullSyncAt: new Date() } : { lastIncrementalAt: new Date() }),
      })
      .where(and(eq(syncState.source, source), eq(syncState.objectType, objectType)));
  }

  async setMode(source: SourceName, objectType: string, mode: SyncMode): Promise<void> {
    await this.db
      .update(syncState)
      .set({ mode, updatedAt: new Date() })
      .where(and(eq(syncState.source, source), eq(syncState.objectType, objectType)));
  }

  private async find(source: SourceName, objectType: string): Promise<SyncStateRow | null> {
    const rows = await this.db
      .select()
      .from(syncState)
      .where(and(eq(syncState.source, source), eq(syncState.objectType, objectType)))
      .limit(1);
    return rows[0] ?? null;
  }
}
