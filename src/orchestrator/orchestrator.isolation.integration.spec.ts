import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { records } from '../db/schema';
import { RecordsRepository } from '../records/records.repository';
import { SyncStateRepository } from '../sync/sync-state.repository';
import { SyncRunRepository } from '../sync/sync-run.repository';
import { SyncRunner } from '../sync/sync-runner';
import { OrchestratorService } from './orchestrator.service';
import { NormalizedRecord, SourceName } from '../common/normalized-record';
import { RawBatch, SourceConnector, WebhookEvent } from '../connectors/connector.interface';

/** Fake connector: 'ok' yields one record; 'throw' simulates a source being down. */
class Fake implements SourceConnector {
  readonly stateKey = 'events';
  constructor(
    readonly source: SourceName,
    private readonly behavior: 'ok' | 'throw',
  ) {}
  isConfigured(): boolean {
    return true;
  }
  async *fetchFull(): AsyncIterable<RawBatch> {
    if (this.behavior === 'throw') throw new Error(`${this.source} is down`);
    yield { records: [{}], checkpoint: { type: 'c', value: 'cur' } };
  }
  async *fetchIncremental(): AsyncIterable<RawBatch> {
    yield* this.fetchFull();
  }
  normalize(): NormalizedRecord[] {
    return [
      {
        source: this.source,
        sourceObjectType: 'obj',
        sourceId: `${this.source}_1`,
        canonicalType: 'party',
        externalUpdatedAt: new Date('2026-01-01T00:00:00Z'),
        raw: {},
      },
    ];
  }
  parseWebhook(): WebhookEvent[] {
    return [];
  }
  isStaleCursorError(): boolean {
    return false;
  }
}

describe('OrchestratorService.runAllNow — fault isolation (M3 DoD)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let orch: OrchestratorService;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });
    const runner = new SyncRunner(
      new RecordsRepository(db),
      new SyncStateRepository(db),
      new SyncRunRepository(db),
    );
    const connectors = [
      new Fake('stripe', 'ok'),
      new Fake('google_calendar', 'ok'),
      new Fake('hubspot', 'throw'), // this source is "down"
    ];
    // pgboss is unused by runAllNow.
    orch = new OrchestratorService({} as any, connectors, runner);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate table records, sync_state, sync_run, quarantine restart identity cascade`,
    );
  });

  it('completes the healthy sources even when one source fails', async () => {
    const results = await orch.runAllNow('manual');

    const bySource = Object.fromEntries(results.map((r) => [r.source, r]));
    expect(bySource['stripe'].status).toBe('success');
    expect(bySource['google_calendar'].status).toBe('success');
    expect(bySource['hubspot'].status).toBe('failed');

    // The two healthy sources persisted their records; the failed one wrote nothing.
    const rows = await db.select().from(records);
    const sources = rows.map((r) => r.source).sort();
    expect(sources).toEqual(['google_calendar', 'stripe']);

    // The failed source still recorded a failed ledger row (audit trail, PLAN §9).
    const failedRuns = await db
      .select()
      .from(schema.syncRun)
      .where(eq(schema.syncRun.source, 'hubspot'));
    expect(failedRuns[0].status).toBe('failed');
  });
});
