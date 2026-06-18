import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/db.module';
import { webhookEvents } from '../db/schema';
import { SourceName } from '../common/normalized-record';

/**
 * Webhook replay-dedup ledger (PLAN §6), keyed by (source, provider event id).
 * The unique index makes recordIfNew atomic: a replayed delivery loses the insert race
 * and is reported as a duplicate.
 */
@Injectable()
export class WebhookEventsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Returns true if this (source, eventId) is new; false if it was already seen. */
  async recordIfNew(source: SourceName, eventId: string, payload?: unknown): Promise<boolean> {
    const inserted = await this.db
      .insert(webhookEvents)
      .values({ source, eventId, payload: payload as object })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    return inserted.length > 0;
  }

  async markProcessed(source: SourceName, eventId: string): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(and(eq(webhookEvents.source, source), eq(webhookEvents.eventId, eventId)));
  }
}
