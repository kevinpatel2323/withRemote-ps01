import { Module } from '@nestjs/common';
import { RecordsRepository } from './records.repository';

@Module({
  providers: [RecordsRepository],
  exports: [RecordsRepository],
})
export class RecordsModule {}
