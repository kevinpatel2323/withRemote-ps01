import { HubSpotConnector } from './hubspot.connector';
import { HubSpotContactSearchApi } from './hubspot.types';
import { RawBatch } from '../connector.interface';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const contact = {
  id: '1',
  properties: {
    email: 'a@example.com',
    firstname: 'Al',
    lastname: 'Ice',
    lifecyclestage: 'lead',
    createdate: '2026-01-01T00:00:00Z',
    lastmodifieddate: '2026-01-02T00:00:00Z',
    hs_lastmodifieddate: '1735776000000',
    phone: '123',
    company: 'Acme',
  },
};

function make(api: HubSpotContactSearchApi): HubSpotConnector {
  return new HubSpotConnector(api, { configured: true });
}

describe('HubSpotConnector.normalize', () => {
  const conn = make({ searchContacts: jest.fn() });

  it('maps a contact to a party record with a joined name', () => {
    const [rec] = conn.normalize(contact);
    expect(rec).toMatchObject({
      source: 'hubspot',
      sourceObjectType: 'contact',
      sourceId: '1',
      canonicalType: 'party',
      email: 'a@example.com',
      name: 'Al Ice',
      status: 'lead',
    });
    expect(rec.externalUpdatedAt.toISOString()).toBe(
      new Date('2026-01-02T00:00:00Z').toISOString(),
    );
    expect(rec.deletedAt).toBeNull();
  });

  it('sets deletedAt for an archived contact', () => {
    const [rec] = conn.normalize({
      id: '2',
      properties: { hs_lastmodifieddate: '1735776000000' },
      archived: true,
    });
    expect(rec.deletedAt).not.toBeNull();
  });

  it('throws (=> quarantine) when id is missing', () => {
    expect(() => conn.normalize({ properties: {} })).toThrow();
  });
});

describe('HubSpotConnector incremental', () => {
  it('paginates and checkpoints the max lastmodifieddate', async () => {
    const searchContacts = jest
      .fn()
      .mockResolvedValueOnce({ results: [contact], after: 'a1' })
      .mockResolvedValueOnce({
        results: [
          {
            ...contact,
            id: '2',
            // Contacts carry the real timestamp in `lastmodifieddate`; `hs_lastmodifieddate`
            // is null on this portal and must not drive the cursor.
            properties: {
              ...contact.properties,
              lastmodifieddate: '2026-01-03T00:00:00Z',
              hs_lastmodifieddate: null,
            },
          },
        ],
        after: undefined,
      });
    const conn = make({ searchContacts });

    const batches: RawBatch[] = await collect(
      conn.fetchIncremental({ type: 'lastmodified', value: '1735000000000' }),
    );
    expect(batches).toHaveLength(2);
    const ids = batches.flatMap((b) => b.records).map((r: any) => r.id);
    expect(ids).toEqual(['1', '2']);
    // Final checkpoint is the largest lastmodifieddate seen (2026-01-03 > 2026-01-02).
    expect(batches[batches.length - 1].checkpoint).toEqual({
      type: 'lastmodified',
      value: String(Date.parse('2026-01-03T00:00:00Z')),
    });
    expect(searchContacts).toHaveBeenLastCalledWith(
      expect.objectContaining({ sinceMs: 1735000000000, after: 'a1' }),
    );
  });

  it('full sync queries from time 0', async () => {
    const searchContacts = jest.fn().mockResolvedValue({ results: [], after: undefined });
    await collect(make({ searchContacts }).fetchFull());
    expect(searchContacts).toHaveBeenCalledWith(expect.objectContaining({ sinceMs: 0 }));
  });
});
