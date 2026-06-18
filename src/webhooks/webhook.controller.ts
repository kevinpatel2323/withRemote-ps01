import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  Req,
  RawBodyRequest,
} from '@nestjs/common';
import { Request } from 'express';
import { SourceName } from '../common/normalized-record';
import { WebhookRequest } from '../connectors/connector.interface';
import { WebhookService } from './webhook.service';

@Controller('webhooks')
export class WebhookController {
  constructor(private readonly service: WebhookService) {}

  @Post('stripe')
  @HttpCode(200)
  stripe(@Req() req: RawBodyRequest<Request>) {
    return this.dispatch('stripe', req);
  }

  @Post('google')
  @HttpCode(200)
  google(@Req() req: RawBodyRequest<Request>) {
    return this.dispatch('google_calendar', req);
  }

  @Post('hubspot')
  @HttpCode(200)
  hubspot(@Req() req: RawBodyRequest<Request>) {
    return this.dispatch('hubspot', req);
  }

  private async dispatch(source: SourceName, req: RawBodyRequest<Request>) {
    const webhookReq: WebhookRequest = {
      headers: req.headers,
      rawBody: req.rawBody ?? Buffer.from(''),
    };
    try {
      return await this.service.handle(source, webhookReq);
    } catch (err) {
      // Bad signature / malformed payload -> 400 (the provider will retry).
      throw new BadRequestException(err instanceof Error ? err.message : 'invalid webhook');
    }
  }
}
