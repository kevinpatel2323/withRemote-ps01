import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env.schema';
import { DbModule } from './db/db.module';
import { HealthModule } from './health/health.module';
import { SyncModule } from './sync/sync.module';
import { QueueModule } from './queue/queue.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';
import { WebhookModule } from './webhooks/webhook.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        autoLogging: process.env.NODE_ENV !== 'test',
        transport:
          process.env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
        redact: ['req.headers.authorization', 'req.headers["stripe-signature"]'],
      },
    }),
    DbModule,
    QueueModule,
    HealthModule,
    SyncModule,
    OrchestratorModule,
    WebhookModule,
    AdminModule,
  ],
})
export class AppModule {}
