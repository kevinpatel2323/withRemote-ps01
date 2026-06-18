import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { syncRun } from '../db/schema';
import { MetricsService } from './metrics.service';

describe('MetricsService (integration)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let metrics: MetricsService;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });
    metrics = new MetricsService(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table sync_run restart identity cascade`);
  });

  it('aggregates totals and flags reconciliation violations', async () => {
    await db.insert(syncRun).values([
      // consistent: 3 == 2 + 0 + 1 + 0
      {
        source: 'stripe',
        mode: 'INCREMENTAL',
        trigger: 'scheduled',
        status: 'success',
        recordsSeen: 3,
        recordsInserted: 2,
        recordsDeduped: 1,
      },
      // violation: 5 != 1 (a success run whose counts don't add up => the pipeline "lied")
      {
        source: 'hubspot',
        mode: 'BACKFILL',
        trigger: 'manual',
        status: 'success',
        backfillTriggered: true,
        recordsSeen: 5,
        recordsInserted: 1,
      },
    ]);

    const m = await metrics.getMetrics();

    expect(m.totals.runs).toBe(2);
    expect(m.totals.seen).toBe(8);
    expect(m.totals.inserted).toBe(3);
    expect(m.totals.backfillsTriggered).toBe(1);

    expect(m.reconciliation.violations).toBe(1);
    expect(m.reconciliation.ok).toBe(false);
    expect(m.recentRuns).toHaveLength(2);
  });

  it('reports ok when every run reconciles', async () => {
    await db.insert(syncRun).values({
      source: 'google_calendar',
      mode: 'INCREMENTAL',
      trigger: 'webhook',
      status: 'success',
      recordsSeen: 4,
      recordsInserted: 2,
      recordsUpdated: 1,
      recordsDeduped: 1,
    });
    const m = await metrics.getMetrics();
    expect(m.reconciliation.ok).toBe(true);
    expect(m.reconciliation.violations).toBe(0);
  });
});
