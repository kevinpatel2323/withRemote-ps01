import { validateEnv } from './env.schema';

describe('validateEnv', () => {
  it('accepts a minimal valid environment and coerces types', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://sync:sync@localhost:5432/syncdb',
      PORT: '4000',
    });
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.SYNC_SCHEDULER_ENABLED).toBe(true);
    expect(env.GOOGLE_CALENDAR_ID).toBe('primary');
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => validateEnv({ DATABASE_URL: 'postgres://x', LOG_LEVEL: 'loud' })).toThrow(
      /LOG_LEVEL/,
    );
  });

  it('parses SYNC_SCHEDULER_ENABLED=false to a boolean', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://x',
      SYNC_SCHEDULER_ENABLED: 'false',
    });
    expect(env.SYNC_SCHEDULER_ENABLED).toBe(false);
  });
});
