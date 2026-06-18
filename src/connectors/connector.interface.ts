import { NormalizedRecord, SourceName } from '../common/normalized-record';

/** Opaque resume position. `type` records the flavor (event_id, sync_token, lastmodified). */
export interface Cursor {
  type: string;
  value: string;
}

/**
 * A page of raw source objects plus the cursor to persist *after* these are durably
 * upserted. Per-page checkpoints make a run crash-resumable (PLAN §7). A `null`
 * checkpoint means "no cursor advance for this page" (used mid-full-backfill).
 */
export interface RawBatch<TRaw = unknown> {
  records: TRaw[];
  checkpoint: Cursor | null;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Raw request bytes — required for provider signature verification. */
  rawBody: Buffer;
}

export interface WebhookEvent {
  /** Provider event id, used for replay dedup (PLAN §6). */
  eventId: string;
  objectType: string;
  objectId: string;
  /** Optional raw object carried in the webhook, so we can skip a re-fetch. */
  inlineRaw?: unknown;
}

/**
 * The single contract every source implements (PLAN §5.1). The orchestrator owns the
 * control flow (read cursor -> incremental -> catch stale -> full -> normalize ->
 * upsert -> checkpoint -> ledger); connectors encode only source-specific mechanics.
 */
export interface SourceConnector<TRaw = unknown> {
  readonly source: SourceName;
  /** Key for this connector's row in sync_state (its cursor stream). */
  readonly stateKey: string;

  /** Whether the credentials needed to run are present (fault isolation, PLAN §8). */
  isConfigured(): boolean;

  fetchIncremental(cursor: Cursor | null): AsyncIterable<RawBatch<TRaw>>;
  fetchFull(): AsyncIterable<RawBatch<TRaw>>;

  /** Pure: raw -> 0..n canonical records. Throws on invalid input (-> quarantine). */
  normalize(raw: TRaw): NormalizedRecord[];

  parseWebhook(req: WebhookRequest): WebhookEvent[];

  isStaleCursorError(err: unknown): boolean;
}

/** DI token for the array of all registered connectors. */
export const CONNECTORS = Symbol('CONNECTORS');
