import { Module } from '@nestjs/common';
import { RecordsModule } from '../records/records.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { WebhookEventsRepository } from './webhook-events.repository';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';

@Module({
  imports: [RecordsModule, ConnectorsModule, OrchestratorModule],
  controllers: [WebhookController],
  providers: [WebhookEventsRepository, WebhookService],
})
export class WebhookModule {}
