import { NormalizedRecord } from '../../common/normalized-record';
import {
  Cursor,
  RawBatch,
  SourceConnector,
  WebhookEvent,
  WebhookRequest,
} from '../connector.interface';
import { StaleCursorError } from '../stale-cursor.error';
import { HubSpotContactSearchApi, hubspotContactSchema } from './hubspot.types';

export interface HubSpotConnectorOptions {
  configured: boolean;
  webhookSecret?: string;
}

/**
 * HubSpot connector (PLAN §5.2).
 * - Incremental: CRM Search filtered on lastmodifieddate > cursor, ascending;
 *   cursor = the largest lastmodifieddate (epoch ms) seen. The Contacts object uses
 *   `lastmodifieddate`; `hs_lastmodifieddate` is null for contacts on many portals, so
 *   filtering on it would make incremental silently sync nothing.
 * - Full: the same search from time 0.
 * - Stale: timestamps don't expire; a lost/corrupt cursor simply restarts a full sync.
 */
export class HubSpotConnector implements SourceConnector<unknown> {
  readonly source = 'hubspot' as const;
  readonly stateKey = 'contacts';

  constructor(
    private readonly api: HubSpotContactSearchApi,
    private readonly opts: HubSpotConnectorOptions,
  ) {}

  isConfigured(): boolean {
    return this.opts.configured;
  }

  fetchIncremental(cursor: Cursor | null): AsyncIterable<RawBatch<unknown>> {
    return this.fetchSince(cursor ? Number(cursor.value) || 0 : 0);
  }

  fetchFull(): AsyncIterable<RawBatch<unknown>> {
    return this.fetchSince(0);
  }

  private async *fetchSince(sinceMs: number): AsyncIterable<RawBatch<unknown>> {
    let after: string | undefined;
    let maxTs = sinceMs;
    do {
      const res = await this.api.searchContacts({ sinceMs, after, limit: 100 });
      const results = res.results ?? [];
      const timestamps = results
        .map((r) => this.lastModifiedMs(r))
        .filter((n) => Number.isFinite(n)) as number[];
      if (timestamps.length) maxTs = Math.max(maxTs, ...timestamps);
      yield {
        records: results,
        checkpoint: { type: 'lastmodified', value: String(maxTs) },
      };
      after = res.after;
    } while (after);
  }

  normalize(raw: unknown): NormalizedRecord[] {
    const c = hubspotContactSchema.parse(raw);
    const p = c.properties;
    const updatedAt = this.toDate(p.lastmodifieddate ?? p.hs_lastmodifieddate) ?? new Date();
    const name = [p.firstname, p.lastname].filter(Boolean).join(' ') || null;
    const archived = c.archived === true;
    return [
      {
        source: 'hubspot',
        sourceObjectType: 'contact',
        sourceId: c.id,
        canonicalType: 'party',
        email: p.email ?? null,
        name,
        status: p.lifecyclestage ?? null,
        externalCreatedAt: this.toDate(p.createdate),
        externalUpdatedAt: updatedAt,
        attributes: { phone: p.phone ?? null, company: p.company ?? null },
        raw,
        deletedAt: archived ? updatedAt : null,
      },
    ];
  }

  parseWebhook(req: WebhookRequest): WebhookEvent[] {
    // Signature verification is wired in M7; here we map the event envelope.
    const body = JSON.parse(req.rawBody.toString() || '[]') as Array<{
      eventId?: number | string;
      objectId?: number | string;
      subscriptionType?: string;
    }>;
    return body.map((ev) => ({
      eventId: String(ev.eventId ?? `${ev.subscriptionType}:${ev.objectId}`),
      objectType: 'contact',
      objectId: String(ev.objectId ?? ''),
    }));
  }

  isStaleCursorError(err: unknown): boolean {
    return err instanceof StaleCursorError;
  }

  private lastModifiedMs(raw: unknown): number {
    const props = (raw as { properties?: Record<string, string> })?.properties ?? {};
    // Prefer `lastmodifieddate` (the contact-canonical property the search filters/sorts
    // on); fall back to `hs_lastmodifieddate` only if it's absent. The two MUST agree with
    // the search property so the stored cursor lines up with the GT filter.
    const value = props.lastmodifieddate ?? props.hs_lastmodifieddate;
    const d = this.toDate(value);
    return d ? d.getTime() : NaN;
  }

  private toDate(value?: string | null): Date | null {
    if (!value) return null;
    // HubSpot sends either an ISO string or an epoch-ms numeric string.
    const asNum = Number(value);
    const d =
      Number.isFinite(asNum) && /^\d+$/.test(value.trim()) ? new Date(asNum) : new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
}
