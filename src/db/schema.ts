import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  jsonb,
  numeric,
  boolean,
  integer,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

/** The three heterogeneous sources we ingest from. */
export const sourceEnum = pgEnum('source', ['hubspot', 'stripe', 'google_calendar']);

/** Canonical entity type a normalized record represents (PLAN §4). */
export const canonicalTypeEnum = pgEnum('canonical_type', ['party', 'transaction', 'event']);

/** Sync mode tracked per source/object-type (PLAN §7). */
export const syncModeEnum = pgEnum('sync_mode', ['INCREMENTAL', 'BACKFILL', 'NEEDS_BACKFILL']);

export const runStatusEnum = pgEnum('run_status', ['running', 'success', 'failed', 'partial']);
export const runTriggerEnum = pgEnum('run_trigger', ['scheduled', 'webhook', 'manual']);

/**
 * The single normalized schema (PLAN §4). Every source object lands here, keyed by
 * the natural key (source, source_object_type, source_id). Common fields are typed
 * columns; everything else is preserved in `attributes` (normalized) and `raw` (verbatim).
 */
export const records = pgTable(
  'records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    source: sourceEnum('source').notNull(),
    sourceObjectType: text('source_object_type').notNull(),
    sourceId: text('source_id').notNull(),
    canonicalType: canonicalTypeEnum('canonical_type').notNull(),

    externalCreatedAt: timestamp('external_created_at', { withTimezone: true }),
    // Drives out-of-order resolution in the upsert guard (PLAN §6).
    externalUpdatedAt: timestamp('external_updated_at', { withTimezone: true }).notNull(),

    title: text('title'),
    name: text('name'),
    email: text('email'),
    amount: numeric('amount'),
    currency: text('currency'),
    status: text('status'),
    startAt: timestamp('start_at', { withTimezone: true }),
    endAt: timestamp('end_at', { withTimezone: true }),
    description: text('description'),
    url: text('url'),

    attributes: jsonb('attributes').notNull().default({}),
    raw: jsonb('raw').notNull(),
    contentHash: text('content_hash').notNull(),

    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    naturalKey: uniqueIndex('records_natural_key').on(t.source, t.sourceObjectType, t.sourceId),
    canonicalTypeIdx: index('records_canonical_type_idx').on(t.canonicalType),
    updatedAtIdx: index('records_external_updated_at_idx').on(t.externalUpdatedAt),
  }),
);

/** Per-source cursor + mode state (PLAN §7). One row per (source, object_type). */
export const syncState = pgTable(
  'sync_state',
  {
    source: sourceEnum('source').notNull(),
    objectType: text('object_type').notNull(),
    cursorType: text('cursor_type'),
    cursorValue: text('cursor_value'),
    mode: syncModeEnum('mode').notNull().default('NEEDS_BACKFILL'),
    lastFullSyncAt: timestamp('last_full_sync_at', { withTimezone: true }),
    lastIncrementalAt: timestamp('last_incremental_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.source, t.objectType] }),
  }),
);

/** Audit ledger proving "the pipeline doesn't lie" (PLAN §9). One row per run. */
export const syncRun = pgTable(
  'sync_run',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    source: sourceEnum('source').notNull(),
    objectType: text('object_type'),
    mode: syncModeEnum('mode').notNull(),
    trigger: runTriggerEnum('trigger').notNull(),
    status: runStatusEnum('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    cursorBefore: text('cursor_before'),
    cursorAfter: text('cursor_after'),
    backfillTriggered: boolean('backfill_triggered').notNull().default(false),
    recordsSeen: integer('records_seen').notNull().default(0),
    recordsInserted: integer('records_inserted').notNull().default(0),
    recordsUpdated: integer('records_updated').notNull().default(0),
    recordsDeduped: integer('records_deduped').notNull().default(0),
    recordsQuarantined: integer('records_quarantined').notNull().default(0),
    recordsDeleted: integer('records_deleted').notNull().default(0),
    pagesFetched: integer('pages_fetched').notNull().default(0),
    error: text('error'),
  },
  (t) => ({
    sourceIdx: index('sync_run_source_idx').on(t.source, t.startedAt),
  }),
);

/** Webhook dedup ledger (PLAN §6). Keyed by provider event id. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    source: sourceEnum('source').notNull(),
    eventId: text('event_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    payload: jsonb('payload'),
  },
  (t) => ({
    uniq: uniqueIndex('webhook_events_source_event_idx').on(t.source, t.eventId),
  }),
);

/** Records that failed validation/normalization (PLAN §8 "returns garbage"). */
export const quarantine = pgTable('quarantine', {
  id: uuid('id').defaultRandom().primaryKey(),
  source: sourceEnum('source').notNull(),
  sourceObjectType: text('source_object_type'),
  sourceId: text('source_id'),
  raw: jsonb('raw'),
  error: text('error').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RecordRow = typeof records.$inferSelect;
export type NewRecordRow = typeof records.$inferInsert;
export type SyncStateRow = typeof syncState.$inferSelect;
export type SyncRunRow = typeof syncRun.$inferSelect;
