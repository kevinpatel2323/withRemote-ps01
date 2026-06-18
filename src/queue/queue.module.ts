import { Global, Module } from '@nestjs/common';
import { PgBossService } from './pgboss.service';

@Global()
@Module({
  providers: [PgBossService],
  exports: [PgBossService],
})
export class QueueModule {}
