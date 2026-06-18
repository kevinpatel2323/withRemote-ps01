import PgBoss from 'pg-boss';

async function waitFor(cond: () => boolean, timeoutMs = 15000, intervalMs = 150): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('timed out waiting for condition');
}

/**
 * Proves the Postgres-backed queue actually enqueues and processes jobs durably
 * (M3). Uses a unique queue per run to stay isolated from other suites.
 */
describe('pg-boss queue (integration)', () => {
  let boss: PgBoss;
  const queue = `test_${Date.now()}`;

  beforeAll(async () => {
    boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
    await boss.start();
    await boss.createQueue(queue);
  });

  afterAll(async () => {
    // Note: not deleting the queue — completed jobs hold FK references, and the
    // unique per-run queue name already isolates this suite. stop() is enough.
    await boss.stop({ graceful: true });
  });

  it('processes each enqueued job exactly once', async () => {
    const processed: number[] = [];
    await boss.work<{ n: number }>(queue, { batchSize: 1 }, async ([job]) => {
      processed.push(job.data.n);
    });

    await boss.send(queue, { n: 1 });
    await boss.send(queue, { n: 2 });
    await boss.send(queue, { n: 3 });

    await waitFor(() => processed.length === 3);
    expect(processed.sort()).toEqual([1, 2, 3]);
  });
});
