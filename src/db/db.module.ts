import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export const DRIZZLE = Symbol('DRIZZLE');
export type Database = NodePgDatabase<typeof schema>;

/**
 * Owns the pg connection pool and the Drizzle client. Holds the pool so it can be
 * closed on shutdown (enableShutdownHooks in main.ts), avoiding leaked connections
 * which matters on Render free Postgres (small connection cap).
 */
@Injectable()
export class DrizzleConnection implements OnModuleDestroy {
  readonly pool: Pool;
  readonly db: Database;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      max: Number(process.env.DB_POOL_MAX ?? 8),
    });
    this.db = drizzle(this.pool, { schema });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    DrizzleConnection,
    {
      provide: DRIZZLE,
      useFactory: (conn: DrizzleConnection) => conn.db,
      inject: [DrizzleConnection],
    },
  ],
  exports: [DRIZZLE, DrizzleConnection],
})
export class DbModule {}
