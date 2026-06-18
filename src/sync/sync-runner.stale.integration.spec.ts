import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { records } from '../db/schema';
import { RecordsRepository } from '../records/records.repository';
import { SyncStateRepository } from './sync-state.repository';
import { SyncRunRepository } from './sync-run.repository';
import { SyncRunner } from './sync-runner';
import { NormalizedRecord } from '../common/normalized-record';
import { RawBatch, SourceConnector, WebhookEvent } from '../connectors/connector.interface';
import { StaleCursorError } from '../connectors/stale-cursor.error';

/** Incremental always reports a stale cursor; full backfill returns a fresh cursor + data. */
class StaleConnector implements SourceConnector<{ id: string }> {
  readonly source = 'stripe' as const;
  readonly stateKey = 'events';
  isConfigured(): boolean {
    return true;
  }
  // eslint-disable-next-line require-yield
  async *fetchIncremental(): AsyncIterable<RawBatch<{ id: string }>> {
    throw new StaleCursorError('cursor expired (e.g. 410 / purged event)');
  }
  async *fetchFull(): AsyncIterable<RawBatch<{ id: string }>> {
    yield {
      records: [{ id: 'a' }, { id: 'b' }],
      checkpoint: { type: 'event_id', value: 'ev_fresh' },
    };
  }
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
    return [];
  }
  isStaleCursorError(err: unknown): boolean {
    return err instanceof StaleCursorError;
  }
}

describe('SyncRunner stale-cursor fallback (M4 DoD)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let runner: SyncRunner;
  let stateRepo: SyncStateRepository;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });
    stateRepo = new SyncStateRepository(db);
    runner = new SyncRunner(new RecordsRepository(db), stateRepo, new SyncRunRepository(db));
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate table records, sync_state, sync_run, quarantine restart identity cascade`,
    );
  });

  it('falls back to a full backfill on a stale cursor without losing data', async () => {
    // Seed an existing incremental cursor so the runner attempts incremental first.
    await stateRepo.getOrInit('stripe', 'events');
    await stateRepo.saveCursor(
      'stripe',
      'events',
      { type: 'event_id', value: 'ev_stale' },
      'INCREMENTAL',
    );

    const result = await runner.run(new StaleConnector(), { trigger: 'scheduled' });

    expect(result.backfillTriggered).toBe(true);
    expect(result.mode).toBe('BACKFILL');
    expect(result.status).toBe('success');
    expect(result.inserted).toBe(2);
    expect(result.cursorAfter).toBe('ev_fresh');

    // No data lost: the backfill loaded both records.
    const rows = await db.select().from(records);
    expect(rows).toHaveLength(2);

    // Ledger records the backfill trigger (PLAN §9).
    const [run] = await db.select().from(schema.syncRun);
    expect(run.backfillTriggered).toBe(true);

    // State advanced to the fresh cursor.
    const state = await db
      .select()
      .from(schema.syncState)
      .where(eq(schema.syncState.source, 'stripe'));
    expect(state[0].cursorValue).toBe('ev_fresh');
  });
});
