import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { records } from '../db/schema';
import { RecordsRepository } from './records.repository';
import { NormalizedRecord } from '../common/normalized-record';

/**
 * Integration test (M1 DoD). Requires a migrated Postgres at DATABASE_URL.
 * Proves: insert-once + replay-dedup, update-on-newer, out-of-order guard,
 * and the reconciliation invariant seen == inserted + updated + deduped.
 */
describe('RecordsRepository (integration)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: RecordsRepository;

  const base: NormalizedRecord = {
    source: 'stripe',
    sourceObjectType: 'customer',
    sourceId: 'cus_1',
    canonicalType: 'party',
    externalUpdatedAt: new Date('2026-01-01T00:00:00Z'),
    email: 'a@example.com',
    name: 'Alice',
    raw: { id: 'cus_1' },
  };

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });
    repo = new RecordsRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table records restart identity cascade`);
  });

  it('inserts a new record once and dedupes an identical replay', async () => {
    expect(await repo.upsert(base)).toBe('inserted');
    expect(await repo.upsert(base)).toBe('deduped');
    const rows = await db.select().from(records);
    expect(rows).toHaveLength(1);
  });

  it('updates when a newer version arrives', async () => {
    await repo.upsert(base);
    const newer: NormalizedRecord = {
      ...base,
      externalUpdatedAt: new Date('2026-02-01T00:00:00Z'),
      name: 'Alice B',
    };
    expect(await repo.upsert(newer)).toBe('updated');
    const rows = await db.select().from(records);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Alice B');
  });

  it('ignores an out-of-order older update and keeps the newer stored version', async () => {
    const newer: NormalizedRecord = {
      ...base,
      externalUpdatedAt: new Date('2026-02-01T00:00:00Z'),
      name: 'Alice B',
    };
    await repo.upsert(newer);
    const older: NormalizedRecord = {
      ...base,
      externalUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      name: 'Alice OLD',
    };
    expect(await repo.upsert(older)).toBe('deduped');
    const rows = await db.select().from(records);
    expect(rows[0].name).toBe('Alice B');
  });

  it('upsertMany counts satisfy seen == inserted + updated + deduped', async () => {
    const r2: NormalizedRecord = { ...base, sourceId: 'cus_2', email: 'b@example.com' };

    const res1 = await repo.upsertMany([base, r2]);
    expect(res1).toMatchObject({ seen: 2, inserted: 2, updated: 0, deduped: 0 });
    expect(res1.seen).toBe(res1.inserted + res1.updated + res1.deduped);

    const r1Newer: NormalizedRecord = {
      ...base,
      externalUpdatedAt: new Date('2026-03-01T00:00:00Z'),
      name: 'A2',
    };
    // r1 changed (update); r2 re-sent unchanged (dedup).
    const res2 = await repo.upsertMany([r1Newer, r2]);
    expect(res2).toMatchObject({ seen: 2, inserted: 0, updated: 1, deduped: 1 });
    expect(res2.seen).toBe(res2.inserted + res2.updated + res2.deduped);
  });
});
