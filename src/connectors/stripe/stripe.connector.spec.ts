import type Stripe from 'stripe';
import { StripeConnector } from './stripe.connector';
import { StaleCursorError } from '../stale-cursor.error';
import { RawBatch } from '../connector.interface';
import { StripeRaw } from './stripe.types';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const customerObj = {
  id: 'cus_1',
  object: 'customer',
  email: 'a@example.com',
  name: 'Alice',
  created: 100,
};
const chargeObj = {
  id: 'ch_1',
  object: 'charge',
  amount: 1234,
  currency: 'usd',
  status: 'succeeded',
  receipt_url: 'http://receipt',
  created: 120,
};

function resourceMissing(): Error {
  const e = new Error('No such event') as Error & { type: string; code: string };
  e.type = 'StripeInvalidRequestError';
  e.code = 'resource_missing';
  return e;
}

function makeConnector(stripe: Partial<Stripe>): StripeConnector {
  return new StripeConnector(stripe as Stripe, { apiKey: 'sk_test', webhookSecret: 'whsec' });
}

describe('StripeConnector.normalize', () => {
  const conn = makeConnector({});

  it('maps a customer to a party record', () => {
    const [rec] = conn.normalize({ objectType: 'customer', object: customerObj, updatedAt: 150 });
    expect(rec).toMatchObject({
      source: 'stripe',
      sourceObjectType: 'customer',
      sourceId: 'cus_1',
      canonicalType: 'party',
      email: 'a@example.com',
      name: 'Alice',
    });
    expect(rec.externalUpdatedAt.toISOString()).toBe(new Date(150_000).toISOString());
    expect(rec.deletedAt).toBeNull();
  });

  it('maps a charge to a transaction record with dollars and receipt url', () => {
    const [rec] = conn.normalize({ objectType: 'charge', object: chargeObj, updatedAt: 160 });
    expect(rec).toMatchObject({
      sourceObjectType: 'charge',
      canonicalType: 'transaction',
      amount: '12.34',
      currency: 'usd',
      status: 'succeeded',
      url: 'http://receipt',
    });
  });

  it('sets deletedAt for a deleted customer', () => {
    const [rec] = conn.normalize({
      objectType: 'customer',
      object: customerObj,
      updatedAt: 200,
      deleted: true,
    });
    expect(rec.deletedAt?.toISOString()).toBe(new Date(200_000).toISOString());
  });

  it('throws (=> quarantine) on a malformed payload', () => {
    expect(() =>
      conn.normalize({ objectType: 'customer', object: { object: 'customer' }, updatedAt: 1 }),
    ).toThrow();
  });
});

describe('StripeConnector.isStaleCursorError', () => {
  const conn = makeConnector({});
  it('classifies StaleCursorError and resource_missing as stale', () => {
    expect(conn.isStaleCursorError(new StaleCursorError('x'))).toBe(true);
    expect(conn.isStaleCursorError(resourceMissing())).toBe(true);
  });
  it('does not classify generic errors as stale', () => {
    expect(conn.isStaleCursorError(new Error('network'))).toBe(false);
  });
});

describe('StripeConnector.fetchFull', () => {
  it('yields customers, charges, and a final event cursor checkpoint', async () => {
    const conn = makeConnector({
      customers: { list: jest.fn().mockResolvedValue({ data: [customerObj], has_more: false }) },
      charges: { list: jest.fn().mockResolvedValue({ data: [chargeObj], has_more: false }) },
      events: {
        list: jest.fn().mockResolvedValue({ data: [{ id: 'ev_latest' }], has_more: false }),
      },
    } as unknown as Partial<Stripe>);

    const batches: RawBatch<StripeRaw>[] = await collect(conn.fetchFull());
    const raws = batches.flatMap((b) => b.records);
    expect(raws.map((r) => r.objectType)).toEqual(['customer', 'charge']);
    expect(batches[batches.length - 1].checkpoint).toEqual({
      type: 'event_id',
      value: 'ev_latest',
    });
  });
});

describe('StripeConnector.fetchIncremental', () => {
  it('collects events newer than the cursor and checkpoints the newest id', async () => {
    const events = [
      { id: 'ev_new2', type: 'customer.updated', created: 200, data: { object: customerObj } },
      { id: 'ev_new1', type: 'charge.succeeded', created: 150, data: { object: chargeObj } },
      { id: 'ev_old', type: 'customer.updated', created: 100, data: { object: customerObj } },
    ];
    const conn = makeConnector({
      events: {
        retrieve: jest.fn().mockResolvedValue({ id: 'ev_old' }),
        list: jest.fn().mockResolvedValue({ data: events, has_more: false }),
      },
    } as unknown as Partial<Stripe>);

    const batches = await collect(conn.fetchIncremental({ type: 'event_id', value: 'ev_old' }));
    const raws = batches.flatMap((b) => b.records);
    // Only events newer than ev_old, oldest-first.
    expect(raws).toHaveLength(2);
    expect(batches[0].checkpoint).toEqual({ type: 'event_id', value: 'ev_new2' });
  });

  it('throws StaleCursorError when the cursor event was purged', async () => {
    const conn = makeConnector({
      events: {
        retrieve: jest.fn().mockRejectedValue(resourceMissing()),
        list: jest.fn(),
      },
    } as unknown as Partial<Stripe>);

    await expect(
      collect(conn.fetchIncremental({ type: 'event_id', value: 'ev_gone' })),
    ).rejects.toBeInstanceOf(StaleCursorError);
  });
});
