import { z } from 'zod';

/**
 * Single source of truth for environment configuration. Validated at boot so the
 * app fails fast on misconfiguration rather than at first use of a missing secret.
 * Source credentials are optional here: a connector that lacks its credentials is
 * skipped at runtime (fault isolation, PLAN §8) rather than blocking the whole app.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Scheduling (M3)
  SYNC_CRON: z.string().default('*/15 * * * *'),
  SYNC_LOOKBACK_SECONDS: z.coerce.number().int().nonnegative().default(60),
  SYNC_SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Admin (M8)
  ADMIN_TOKEN: z.string().min(1).default('change-me'),

  // Stripe (M2 / M7)
  STRIPE_API_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // HubSpot (M6 / M7)
  HUBSPOT_PRIVATE_APP_TOKEN: z.string().optional(),
  HUBSPOT_WEBHOOK_SECRET: z.string().optional(),

  // Google Calendar (M5 / M7)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().default('primary'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
