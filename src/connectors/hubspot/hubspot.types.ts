import { z } from 'zod';

export const hubspotContactSchema = z.object({
  id: z.string(),
  properties: z
    .object({
      email: z.string().nullable().optional(),
      firstname: z.string().nullable().optional(),
      lastname: z.string().nullable().optional(),
      lifecyclestage: z.string().nullable().optional(),
      createdate: z.string().nullable().optional(),
      lastmodifieddate: z.string().nullable().optional(),
      hs_lastmodifieddate: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      company: z.string().nullable().optional(),
    })
    .passthrough(),
  archived: z.boolean().optional(),
});

export type HubSpotContact = z.infer<typeof hubspotContactSchema>;

/**
 * SDK-agnostic search surface the connector depends on. The module adapts
 * @hubspot/api-client to this; tests provide a fake. `sinceMs === 0` means "everything".
 */
export interface HubSpotContactSearchApi {
  searchContacts(params: { sinceMs: number; after?: string; limit: number }): Promise<{
    results: unknown[];
    after?: string;
  }>;
}
