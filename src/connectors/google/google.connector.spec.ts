import { GoogleCalendarConnector } from './google.connector';
import { CalendarClient } from './google.types';
import { StaleCursorError } from '../stale-cursor.error';
import { RawBatch } from '../connector.interface';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const confirmed = {
  id: 'evt1',
  status: 'confirmed',
  summary: 'Standup',
  description: 'daily',
  htmlLink: 'http://h',
  created: '2026-01-01T00:00:00Z',
  updated: '2026-01-02T00:00:00Z',
  start: { dateTime: '2026-01-03T10:00:00Z' },
  end: { dateTime: '2026-01-03T11:00:00Z' },
};

function make(cal: CalendarClient): GoogleCalendarConnector {
  return new GoogleCalendarConnector(cal, { calendarId: 'primary', configured: true });
}

describe('GoogleCalendarConnector.normalize', () => {
  const conn = make({ events: { list: jest.fn() } });

  it('maps a confirmed event to an event record', () => {
    const [rec] = conn.normalize(confirmed);
    expect(rec).toMatchObject({
      source: 'google_calendar',
      sourceObjectType: 'event',
      sourceId: 'evt1',
      canonicalType: 'event',
      title: 'Standup',
      url: 'http://h',
      status: 'confirmed',
    });
    expect(rec.startAt?.toISOString()).toBe(new Date('2026-01-03T10:00:00Z').toISOString());
    expect(rec.deletedAt).toBeNull();
  });

  it('sets deletedAt for a cancelled event', () => {
    const [rec] = conn.normalize({
      id: 'evt2',
      status: 'cancelled',
      updated: '2026-01-05T00:00:00Z',
    });
    expect(rec.deletedAt?.toISOString()).toBe(new Date('2026-01-05T00:00:00Z').toISOString());
  });

  it('throws (=> quarantine) when id is missing', () => {
    expect(() => conn.normalize({ status: 'confirmed' })).toThrow();
  });
});

describe('GoogleCalendarConnector incremental/full', () => {
  it('checkpoints the nextSyncToken on an incremental run', async () => {
    const list = jest
      .fn()
      .mockResolvedValue({ data: { items: [confirmed], nextSyncToken: 'tok2' } });
    const batches: RawBatch[] = await collect(
      make({ events: { list } }).fetchIncremental({ type: 'sync_token', value: 'tok1' }),
    );
    expect(batches[0].records).toHaveLength(1);
    expect(batches[0].checkpoint).toEqual({ type: 'sync_token', value: 'tok2' });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ syncToken: 'tok1', showDeleted: true }),
    );
  });

  it('throws StaleCursorError on a 410 GONE sync token', async () => {
    const list = jest.fn().mockRejectedValue({ code: 410 });
    const conn = make({ events: { list } });
    await expect(
      collect(conn.fetchIncremental({ type: 'sync_token', value: 'expired' })),
    ).rejects.toBeInstanceOf(StaleCursorError);
    expect(conn.isStaleCursorError({ code: 410 })).toBe(true);
    expect(conn.isStaleCursorError(new Error('x'))).toBe(false);
  });

  it('paginates a full sync and checkpoints the final nextSyncToken', async () => {
    const list = jest
      .fn()
      .mockResolvedValueOnce({ data: { items: [confirmed], nextPageToken: 'p2' } })
      .mockResolvedValueOnce({
        data: { items: [{ ...confirmed, id: 'evt9' }], nextSyncToken: 'tokF' },
      });
    const batches: RawBatch[] = await collect(make({ events: { list } }).fetchFull());
    const ids = batches.flatMap((b) => b.records).map((r: any) => r.id);
    expect(ids).toEqual(['evt1', 'evt9']);
    expect(batches[batches.length - 1].checkpoint).toEqual({ type: 'sync_token', value: 'tokF' });
  });
});
