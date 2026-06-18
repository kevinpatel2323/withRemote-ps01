import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/db.module';
import { records, quarantine } from '../db/schema';
import { NormalizedRecord, SourceName, toRecordRow } from '../common/normalized-record';

export type UpsertOutcome = 'inserted' | 'updated' | 'deduped';

export interface UpsertResult {
  seen: number;
  inserted: number;
  updated: number;
  /** Seen but not written: identical content (replay) or older/out-of-order. */
  deduped: number;
  /** Subset of writes that applied a soft-delete (informational, not part of the invariant). */
  deleted: number;
}

/**
 * Idempotent, version-guarded writes into the unified `records` table (PLAN §6).
 *
 * Natural key: (source, source_object_type, source_id). For each record we read the
 * current row in the same transaction, then:
 *   - no existing row            -> INSERT  (inserted)
 *   - incoming older             -> skip    (deduped)   [out-of-order guard]
 *   - incoming content identical -> skip    (deduped)   [no-op / replay]
 *   - otherwise                  -> UPDATE  (updated)
 *
 * Guarantees the reconciliation invariant for a batch: seen == inserted + updated + deduped.
 */
@Injectable()
export class RecordsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async upsert(record: NormalizedRecord): Promise<UpsertOutcome> {
    const row = toRecordRow(record);
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({
          id: records.id,
          externalUpdatedAt: records.externalUpdatedAt,
          contentHash: records.contentHash,
        })
        .from(records)
        .where(
          and(
            eq(records.source, row.source),
            eq(records.sourceObjectType, row.sourceObjectType),
            eq(records.sourceId, row.sourceId),
          ),
        )
        .limit(1);

      if (existing.length === 0) {
        // onConflictDoNothing guards a concurrent insert of the same key (rare; the
        // orchestrator serializes per-source so this is the webhook-vs-poll edge).
        await tx.insert(records).values(row).onConflictDoNothing();
        return 'inserted';
      }

      const current = existing[0];
      if (row.externalUpdatedAt < current.externalUpdatedAt) {
        return 'deduped'; // out-of-order: older than what we have
      }
      if (row.contentHash === current.contentHash) {
        return 'deduped'; // identical content (replay / overlapping window)
      }

      await tx
        .update(records)
        .set({
          canonicalType: row.canonicalType,
          externalCreatedAt: row.externalCreatedAt,
          externalUpdatedAt: row.externalUpdatedAt,
          title: row.title,
          name: row.name,
          email: row.email,
          amount: row.amount,
          currency: row.currency,
          status: row.status,
          startAt: row.startAt,
          endAt: row.endAt,
          description: row.description,
          url: row.url,
          attributes: row.attributes,
          raw: row.raw,
          contentHash: row.contentHash,
          deletedAt: row.deletedAt,
          lastSyncedAt: new Date(),
        })
        .where(eq(records.id, current.id));
      return 'updated';
    });
  }

  /** Park a record that failed validation/normalization (PLAN §8 "returns garbage"). */
  async quarantine(entry: {
    source: SourceName;
    sourceObjectType?: string | null;
    sourceId?: string | null;
    raw: unknown;
    error: string;
  }): Promise<void> {
    await this.db.insert(quarantine).values({
      source: entry.source,
      sourceObjectType: entry.sourceObjectType ?? null,
      sourceId: entry.sourceId ?? null,
      raw: entry.raw as object,
      error: entry.error,
    });
  }

  async upsertMany(batch: NormalizedRecord[]): Promise<UpsertResult> {
    const result: UpsertResult = {
      seen: batch.length,
      inserted: 0,
      updated: 0,
      deduped: 0,
      deleted: 0,
    };
    for (const record of batch) {
      const outcome = await this.upsert(record);
      result[outcome] += 1;
      if (outcome !== 'deduped' && record.deletedAt) {
        result.deleted += 1;
      }
    }
    return result;
  }
}
