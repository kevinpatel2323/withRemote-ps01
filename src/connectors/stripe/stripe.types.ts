import { z } from 'zod';

/** Event types we ingest from Stripe's change log. */
export const STRIPE_EVENT_TYPES = [
  'customer.created',
  'customer.updated',
  'customer.deleted',
  'charge.succeeded',
  'charge.updated',
  'charge.refunded',
  'charge.captured',
  'charge.failed',
] as const;

export const stripeCustomerSchema = z.object({
  id: z.string(),
  object: z.literal('customer'),
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  created: z.number(),
  metadata: z.record(z.unknown()).optional(),
});

export const stripeChargeSchema = z.object({
  id: z.string(),
  object: z.literal('charge'),
  amount: z.number(),
  currency: z.string(),
  status: z.string(),
  description: z.string().nullable().optional(),
  receipt_url: z.string().nullable().optional(),
  created: z.number(),
  payment_method: z.string().nullable().optional(),
  customer: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/** Wrapper handed to `normalize`: the raw object + the effective updated-at + delete flag. */
export interface StripeRaw {
  objectType: 'customer' | 'charge';
  object: unknown;
  /** Epoch seconds: event.created (incremental) or object.created (full). */
  updatedAt: number;
  deleted?: boolean;
}
