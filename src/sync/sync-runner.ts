import { Injectable, Logger } from '@nestjs/common';
import { NormalizedRecord } from '../common/normalized-record';
import { RawBatch, SourceConnector } from '../connectors/connector.interface';
import { RecordsRepository } from '../records/records.repository';
import { SyncStateRepository } from './sync-state.repository';
import { SyncRunRepository } from './sync-run.repository';

export interface SyncRunResult {
  source: string;
  status: 'success' | 'failed' | 'skipped';
  mode: 'INCREMENTAL' | 'BACKFILL';
  backfillTriggered: boolean;
  seen: number;
  inserted: number;
  updated: number;
  deduped: number;
  quarantined: number;
  deleted: number;
  pagesFetched: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
  /** seen == inserted + updated + deduped + quarantined (PLAN §9). */
  reconciled: boolean;
  error?: string;
}

interface Counts {
  seen: number;
  inserted: number;
  updated: number;
  deduped: number;
  quarantined: number;
  deleted: number;
  pagesFetched: number;
}

const zero = (): Counts => ({
  seen: 0,
  inserted: 0,
  updated: 0,
  deduped: 0,
  quarantined: 0,
  deleted: 0,
  pagesFetched: 0,
});

/**
 * Drives a single connector run end-to-end (PLAN §5/§7/§9). The orchestration boundary:
 * read cursor -> incremental (or full) -> normalize+quarantine -> upsert -> checkpoint
 * per page -> on stale cursor, fall back to a full backfill -> write the run ledger.
 *
 * Stateless and connector-agnostic; M3 wraps it with pg-boss jobs + per-source isolation.
 */
@Injectable()
export class SyncRunner {
  private readonly logger = new Logger(SyncRunner.name);

  constructor(
    private readonly records: RecordsRepository,
    private readonly stateRepo: SyncStateRepository,
    private readonly runRepo: SyncRunRepository,
  ) {}

  async run(
    connector: SourceConnector,
    opts: { trigger: 'scheduled' | 'webhook' | 'manual'; forceFull?: boolean },
  ): Promise<SyncRunResult> {
    const { source, stateKey } = connector;

    if (!connector.isConfigured()) {
      this.logger.warn(`Skipping ${source}: not configured`);
      return this.skipped(source);
    }

    const state = await this.stateRepo.getOrInit(source, stateKey);
    let mode: 'INCREMENTAL' | 'BACKFILL' =
      opts.forceFull || state.mode === 'NEEDS_BACKFILL' || !state.cursorValue
        ? 'BACKFILL'
        : 'INCREMENTAL';
    const cursorBefore = state.cursorValue ?? null;

    const runId = await this.runRepo.start({
      source,
      objectType: stateKey,
      mode,
      trigger: opts.trigger,
      cursorBefore,
    });

    let counts = zero();
    let backfillTriggered = false;
    let cursorAfter = cursorBefore;

    try {
      try {
        const iterator =
          mode === 'BACKFILL'
            ? connector.fetchFull()
            : connector.fetchIncremental(this.stateRepo.cursorOf(state));
        cursorAfter = await this.drain(connector, iterator, counts);
      } catch (err) {
        // Stale cursor on an incremental run => fall back to a full backfill (PLAN §7).
        if (mode === 'INCREMENTAL' && connector.isStaleCursorError(err)) {
          this.logger.warn(`${source}: stale cursor, falling back to backfill — ${String(err)}`);
          backfillTriggered = true;
          mode = 'BACKFILL';
          counts = zero(); // backfill reprocesses from scratch (upsert dedups)
          await this.stateRepo.setMode(source, stateKey, 'BACKFILL');
          cursorAfter = await this.drain(connector, connector.fetchFull(), counts);
        } else {
          throw err;
        }
      }

      await this.stateRepo.saveCursor(
        source,
        stateKey,
        cursorAfter ? { type: 'cursor', value: cursorAfter } : null,
        'INCREMENTAL',
        { full: mode === 'BACKFILL' },
      );

      const reconciled =
        counts.seen === counts.inserted + counts.updated + counts.deduped + counts.quarantined;
      if (!reconciled) {
        this.logger.error(`${source}: reconciliation mismatch ${JSON.stringify(counts)}`);
      }

      await this.runRepo.finish(runId, {
        status: 'success',
        cursorAfter,
        backfillTriggered,
        ...counts,
      });

      return {
        source,
        status: 'success',
        mode,
        backfillTriggered,
        cursorBefore,
        cursorAfter,
        reconciled,
        ...counts,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`${source}: run failed — ${message}`);
      // Do not advance the cursor on failure (PLAN §7).
      await this.runRepo.finish(runId, {
        status: 'failed',
        cursorAfter: cursorBefore,
        backfillTriggered,
        error: message,
        ...counts,
      });
      throw err; // surface to the job queue for retry/DLQ (M3)
    }
  }

  /** Consume an async batch iterator, returning the last committed cursor value. */
  private async drain(
    connector: SourceConnector,
    iterator: AsyncIterable<RawBatch>,
    counts: Counts,
  ): Promise<string | null> {
    let lastCursor: string | null = null;
    for await (const batch of iterator) {
      counts.pagesFetched += 1;
      const normalized: NormalizedRecord[] = [];

      for (const raw of batch.records) {
        try {
          const recs = connector.normalize(raw);
          counts.seen += recs.length;
          normalized.push(...recs);
        } catch (err) {
          counts.seen += 1;
          counts.quarantined += 1;
          await this.records.quarantine({
            source: connector.source,
            raw,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (normalized.length > 0) {
        const res = await this.records.upsertMany(normalized);
        counts.inserted += res.inserted;
        counts.updated += res.updated;
        counts.deduped += res.deduped;
        counts.deleted += res.deleted;
      }

      // Per-page checkpoint: durable progress so a crash resumes here (PLAN §7).
      if (batch.checkpoint) {
        lastCursor = batch.checkpoint.value;
        await this.stateRepo.saveCursor(
          connector.source,
          connector.stateKey,
          batch.checkpoint,
          'INCREMENTAL',
        );
      }
    }
    return lastCursor;
  }

  private skipped(source: string): SyncRunResult {
    return {
      source,
      status: 'skipped',
      mode: 'INCREMENTAL',
      backfillTriggered: false,
      seen: 0,
      inserted: 0,
      updated: 0,
      deduped: 0,
      quarantined: 0,
      deleted: 0,
      pagesFetched: 0,
      cursorBefore: null,
      cursorAfter: null,
      reconciled: true,
    };
  }
}
