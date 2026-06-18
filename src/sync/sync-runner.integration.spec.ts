import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { records, syncRun } from '../db/schema';
import { RecordsRepository } from '../records/records.repository';
import { SyncStateRepository } from './sync-state.repository';
import { SyncRunRepository } from './sync-run.repository';
import { SyncRunner } from './sync-runner';
import { NormalizedRecord } from '../common/normalized-record';
import { Cursor, RawBatch, SourceConnector, WebhookEvent } from '../connectors/connector.interface';

type FakeRaw = { record?: NormalizedRecord; bad?: boolean };

/** Minimal connector that replays canned batches; one raw flagged `bad` to exercise quarantine. */
class FakeConnector implements SourceConnector<FakeRaw> {
  readonly source = 'stripe' as const;
  readonly stateKey = 'events';
  constructor(
    private readonly full: RawBatch<FakeRaw>[],
    private readonly incremental: RawBatch<FakeRaw>[] = [],
  ) {}
  isConfigured(): boolean {
    return true;
  }
  async *fetchFull(): AsyncIterable<RawBatch<FakeRaw>> {
    for (const b of this.full) yield b;
  }
  async *fetchIncremental(_cursor: Cursor | null): AsyncIterable<RawBatch<FakeRaw>> {
    for (const b of this.incremental) yield b;
  }
  normalize(raw: FakeRaw): NormalizedRecord[] {
    if (raw.bad) throw new Error('bad payload');
    return [raw.record!];
  }
  parseWebhook(): WebhookEvent[] {
    return [];
  }
  isStaleCursorError(): boolean {
    return false;
  }
}

function rec(id: string): NormalizedRecord {
  return {
    source: 'stripe',
    sourceObjectType: 'customer',
    sourceId: id,
    canonicalType: 'party',
    externalUpdatedAt: new Date('2026-01-01T00:00:00Z'),
    email: `${id}@example.com`,
    raw: { id },
  };
}

describe('SyncRunner (integration)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let runner: SyncRunner;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });
    runner = new SyncRunner(
      new RecordsRepository(db),
      new SyncStateRepository(db),
      new SyncRunRepository(db),
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate table records, sync_state, sync_run, quarantine restart identity cascade`,
    );
  });

  it('runs a full backfill, quarantines bad payloads, and writes a reconciled ledger row', async () => {
    const connector = new FakeConnector([
      {
        records: [{ record: rec('cus_1') }, { record: rec('cus_2') }, { bad: true }],
        checkpoint: { type: 'event_id', value: 'ev_1' },
      },
    ]);

    const result = await runner.run(connector, { trigger: 'manual' });

    expect(result.status).toBe('success');
    expect(result.mode).toBe('BACKFILL');
    expect(result).toMatchObject({ seen: 3, inserted: 2, deduped: 0, quarantined: 1 });
    expect(result.reconciled).toBe(true);
    expect(result.seen).toBe(
      result.inserted + result.updated + result.deduped + result.quarantined,
    );

    const rows = await db.select().from(records);
    expect(rows).toHaveLength(2);
    const q = await db.select().from(schema.quarantine);
    expect(q).toHaveLength(1);

    const [run] = await db.select().from(syncRun);
    expect(run).toMatchObject({
      status: 'success',
      recordsSeen: 3,
      recordsInserted: 2,
      recordsQuarantined: 1,
      cursorAfter: 'ev_1',
    });

    const state = await db
      .select()
      .from(schema.syncState)
      .where(eq(schema.syncState.source, 'stripe'));
    expect(state[0].cursorValue).toBe('ev_1');
    expect(state[0].mode).toBe('INCREMENTAL');
    expect(state[0].lastFullSyncAt).not.toBeNull();
  });

  it('dedupes an identical incremental re-run (idempotent writes)', async () => {
    // First: full backfill seeds the records + cursor.
    const connector = new FakeConnector(
      [
        {
          records: [{ record: rec('cus_1') }, { record: rec('cus_2') }],
          checkpoint: { type: 'event_id', value: 'ev_1' },
        },
      ],
      [
        {
          records: [{ record: rec('cus_1') }, { record: rec('cus_2') }],
          checkpoint: { type: 'event_id', value: 'ev_2' },
        },
      ],
    );

    const first = await runner.run(connector, { trigger: 'manual' });
    expect(first).toMatchObject({ mode: 'BACKFILL', inserted: 2 });

    // Second: incremental run replays identical records -> all deduped, no new rows.
    const second = await runner.run(connector, { trigger: 'scheduled' });
    expect(second).toMatchObject({ mode: 'INCREMENTAL', inserted: 0, updated: 0, deduped: 2 });
    expect(second.reconciled).toBe(true);

    const rows = await db.select().from(records);
    expect(rows).toHaveLength(2);
  });
});
