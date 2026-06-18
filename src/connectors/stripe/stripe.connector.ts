import type Stripe from 'stripe';
import { NormalizedRecord } from '../../common/normalized-record';
import {
  Cursor,
  RawBatch,
  SourceConnector,
  WebhookEvent,
  WebhookRequest,
} from '../connector.interface';
import { StaleCursorError } from '../stale-cursor.error';
import {
  STRIPE_EVENT_TYPES,
  StripeRaw,
  stripeChargeSchema,
  stripeCustomerSchema,
} from './stripe.types';

export interface StripeConnectorOptions {
  apiKey?: string;
  webhookSecret?: string;
}

/**
 * Stripe connector (PLAN §5.2).
 * - Incremental: the Events API (`/v1/events`), cursor = last processed event id.
 * - Full: paginate customers + charges by `created`, then resume from the newest event.
 * - Stale: events are retained ~30 days; a purged cursor id (resource_missing/404)
 *   triggers a full backfill.
 */
export class StripeConnector implements SourceConnector<StripeRaw> {
  readonly source = 'stripe' as const;
  readonly stateKey = 'events';

  constructor(
    private readonly stripe: Stripe,
    private readonly opts: StripeConnectorOptions,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.opts.apiKey);
  }

  async *fetchIncremental(cursor: Cursor | null): AsyncIterable<RawBatch<StripeRaw>> {
    const sinceId = cursor?.value ?? null;

    // Validate the cursor still exists; a purged event => stale => backfill.
    if (sinceId) {
      try {
        await this.stripe.events.retrieve(sinceId);
      } catch (err) {
        if (this.isResourceMissing(err)) {
          throw new StaleCursorError(`stripe event cursor ${sinceId} no longer exists`, err);
        }
        throw err;
      }
    }

    // Events list is newest-first; walk pages until we reach the cursor, collecting newer ones.
    const collected: Stripe.Event[] = [];
    let newestId: string | null = null;
    let startingAfter: string | undefined;
    let done = false;
    do {
      const page = await this.stripe.events.list({
        limit: 100,
        starting_after: startingAfter,
        types: [...STRIPE_EVENT_TYPES],
      });
      for (const ev of page.data) {
        if (!newestId) newestId = ev.id;
        if (sinceId && ev.id === sinceId) {
          done = true;
          break;
        }
        collected.push(ev);
      }
      startingAfter = !done && page.has_more ? page.data[page.data.length - 1]?.id : undefined;
    } while (startingAfter);

    collected.reverse(); // apply oldest-first
    const raws = collected
      .map((ev) => this.eventToRaw(ev))
      .filter((r): r is StripeRaw => r !== null);

    yield {
      records: raws,
      checkpoint: newestId ? { type: 'event_id', value: newestId } : (cursor ?? null),
    };
  }

  async *fetchFull(): AsyncIterable<RawBatch<StripeRaw>> {
    let after: string | undefined;
    do {
      const page = await this.stripe.customers.list({ limit: 100, starting_after: after });
      yield {
        records: page.data.map((c) => ({
          objectType: 'customer',
          object: c,
          updatedAt: c.created,
        })),
        checkpoint: null,
      };
      after = page.has_more ? page.data[page.data.length - 1]?.id : undefined;
    } while (after);

    after = undefined;
    do {
      const page = await this.stripe.charges.list({ limit: 100, starting_after: after });
      yield {
        records: page.data.map((ch) => ({
          objectType: 'charge',
          object: ch,
          updatedAt: ch.created,
        })),
        checkpoint: null,
      };
      after = page.has_more ? page.data[page.data.length - 1]?.id : undefined;
    } while (after);

    // Seed the incremental cursor from the newest event of our tracked types.
    const latest = await this.stripe.events.list({ limit: 1, types: [...STRIPE_EVENT_TYPES] });
    yield {
      records: [],
      checkpoint: latest.data[0] ? { type: 'event_id', value: latest.data[0].id } : null,
    };
  }

  normalize(raw: StripeRaw): NormalizedRecord[] {
    if (raw.objectType === 'customer') {
      const c = stripeCustomerSchema.parse(raw.object);
      return [
        {
          source: 'stripe',
          sourceObjectType: 'customer',
          sourceId: c.id,
          canonicalType: 'party',
          email: c.email ?? null,
          name: c.name ?? null,
          externalCreatedAt: new Date(c.created * 1000),
          externalUpdatedAt: new Date(raw.updatedAt * 1000),
          attributes: { phone: c.phone ?? null, metadata: c.metadata ?? {} },
          raw: raw.object,
          deletedAt: raw.deleted ? new Date(raw.updatedAt * 1000) : null,
        },
      ];
    }

    const ch = stripeChargeSchema.parse(raw.object);
    return [
      {
        source: 'stripe',
        sourceObjectType: 'charge',
        sourceId: ch.id,
        canonicalType: 'transaction',
        title: ch.description ?? null,
        amount: (ch.amount / 100).toFixed(2),
        currency: ch.currency,
        status: ch.status,
        description: ch.description ?? null,
        url: ch.receipt_url ?? null,
        externalCreatedAt: new Date(ch.created * 1000),
        externalUpdatedAt: new Date(raw.updatedAt * 1000),
        attributes: {
          payment_method: ch.payment_method ?? null,
          customer: ch.customer ?? null,
          metadata: ch.metadata ?? {},
        },
        raw: raw.object,
      },
    ];
  }

  parseWebhook(req: WebhookRequest): WebhookEvent[] {
    if (!this.opts.webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET not configured');
    }
    const sig = req.headers['stripe-signature'];
    const event = this.stripe.webhooks.constructEvent(
      req.rawBody,
      Array.isArray(sig) ? sig[0] : (sig ?? ''),
      this.opts.webhookSecret,
    );
    const obj = event.data.object as { object?: string; id?: string };
    return [
      {
        eventId: event.id,
        objectType: obj?.object ?? 'unknown',
        objectId: obj?.id ?? '',
        inlineRaw: this.eventToRaw(event) ?? undefined,
      },
    ];
  }

  isStaleCursorError(err: unknown): boolean {
    if (err instanceof StaleCursorError) return true;
    return this.isResourceMissing(err);
  }

  private isResourceMissing(err: unknown): boolean {
    const e = err as { type?: string; code?: string; statusCode?: number };
    return (
      e?.type === 'StripeInvalidRequestError' &&
      (e?.code === 'resource_missing' || e?.statusCode === 404)
    );
  }

  private eventToRaw(ev: Stripe.Event): StripeRaw | null {
    const obj = ev.data.object as { object?: string };
    const objectType = obj?.object;
    if (objectType !== 'customer' && objectType !== 'charge') return null;
    return {
      objectType,
      object: obj,
      updatedAt: ev.created,
      deleted: ev.type === 'customer.deleted',
    };
  }
}
