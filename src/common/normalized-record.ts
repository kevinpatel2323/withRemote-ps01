import { sha256Hex, stableStringify } from './content-hash';
import type { NewRecordRow } from '../db/schema';

export type SourceName = 'hubspot' | 'stripe' | 'google_calendar';
export type CanonicalType = 'party' | 'transaction' | 'event';

/**
 * The canonical record every connector's `normalize()` produces (PLAN §4/§5).
 * Common fields are typed; the long tail lives in `attributes` (normalized) and
 * `raw` (verbatim source payload). `externalUpdatedAt` drives the out-of-order guard.
 */
export interface NormalizedRecord {
  source: SourceName;
  sourceObjectType: string;
  sourceId: string;
  canonicalType: CanonicalType;
  externalCreatedAt?: Date | null;
  externalUpdatedAt: Date;
  title?: string | null;
  name?: string | null;
  email?: string | null;
  amount?: string | null;
  currency?: string | null;
  status?: string | null;
  startAt?: Date | null;
  endAt?: Date | null;
  description?: string | null;
  url?: string | null;
  attributes?: Record<string, unknown>;
  raw: unknown;
  deletedAt?: Date | null;
}

/**
 * Hash of the materially-stored content. Includes `externalUpdatedAt` so a newer
 * version always differs (=> applied), while an identical re-delivery matches (=> deduped).
 */
export function computeContentHash(r: NormalizedRecord): string {
  return sha256Hex(
    stableStringify({
      canonicalType: r.canonicalType,
      externalUpdatedAt: r.externalUpdatedAt?.toISOString() ?? null,
      title: r.title ?? null,
      name: r.name ?? null,
      email: r.email ?? null,
      amount: r.amount ?? null,
      currency: r.currency ?? null,
      status: r.status ?? null,
      startAt: r.startAt?.toISOString() ?? null,
      endAt: r.endAt?.toISOString() ?? null,
      description: r.description ?? null,
      url: r.url ?? null,
      attributes: r.attributes ?? {},
      deletedAt: r.deletedAt?.toISOString() ?? null,
    }),
  );
}

export function toRecordRow(r: NormalizedRecord): NewRecordRow {
  return {
    source: r.source,
    sourceObjectType: r.sourceObjectType,
    sourceId: r.sourceId,
    canonicalType: r.canonicalType,
    externalCreatedAt: r.externalCreatedAt ?? null,
    externalUpdatedAt: r.externalUpdatedAt,
    title: r.title ?? null,
    name: r.name ?? null,
    email: r.email ?? null,
    amount: r.amount ?? null,
    currency: r.currency ?? null,
    status: r.status ?? null,
    startAt: r.startAt ?? null,
    endAt: r.endAt ?? null,
    description: r.description ?? null,
    url: r.url ?? null,
    attributes: r.attributes ?? {},
    raw: r.raw,
    contentHash: computeContentHash(r),
    deletedAt: r.deletedAt ?? null,
  };
}
