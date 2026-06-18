import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { records, webhookEvents } from '../db/schema';
import { RecordsRepository } from '../records/records.repository';
import { WebhookEventsRepository } from './webhook-events.repository';
import { WebhookService } from './webhook.service';
import { NormalizedRecord } from '../common/normalized-record';
import { SourceConnector, WebhookEvent, WebhookRequest } from '../connectors/connector.interface';

const REQ: WebhookRequest = { headers: {}, rawBody: Buffer.from('{}') };

/** Stripe-like connector whose webhook carries an inline object to upsert. */
class InlineConnector implements SourceConnector<{ id: string }> {
  readonly source = 'stripe' as const;
  readonly stateKey = 'events';
  isConfigured() {
    return true;
  }
  async *fetchFull() {}
  async *fetchIncremental() {}
  normalize(raw: { id: string }): NormalizedRecord[] {
    return [
      {
        source: 'stripe',
        sourceObjectType: 'customer',
        sourceId: raw.id,
        canonicalType: 'party',
        externalUpdatedAt: new Date('2026-01-01T00:00:00Z'),
        raw,
      },
    ];
  }
  parseWebhook(): WebhookEvent[] {
    return [
      { eventId: 'evt_1', objectType: 'customer', objectId: 'cus_1', inlineRaw: { id: 'cus_1' } },
    ];
  }
  isStaleCursorError() {
    return false;
  }
}

/** Google-like connector whose webhook only triggers a sync (no inline data). */
class TriggerConnector extends InlineConnector {
  parseWebhook(): WebhookEvent[] {
    return [{ eventId: 'goog_1', objectType: 'event', objectId: '' }];
  }
}

describe('WebhookService (integration) — replay dedup (M7 DoD)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let records_: RecordsRepository;
  let ledger: WebhookEventsRepository;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });
    records_ = new RecordsRepository(db);
    ledger = new WebhookEventsRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate table records, webhook_events, quarantine restart identity cascade`,
    );
  });

  it('processes a webhook once and dedupes the replay (1 row, deduped=1)', async () => {
    const dispatchSource = jest.fn();
    const service = new WebhookService([new InlineConnector()], records_, ledger, {
      dispatchSource,
    } as any);

    const first = await service.handle('stripe', REQ);
    expect(first).toEqual({ received: 1, deduped: 0, processed: 1 });

    const second = await service.handle('stripe', REQ); // identical replay
    expect(second).toEqual({ received: 1, deduped: 1, processed: 0 });

    expect(await db.select().from(records)).toHaveLength(1);
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
    expect(dispatchSource).not.toHaveBeenCalled();
  });

  it('enqueues an incremental sync when the webhook has no inline payload', async () => {
    const dispatchSource = jest.fn().mockResolvedValue('job-id');
    const service = new WebhookService([new TriggerConnector()], records_, ledger, {
      dispatchSource,
    } as any);

    await service.handle('stripe', REQ);
    expect(dispatchSource).toHaveBeenCalledWith('stripe', 'webhook');

    // Replay: deduped, no second dispatch.
    const replay = await service.handle('stripe', REQ);
    expect(replay.deduped).toBe(1);
    expect(dispatchSource).toHaveBeenCalledTimes(1);
  });
});
