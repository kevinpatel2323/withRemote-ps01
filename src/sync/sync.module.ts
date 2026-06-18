import { Module } from '@nestjs/common';
import { RecordsModule } from '../records/records.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { SyncStateRepository } from './sync-state.repository';
import { SyncRunRepository } from './sync-run.repository';
import { SyncRunner } from './sync-runner';

@Module({
  imports: [RecordsModule, ConnectorsModule],
  providers: [SyncStateRepository, SyncRunRepository, SyncRunner],
  exports: [SyncRunner, SyncStateRepository, SyncRunRepository, ConnectorsModule],
})
export class SyncModule {}
