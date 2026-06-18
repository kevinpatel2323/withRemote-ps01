import { NormalizedRecord } from '../../common/normalized-record';
import {
  Cursor,
  RawBatch,
  SourceConnector,
  WebhookEvent,
  WebhookRequest,
} from '../connector.interface';
import { StaleCursorError } from '../stale-cursor.error';
import { CalendarClient, googleEventSchema } from './google.types';

export interface GoogleConnectorOptions {
  calendarId: string;
  configured: boolean;
}

/**
 * Google Calendar connector (PLAN §5.2).
 * - Incremental: events.list with a syncToken; cursor = the returned nextSyncToken.
 * - Full: events.list paginated (no syncToken), capturing the final nextSyncToken.
 * - Stale: an expired sync token returns HTTP 410 GONE -> full backfill.
 */
export class GoogleCalendarConnector implements SourceConnector<unknown> {
  readonly source = 'google_calendar' as const;
  readonly stateKey = 'events';

  constructor(
    private readonly calendar: CalendarClient,
    private readonly opts: GoogleConnectorOptions,
  ) {}

  isConfigured(): boolean {
    return this.opts.configured;
  }

  async *fetchIncremental(cursor: Cursor | null): AsyncIterable<RawBatch<unknown>> {
    const syncToken = cursor?.value;
    const items: unknown[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null | undefined;

    do {
      let res;
      try {
        res = await this.calendar.events.list({
          calendarId: this.opts.calendarId,
          syncToken,
          pageToken,
          showDeleted: true,
          maxResults: 250,
        });
      } catch (err) {
        if (this.isGone(err)) {
          throw new StaleCursorError('google calendar sync token expired (410)', err);
        }
        throw err;
      }
      items.push(...(res.data.items ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
      nextSyncToken = res.data.nextSyncToken ?? nextSyncToken;
    } while (pageToken);

    yield {
      records: items,
      checkpoint: nextSyncToken ? { type: 'sync_token', value: nextSyncToken } : (cursor ?? null),
    };
  }

  async *fetchFull(): AsyncIterable<RawBatch<unknown>> {
    let pageToken: string | undefined;
    let nextSyncToken: string | null | undefined;
    do {
      const res = await this.calendar.events.list({
        calendarId: this.opts.calendarId,
        pageToken,
        showDeleted: true,
        maxResults: 250,
      });
      yield { records: res.data.items ?? [], checkpoint: null };
      pageToken = res.data.nextPageToken ?? undefined;
      nextSyncToken = res.data.nextSyncToken ?? nextSyncToken;
    } while (pageToken);

    yield {
      records: [],
      checkpoint: nextSyncToken ? { type: 'sync_token', value: nextSyncToken } : null,
    };
  }

  normalize(raw: unknown): NormalizedRecord[] {
    const e = googleEventSchema.parse(raw);
    const updatedAt = e.updated
      ? new Date(e.updated)
      : e.created
        ? new Date(e.created)
        : new Date();
    const cancelled = e.status === 'cancelled';
    return [
      {
        source: 'google_calendar',
        sourceObjectType: 'event',
        sourceId: e.id,
        canonicalType: 'event',
        title: e.summary ?? null,
        description: e.description ?? null,
        url: e.htmlLink ?? null,
        status: e.status ?? null,
        startAt: this.timeOf(e.start),
        endAt: this.timeOf(e.end),
        externalCreatedAt: e.created ? new Date(e.created) : null,
        externalUpdatedAt: updatedAt,
        attributes: {
          location: e.location ?? null,
          attendees: e.attendees ?? [],
          recurrence: e.recurrence ?? null,
          hangoutLink: e.hangoutLink ?? null,
          organizer: e.organizer ?? null,
        },
        raw,
        deletedAt: cancelled ? updatedAt : null,
      },
    ];
  }

  parseWebhook(req: WebhookRequest): WebhookEvent[] {
    // Google push notifications carry no body — only headers. They signal "something
    // changed"; the orchestrator responds with an incremental sync (M7).
    const channelId = this.header(req, 'x-goog-channel-id');
    const messageNumber = this.header(req, 'x-goog-message-number');
    const resourceState = this.header(req, 'x-goog-resource-state');
    if (resourceState === 'sync') return []; // initial handshake, no data
    return [
      {
        eventId: `${channelId}:${messageNumber}`,
        objectType: 'event',
        objectId: '',
      },
    ];
  }

  isStaleCursorError(err: unknown): boolean {
    if (err instanceof StaleCursorError) return true;
    return this.isGone(err);
  }

  private isGone(err: unknown): boolean {
    const e = err as { code?: number | string; status?: number; response?: { status?: number } };
    return e?.code === 410 || e?.status === 410 || e?.response?.status === 410;
  }

  private timeOf(point?: { dateTime?: string; date?: string } | null): Date | null {
    if (!point) return null;
    const value = point.dateTime ?? point.date;
    return value ? new Date(value) : null;
  }

  private header(req: WebhookRequest, name: string): string {
    const v = req.headers[name];
    return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
  }
}
