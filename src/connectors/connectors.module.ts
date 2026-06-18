import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { google } from 'googleapis';
import { Client as HubSpotClient } from '@hubspot/api-client';
import { CONNECTORS, SourceConnector } from './connector.interface';
import { StripeConnector } from './stripe/stripe.connector';
import { GoogleCalendarConnector } from './google/google.connector';
import { CalendarClient } from './google/google.types';
import { HubSpotConnector } from './hubspot/hubspot.connector';
import { HubSpotContactSearchApi } from './hubspot/hubspot.types';

const CONTACT_PROPERTIES = [
  'email',
  'firstname',
  'lastname',
  'lifecyclestage',
  'createdate',
  'lastmodifieddate',
  'hs_lastmodifieddate',
  'phone',
  'company',
];

/**
 * Registers all source connectors. Each is constructed with credentials from config;
 * a connector without credentials reports isConfigured() === false and is skipped at
 * runtime (fault isolation, PLAN §8). SDKs are adapted to the connectors' testable interfaces.
 */
@Module({
  providers: [
    {
      provide: StripeConnector,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const apiKey = config.get<string>('STRIPE_API_KEY');
        const webhookSecret = config.get<string>('STRIPE_WEBHOOK_SECRET');
        const stripe = new Stripe(apiKey ?? 'sk_test_placeholder');
        return new StripeConnector(stripe, { apiKey, webhookSecret });
      },
    },
    {
      provide: GoogleCalendarConnector,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const clientId = config.get<string>('GOOGLE_CLIENT_ID');
        const clientSecret = config.get<string>('GOOGLE_CLIENT_SECRET');
        const refreshToken = config.get<string>('GOOGLE_REFRESH_TOKEN');
        const calendarId = config.get<string>('GOOGLE_CALENDAR_ID') ?? 'primary';
        const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
        if (refreshToken) oauth2.setCredentials({ refresh_token: refreshToken });
        const calendar = google.calendar({ version: 'v3', auth: oauth2 });
        return new GoogleCalendarConnector(calendar as unknown as CalendarClient, {
          calendarId,
          configured: Boolean(clientId && clientSecret && refreshToken),
        });
      },
    },
    {
      provide: HubSpotConnector,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const token = config.get<string>('HUBSPOT_PRIVATE_APP_TOKEN');
        const webhookSecret = config.get<string>('HUBSPOT_WEBHOOK_SECRET');
        const client = new HubSpotClient({ accessToken: token ?? 'na' });
        const api: HubSpotContactSearchApi = {
          async searchContacts({ sinceMs, after, limit }) {
            // NOTE: the Contacts object's canonical modified-time property is
            // `lastmodifieddate`. `hs_lastmodifieddate` is for companies/deals/tickets
            // and is returned `null` for contacts on many portals — filtering/sorting on
            // it makes incremental silently return nothing (full backfill still works
            // because it sends no filter). See hubspot.connector.lastModifiedMs.
            const req: Record<string, unknown> = {
              filterGroups:
                sinceMs > 0
                  ? [
                      {
                        filters: [
                          {
                            propertyName: 'lastmodifieddate',
                            operator: 'GT',
                            value: String(sinceMs),
                          },
                        ],
                      },
                    ]
                  : [],
              sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
              properties: CONTACT_PROPERTIES,
              limit,
              after,
            };

            const res: any = await (client.crm.contacts.searchApi as any).doSearch(req);
            return { results: res.results ?? [], after: res.paging?.next?.after };
          },
        };
        return new HubSpotConnector(api, { configured: Boolean(token), webhookSecret });
      },
    },
    {
      provide: CONNECTORS,
      inject: [StripeConnector, GoogleCalendarConnector, HubSpotConnector],
      useFactory: (
        stripe: StripeConnector,
        google: GoogleCalendarConnector,
        hubspot: HubSpotConnector,
      ): SourceConnector[] => [stripe, google, hubspot],
    },
  ],
  exports: [CONNECTORS, StripeConnector, GoogleCalendarConnector, HubSpotConnector],
})
export class ConnectorsModule {}
