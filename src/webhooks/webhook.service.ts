import { Inject, Injectable, Logger } from '@nestjs/common';
import { SourceName } from '../common/normalized-record';
import { CONNECTORS, SourceConnector, WebhookRequest } from '../connectors/connector.interface';
import { RecordsRepository } from '../records/records.repository';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { WebhookEventsRepository } from './webhook-events.repository';

export interface WebhookResult {
  received: number;
  deduped: number;
  processed: number;
}

/**
 * Handles an inbound webhook (PLAN §6). Verifies + parses via the source connector,
 * dedupes each event against the ledger, then either applies an inline payload (Stripe)
 * or enqueues an incremental sync (Google/HubSpot). Replays are idempotent twice over:
 * the ledger blocks duplicate deliveries, and the records upsert blocks duplicate rows.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @Inject(CONNECTORS) private readonly connectors: SourceConnector[],
    private readonly records: RecordsRepository,
    private readonly ledger: WebhookEventsRepository,
    private readonly orchestrator: OrchestratorService,
  ) {}

  async handle(source: SourceName, req: WebhookRequest): Promise<WebhookResult> {
    const connector = this.connectors.find((c) => c.source === source);
    if (!connector) throw new Error(`No connector for source "${source}"`);

    // Throws on bad signature -> controller maps to 400.
    const events = connector.parseWebhook(req);
    const result: WebhookResult = { received: events.length, deduped: 0, processed: 0 };

    for (const event of events) {
      const isNew = await this.ledger.recordIfNew(source, event.eventId, event);
      if (!isNew) {
        result.deduped += 1;
        continue;
      }

      if (event.inlineRaw !== undefined) {
        // Apply the payload carried in the webhook directly (idempotent upsert).
        try {
          const normalized = connector.normalize(event.inlineRaw);
          await this.records.upsertMany(normalized);
        } catch (err) {
          await this.records.quarantine({
            source,
            sourceId: event.objectId,
            raw: event.inlineRaw,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        // No inline data -> enqueue an incremental sync for this source.
        await this.orchestrator.dispatchSource(source, 'webhook');
      }

      await this.ledger.markProcessed(source, event.eventId);
      result.processed += 1;
    }

    this.logger.log(
      `${source} webhook: received=${result.received} processed=${result.processed} deduped=${result.deduped}`,
    );
    return result;
  }
}
